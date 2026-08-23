/**
 * Polymarket copy-trader (test version)
 *
 * - Polls the activity API every POLL_INTERVAL_MS for the target user's trades
 * - Filters to BUY trades only
 * - Dedupes by transactionHash + asset (persisted to seen-trades.json)
 * - Mirrors each new trade as a FAK market BUY order via the CLOB client
 * - Every copied bet spends a fixed MAX_BET_USDC (env, default $1), regardless of their trade size
 * - DRY_RUN=1 logs orders instead of placing them
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Wallets to copy live in target-wallets.js — edit that file to add/remove users
const TARGET_WALLETS = require("./target-wallets.js");
const { createResolutionCache } = require("./market-resolution.js");

const {
  DATA_API_HOST = "https://data-api.polymarket.com",
  CLOB_API_HOST = "https://clob.polymarket.com",
  TARGET_USERS, // optional env override (comma-separated addresses), mainly for tests
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  SIGNATURE_TYPE = "1",
  POLL_INTERVAL_MS = "5000",
  MAX_BET_USDC = "1",
  MIRROR_TRADER_BET = "0", // 1 = bet what the trader bet (capped by MAX_BET_USDC)
  MIRROR_UNIT = "usdc", // "usdc" = mirror their $ spend; "shares" = mirror their share count (forces limit orders)
  ORDER_TYPE = "market", // "market" = FAK market order ($1 min); "limit" = marketable FAK limit at their price + MAX_OVERPAY (5-share min)
  SKIP_BELOW_MIN = "0", // 1 = in mirror mode, skip trades under Polymarket's $1 minimum instead of rounding up to $1
  MAX_TRADES = "0", // stop after this many placed trades (0 = unlimited)
  MAX_ADVERSE_DRIFT = "0.03", // skip if our exec price is this far BELOW theirs (the bet is already going against us)
  MAX_OVERPAY = "0.05", // skip if our exec price is this far ABOVE theirs (we'd pay up for a worse edge); with ORDER_TYPE=limit also the limit price cap
  MAX_ACTIVE_PCT = "50", // cap: active bets <= this % of (balance + active). 0 = gate disabled
  DRIFT_GUARD = "1", // 1 = refuse orders once the book has moved away from the trader's price
  DRY_RUN_BALANCE_USDC = "100", // paper balance used by the risk gate in dry-run
  RESOLUTION_RECHECK_MS = "60000", // how often unresolved markets are re-checked
  FETCH_FAIL_LIMIT = "3", // consecutive all-wallet network-failed polls before self-shutdown (yarn down). 0 = never
  WS_ENABLED = "1", // 1 = real-time websocket trade feed is the primary signal (poller stays as fallback)
  WS_URL = "wss://ws-live-data.polymarket.com",
  WS_DEBUG = "0", // 1 = log every raw ws message (verbose; first 3 after connect are always logged)
  DRY_RUN = "0",
  SEEN_FILE = path.join(__dirname, "seen-trades.json"),
  TRADES_LOG_FILE = path.join(__dirname, "trades-log.json"),
  STATUS_FILE = path.join(__dirname, "status.json"),
} = process.env;

const CHAIN_ID = 137; // Polygon mainnet
const MIN_ORDER_USDC = 1; // Polymarket minimum for market orders
const MIN_LIMIT_SHARES = 5; // Polymarket minimum size for limit orders
const BET_USDC = Number(MAX_BET_USDC); // USDC spent per copied bet (from env, default $1)

const isDryRun = DRY_RUN === "1" || DRY_RUN.toLowerCase() === "true";
const maxActivePct = Math.max(0, Number(MAX_ACTIVE_PCT) || 0); // 0 = disabled
const mirrorBet = MIRROR_TRADER_BET === "1" || MIRROR_TRADER_BET.toLowerCase() === "true";
const mirrorShares = mirrorBet && MIRROR_UNIT.trim().toLowerCase() === "shares";
// Share-mirroring is only expressible as a limit order, so it forces limit mode.
const useLimitOrders = mirrorShares || ORDER_TYPE.trim().toLowerCase() === "limit";
const skipBelowMin = SKIP_BELOW_MIN === "1" || SKIP_BELOW_MIN.toLowerCase() === "true";
const pollInterval = Number(POLL_INTERVAL_MS);
const maxTrades = Number(MAX_TRADES) || 0; // 0 = unlimited
const driftGuard = DRIFT_GUARD === "1" || DRIFT_GUARD.toLowerCase() === "true";
const maxAdverseDrift = Number(MAX_ADVERSE_DRIFT);
const maxOverpay = Number(MAX_OVERPAY);
let tradesPlaced = 0;

/** Normalize wallet entries: lowercase addresses, drop empties, dedupe by address. */
function normalizeWallets(list) {
  const out = [];
  const seen = new Set();
  for (const w of list || []) {
    const address = String(w.address || "")
      .trim()
      .toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({
      address,
      category: w.category || "uncategorized",
      // sub_category: slug keywords to copy, e.g. ["btc"]. Empty = copy everything.
      subCategories: (w.sub_category || w.subCategories || [])
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean),
      // max_trade_age_sec: per-wallet stale cutoff; null/absent = no cutoff,
      // copy regardless of trade age
      maxTradeAgeSec:
        Number(w.max_trade_age_sec ?? w.maxTradeAgeSec) > 0
          ? Number(w.max_trade_age_sec ?? w.maxTradeAgeSec)
          : null,
    });
  }
  return out;
}

const targetWallets = normalizeWallets(
  TARGET_USERS
    ? TARGET_USERS.split(",").map((a) => ({ address: a, category: "env" }))
    : TARGET_WALLETS,
);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Seen-trade persistence (so restarts don't re-place old trades)
// ---------------------------------------------------------------------------

/**
 * Write JSON atomically (tmp file + rename) so a mid-write crash can't corrupt it.
 * On Windows the rename fails with EPERM/EBUSY while another process (dashboard
 * read, antivirus scan, OneDrive sync) briefly holds the target open. Renaming
 * over an open file is forbidden there, but writing INTO it is allowed — so
 * fall back to a direct write instead of dropping the save. The fallback isn't
 * crash-atomic, but it only runs in that rare contested window, and the journal
 * loader already backs up an unparseable file instead of wiping history.
 */
function writeJsonAtomic(file, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (!/^(EPERM|EBUSY|EACCES)$/.test(err.code || "")) throw err;
    fs.writeFileSync(file, json);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* next save overwrites it */
    }
  }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    if (Array.isArray(raw)) {
      // legacy format: plain array of seen keys, no per-wallet baseline info
      return { seen: new Set(raw), baselined: new Set() };
    }
    return {
      seen: new Set(raw.seen || []),
      baselined: new Set(raw.baselined || []),
    };
  } catch {
    return { seen: new Set(), baselined: new Set() };
  }
}

function saveState(state) {
  writeJsonAtomic(SEEN_FILE, {
    seen: [...state.seen],
    baselined: [...state.baselined],
  });
}

function tradeKey(t) {
  return `${t.transactionHash}:${t.asset}`;
}

// ---------------------------------------------------------------------------
// Trade journal + status (read by the dashboard)
// ---------------------------------------------------------------------------

// Retention: the most recent MAX_OBSERVED_ENTRIES rows are kept whatever their
// status — that window is exactly what the dashboard's target-trades panel
// lists, so nothing can vanish out of the view it is sized to. Older rows are
// dropped unless they carry a copy attempt; the lifetime copy history is never
// evicted. Status is deliberately NOT part of this decision: skip rows
// (min/risk/drift) have no `copy`, and evicting them by status deleted the only
// record of a trade we saw and declined.
const MAX_OBSERVED_ENTRIES = 300;

/** Trade time for ordering, falling back to when we observed it. */
function journalTime(e) {
  return e.tradedAt || e.observedAt || 0;
}

/**
 * The rows to keep: the `cap` newest by trade time, plus every copy attempt.
 *
 * Pure so it can be tested; insertion order is not reliably chronological (ws
 * and poll rows interleave), so recency is ranked by time, not position.
 */
function prunedJournal(rows, cap = MAX_OBSERVED_ENTRIES) {
  if (rows.length <= cap) return [...rows];
  const recent = new Set(
    [...rows]
      .sort((a, b) => journalTime(b) - journalTime(a))
      .slice(0, cap)
      .map((e) => e.id),
  );
  return rows.filter((e) => e.copy || recent.has(e.id));
}

function loadJournal() {
  try {
    const arr = JSON.parse(fs.readFileSync(TRADES_LOG_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    // If a journal file EXISTS but can't be parsed, don't silently start empty
    // (the next save would wipe the trade history) — back it up first.
    if (fs.existsSync(TRADES_LOG_FILE)) {
      const backup = `${TRADES_LOG_FILE}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(TRADES_LOG_FILE, backup);
        console.error(
          `trades log unreadable (${err.message}) — backed up to ${backup}`,
        );
      } catch {
        /* best effort */
      }
    }
    return [];
  }
}

const journal = loadJournal(); // newest first
const journalIds = new Set(journal.map((e) => e.id));

function saveJournal() {
  writeJsonAtomic(TRADES_LOG_FILE, journal);
}

/** Apply `prunedJournal` to the live journal in place, keeping ids in sync. */
function trimJournal() {
  const kept = prunedJournal(journal);
  if (kept.length === journal.length) return;
  const keptSet = new Set(kept);
  for (const e of journal) {
    if (!keptSet.has(e)) journalIds.delete(e.id);
  }
  journal.length = 0;
  journal.push(...kept);
}

/** Record a newly observed target trade (id = tradeKey). No-op if already logged. */
function journalAdd(entry) {
  if (journalIds.has(entry.id)) return;
  journal.unshift(entry);
  journalIds.add(entry.id);
  trimJournal();
  saveJournal();
}

/**
 * Patch a journal entry. If the row was evicted in the meantime (observed-pool
 * churn), `base` re-inserts it so a copy attempt is NEVER lost from the journal.
 */
function journalUpdate(id, patch, base) {
  let e = journal.find((e) => e.id === id);
  if (!e && base) {
    e = base;
    journal.unshift(e);
    journalIds.add(e.id);
  }
  if (!e) return;
  Object.assign(e, patch);
  trimJournal();
  saveJournal();
}

/** Heartbeat + config snapshot so the dashboard knows the engine is alive. */

/**
 * Uptime survives restarts: reuse startedAt from the previous status file so
 * pm2 restarts/redeploys don't reset the clock. Only a true fresh start —
 * no status.json, e.g. after `yarn reset` — begins a new uptime.
 */
function loadStartedAt() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    if (Number.isFinite(s.startedAt) && s.startedAt > 0 && s.startedAt <= Date.now())
      return s.startedAt;
  } catch {
    /* no/unreadable status file -> fresh start */
  }
  return Date.now();
}
const engineStartedAt = loadStartedAt();

/**
 * Dry-run paper balance survives restarts the same way startedAt does: reuse
 * the value from the previous status file; a fresh start (`yarn reset`)
 * re-seeds it from DRY_RUN_BALANCE_USDC.
 */
function loadPaperBalance() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    if (Number.isFinite(s.paperBalance)) return s.paperBalance;
  } catch {
    /* fresh start */
  }
  return Number(DRY_RUN_BALANCE_USDC) || 0;
}
let paperBalance = isDryRun ? loadPaperBalance() : null;

/**
 * Skip counters carried over from the previous status file.
 *
 * These are running totals of trades the guards turned away, and a restart is
 * not a new session: pm2 restarts and redeploys must not erase the record, the
 * same way startedAt and paperBalance survive them. Only a true fresh start
 * (`yarn reset`, which deletes status.json) begins at 0.
 *
 * Pure so it can be tested; a missing, negative or non-numeric field reads as 0
 * rather than poisoning the total with NaN.
 */
function resumedSkipCounts(prev) {
  const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    riskSkipped: count(prev?.riskSkipped),
    driftSkipped: count(prev?.driftSkipped),
  };
}

function loadSkipCounts() {
  try {
    return resumedSkipCounts(JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")));
  } catch {
    /* no/unreadable status file -> fresh start */
    return resumedSkipCounts(null);
  }
}

// Last risk-gate snapshot, surfaced to the dashboard via status.json. The skip
// totals resume from the previous run; balance/activeUsdc are live-only reads.
let riskSnapshot = { balance: null, activeUsdc: null, ...loadSkipCounts() };

function writeStatus() {
  try {
    writeJsonAtomic(STATUS_FILE, {
      mode: isDryRun ? "dry" : "live",
      betUsdc: BET_USDC,
      betMode: mirrorBet ? (mirrorShares ? "mirror-shares" : "mirror") : "fixed",
      orderType: useLimitOrders ? "limit" : "market",
      pollIntervalMs: pollInterval,
      maxTrades,
      tradesPlaced,
      targets: targetWallets,
      startedAt: engineStartedAt,
      maxActivePct,
      wsEnabled,
      wsConnected,
      paperBalance: isDryRun ? paperBalance : undefined,
      balance: riskSnapshot.balance,
      activeUsdc: riskSnapshot.activeUsdc,
      riskSkipped: riskSnapshot.riskSkipped,
      driftGuard,
      maxAdverseDrift: driftGuard ? maxAdverseDrift : undefined,
      maxOverpay: driftGuard ? maxOverpay : undefined,
      driftSkipped: riskSnapshot.driftSkipped,
      updatedAt: Date.now(),
    });
  } catch (err) {
    log("failed to write status file:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Activity API
// ---------------------------------------------------------------------------

/** GET a JSON URL. Uses global fetch (Node 18+) or falls back to http/https (Node 16). */
function getJson(url) {
  if (typeof fetch === "function") {
    return fetch(url, {
      headers: { accept: "application/json, text/plain, */*" },
    }).then((res) => {
      if (!res.ok)
        throw new Error(`activity API ${res.status} ${res.statusText}`);
      return res.json();
    });
  }
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? require("https") : require("http");
    const req = lib.get(
      url,
      { headers: { accept: "application/json, text/plain, */*" } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(
            new Error(`activity API ${res.statusCode} ${res.statusMessage}`),
          );
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(
              new Error(`activity API returned invalid JSON: ${err.message}`),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("activity API timeout")));
  });
}

async function fetchActivity(user) {
  const url =
    `${DATA_API_HOST}/activity?limit=500&offset=0` +
    `&excludeDepositsWithdrawals=true&sortBy=TIMESTAMP&sortDirection=DESC` +
    `&type=TRADE&side=BUY` +
    `&user=${user}`;
  const data = await getJson(url);
  if (!Array.isArray(data)) throw new Error("activity API returned non-array");
  return data;
}

/** Keep only BUY trade rows that have what we need to place an order. */
function filterBuys(activity) {
  return activity.filter(
    (a) =>
      (a.type === undefined || String(a.type).toUpperCase() === "TRADE") &&
      String(a.side || "").toUpperCase() === "BUY" &&
      a.asset &&
      a.transactionHash,
  );
}

/** New trades we haven't copied yet (does not mutate seen). */
function pickNewTrades(buys, seen) {
  return buys.filter((t) => !seen.has(tradeKey(t)));
}

/**
 * True when the trade's market slug contains any of the wallet's sub-category
 * keywords (e.g. keyword "btc" matches slug "btc-updown-5m-..." or "...-btc-...").
 * An empty sub-category list means copy everything.
 */
function matchesSubCategory(trade, subCategories) {
  if (!subCategories || subCategories.length === 0) return true;
  const slugs = [trade.slug, trade.eventSlug]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return subCategories.some((sub) => slugs.some((slug) => slug.includes(sub)));
}

/** Split trades into { copyable, stale } by age — stale ones are too old to chase. */
function splitStale(trades, nowSec, maxAgeSec) {
  const copyable = [];
  const stale = [];
  for (const t of trades) {
    (nowSec - (t.timestamp || 0) > maxAgeSec ? stale : copyable).push(t);
  }
  return { copyable, stale };
}

/**
 * A copy of `trades` ordered oldest-first.
 *
 * The activity API returns newest-first (sortDirection=DESC) and journalAdd
 * unshifts each row onto the front, so feeding it the API order reverses every
 * batch: the oldest trade of a poll ends up above the newest. Journaling
 * oldest-first makes the unshifts come out newest-at-top, which is the order the
 * dashboard lists them in.
 */
function oldestFirst(trades) {
  return [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Best (lowest) ask price from a CLOB order book, or null if there is none.
 *
 * The book's `asks` array is ordered WORST-first / BEST-last — the same order
 * clob-client-v2's own calculateBuyMarketPrice walks in reverse. Reading
 * `asks[0]` would take the most expensive level in the book, so the last
 * element is the one to use.
 */
function bestAsk(book) {
  const asks = book && Array.isArray(book.asks) ? book.asks : null;
  if (!asks || asks.length === 0) return null;
  const p = Number(asks[asks.length - 1]?.price);
  return Number.isFinite(p) ? p : null;
}

/**
 * Price-deviation gate: is our expected execution price still close enough to
 * the price the trader actually got?
 *
 * Copying is only meaningful while the market still agrees with the trader's
 * read. Two ways it stops agreeing, and both lose money:
 *
 * - execPrice far BELOW theirs — the book has moved against the position while
 *   we were getting here. A cheap fill is not a discount; in a fast market the
 *   ask only falls because the bet is already going wrong, and an unbounded
 *   market order will happily buy it anyway.
 * - execPrice far ABOVE theirs — we would pay up for a thesis priced at less,
 *   which is the same trade with the edge removed.
 *
 * Returns { allowed, reason }. Callers must fail closed when execPrice is null.
 */
/** Trim float noise for log messages (0.39000012221 -> 0.39). */
function round4(n) {
  return Number(Number(n).toFixed(4));
}

function driftVerdict(
  execPrice,
  theirPrice,
  { adverse = maxAdverseDrift, overpay = maxOverpay } = {},
) {
  if (!Number.isFinite(execPrice)) {
    return { allowed: false, reason: "no executable price available (fail-closed)" };
  }
  if (!Number.isFinite(theirPrice) || theirPrice <= 0) {
    return { allowed: false, reason: "trader price unknown (fail-closed)" };
  }
  const drift = execPrice - theirPrice;
  // Prices arrive as decimals whose subtraction is not exact (0.47 - 0.50 is
  // -0.030000000000000027), so a drift sitting exactly on the limit would trip
  // or not depending on float representation. Allow the boundary explicitly.
  const EPS = 1e-9;
  if (Number.isFinite(adverse) && adverse >= 0 && drift < -adverse - EPS) {
    return {
      allowed: false,
      reason:
        `book moved against us: our ${round4(execPrice)} is ${Math.abs(drift).toFixed(3)} ` +
        `below their ${round4(theirPrice)} (limit ${adverse})`,
    };
  }
  if (Number.isFinite(overpay) && overpay >= 0 && drift > overpay + EPS) {
    return {
      allowed: false,
      reason:
        `we would overpay: our ${round4(execPrice)} is ${drift.toFixed(3)} ` +
        `above their ${round4(theirPrice)} (limit ${overpay})`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * USDC to spend on a copied trade.
 * - default: fixed MAX_BET_USDC, ignoring the trader's size
 * - MIRROR_TRADER_BET=1: match the trader's usdcSize, capped at MAX_BET_USDC
 *   and floored at Polymarket's $1 minimum
 */
function betAmount(trade, { mirror = mirrorBet, cap = BET_USDC } = {}) {
  if (!mirror) return cap;
  const theirs = Number(trade?.usdcSize);
  if (!Number.isFinite(theirs) || theirs <= 0) return cap;
  return Math.max(MIN_ORDER_USDC, Math.min(theirs, cap));
}

/**
 * Share-mirror mode: the highest price we are willing to pay per share.
 * The trader's price plus the drift guard's overpay allowance, floored to a
 * cent (every Polymarket tick size divides 0.01) and clamped inside the book.
 */
function limitPriceFor(trade) {
  const theirs = Number(trade?.price);
  if (!Number.isFinite(theirs) || theirs <= 0) return null;
  const cap = Math.min(0.99, theirs + maxOverpay);
  return Math.max(0.01, Math.floor(cap * 100) / 100);
}

/**
 * Share-mirror mode: how many shares to buy — the trader's share count,
 * capped so the worst-case cost (size x limit price) stays within MAX_BET_USDC.
 * Returns the size trimmed to 2 decimals; caller enforces MIN_LIMIT_SHARES.
 */
function shareAmount(trade, limitPrice, { cap = BET_USDC } = {}) {
  const theirs = Number(trade?.size);
  if (!Number.isFinite(theirs) || theirs <= 0) return null;
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return null;
  const maxAffordable = cap / limitPrice;
  return Math.floor(Math.min(theirs, maxAffordable) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Order placement (CLOB)
// ---------------------------------------------------------------------------

let clobClient = null;

async function getClobClient() {
  if (clobClient) return clobClient;

  // CLOB v2: Polymarket archived @polymarket/clob-client — orders from it are
  // rejected with "invalid order version". clob-client-v2 requires Node >= 20.10.
  const { ClobClient, Side, OrderType, AssetType } =
    await import("@polymarket/clob-client-v2");
  const { Wallet } = require("@ethersproject/wallet");

  const signer = new Wallet(PRIVATE_KEY);
  const sigType = Number(SIGNATURE_TYPE);

  // First client only to derive API creds, then the real one with creds
  const bootstrap = new ClobClient({
    host: CLOB_API_HOST,
    chain: CHAIN_ID,
    signer,
    signatureType: sigType,
    funderAddress: FUNDER_ADDRESS,
  });
  const creds = await bootstrap.createOrDeriveApiKey();
  clobClient = new ClobClient({
    host: CLOB_API_HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: sigType,
    funderAddress: FUNDER_ADDRESS,
  });
  clobClient._Side = Side;
  clobClient._OrderType = OrderType;
  clobClient._AssetType = AssetType;
  return clobClient;
}

/**
 * The price our order would actually execute at, for `amountUsdc` of size.
 *
 * Uses the client's own calculateMarketPrice — the exact call createMarketOrder
 * makes to price an unpriced market order — so the guard checks the same number
 * the order will be built with rather than a top-of-book approximation. It walks
 * real depth, so a thin best ask that cannot absorb our size is reflected here
 * instead of flattering the check.
 *
 * Returns null when the price cannot be determined (empty book, network error,
 * insufficient depth under FOK); callers treat null as "do not trade".
 */
async function execPriceFor(trade, amountUsdc) {
  // Never throw: a lookup failure must produce null (-> fail closed -> a clean
  // drift-skip). Throwing here would abandon the rest of the batch and leave
  // this trade unmarked, so the next poll would retry it at a staler price.
  let client;
  try {
    client = await getClobClient();
  } catch (err) {
    log(`drift guard: CLOB client unavailable (${err.message})`);
    return null;
  }
  try {
    const p = await client.calculateMarketPrice(
      trade.asset,
      client._Side.BUY,
      amountUsdc,
      client._OrderType.FAK,
    );
    const n = Number(p);
    if (Number.isFinite(n)) return n;
  } catch (err) {
    // "no orderbook" / "no match" (no depth) land here — fall back to the raw
    // book so a thin-but-present ask can still be evaluated.
    log(`drift guard: market-price lookup failed (${err.message}) — trying raw book`);
  }
  try {
    return bestAsk(await client.getOrderBook(trade.asset));
  } catch (err) {
    log(`drift guard: order book unavailable (${err.message})`);
    return null;
  }
}

/**
 * Warm the market metadata createMarketOrder needs, so the order path does not
 * stop to fetch it.
 *
 * For a token it has not seen, createMarketOrder calls _ensureMarketInfoCached,
 * which makes TWO sequential requests: /markets-by-token/ to learn the condition
 * id, then /clob-markets/ for tick size, neg-risk and fees. Measured against the
 * live CLOB that is ~227ms + ~238ms — and in 5-minute markets every token is new,
 * so nearly every copy paid it.
 *
 * Both are avoidable. The activity payload already tells us the condition id, and
 * /clob-markets/ populates tick size, neg-risk and fee info for BOTH of the
 * market's tokens at once — enough for _ensureMarketInfoCached to return without
 * touching the network. Called concurrently with the price lookup, so it costs no
 * wall-clock at all.
 *
 * Never throws: on failure the order simply fetches what it needs, as before.
 */
async function warmMarketInfo(trade) {
  if (!trade.conditionId) return; // nothing to warm from; order path will resolve it
  try {
    const client = await getClobClient();
    await client.getClobMarketInfo(trade.conditionId);
  } catch (err) {
    log(`market info prefetch failed (${err.message}) — the order will fetch it`);
  }
}

/**
 * Pre-flight before an order: read the executable price for the drift gate and
 * warm the market metadata, both at once.
 *
 * The two are independent, so Promise.all makes the metadata free — it finishes
 * under the price lookup we are waiting for anyway. Together with passing the
 * price into createMarketOrder (see marketOrderArgs), this leaves the order path
 * with no metadata or pricing round-trips at all: just the signed POST.
 *
 * Disabled guard -> always allowed, but the metadata is still warmed, since that
 * is a pure latency win and independent of the price check. In dry-run without
 * credentials there is no CLOB client to ask, so the gate cannot run; it reports
 * `unavailable` rather than silently passing, and startup warns.
 */
async function driftGateCheck(trade, amountUsdc) {
  if (!PRIVATE_KEY) {
    return { allowed: true, reason: null, execPrice: null, unavailable: true };
  }
  const [execPrice] = await Promise.all([
    driftGuard ? execPriceFor(trade, amountUsdc) : Promise.resolve(null),
    warmMarketInfo(trade),
  ]);
  if (!driftGuard) return { allowed: true, reason: null, execPrice: null };
  const v = driftVerdict(execPrice, Number(trade.price));
  return { ...v, execPrice };
}

/**
 * Arguments for createMarketOrder.
 *
 * FAK (fill-and-kill): take whatever liquidity is available at the computed
 * market price and cancel the rest — partial directional exposure beats the
 * all-or-nothing FOK, which fails exactly when fast markets move.
 *
 * `execPrice` is the price the drift guard already computed from the book, and
 * passing it through is what keeps the guard free. createMarketOrder only calls
 * calculateMarketPrice — a /book round-trip, measured at 150-200ms against the
 * live CLOB — when `price` is absent. Supplying it means the guard reuses that
 * single fetch rather than adding a second one, so the check costs no extra
 * network time on the path that matters. Dropping `price` here would silently
 * double the round-trip and widen the very drift window the guard exists to
 * close, so it is covered by a test.
 *
 * Omitted when the guard is off or could not read a price; the client then
 * prices the order itself, exactly as it did before the guard existed.
 */
function marketOrderArgs({ tokenID, amount, side, orderType, execPrice }) {
  return {
    tokenID,
    amount, // USDC to spend for a BUY market order
    side,
    orderType,
    ...(Number.isFinite(execPrice) ? { price: execPrice } : {}),
  };
}

async function placeMarketBuy(trade, amountUsdc, execPrice) {
  if (isDryRun) {
    log(
      `[DRY_RUN] would market-BUY $${amountUsdc} of "${trade.outcome}" ` +
        `in "${trade.title}" (token ${trade.asset}, their price ${trade.price}` +
        (Number.isFinite(execPrice)
          ? `, our executable price ${execPrice}`
          : ", executable price unknown") +
        `)`,
    );
    return { dryRun: true };
  }

  const client = await getClobClient();
  const order = await client.createMarketOrder(
    marketOrderArgs({
      tokenID: trade.asset,
      amount: amountUsdc,
      side: client._Side.BUY,
      orderType: client._OrderType.FAK,
      execPrice,
    }),
  );
  const resp = await client.postOrder(order, client._OrderType.FAK);
  log("order response:", JSON.stringify(resp));
  // The client can return API errors as a normal response instead of throwing —
  // a rejected order must NOT count as placed or be marked seen.
  if (!resp || resp.error || resp.success === false) {
    throw new Error(
      `order rejected: ${resp?.error || resp?.errorMsg || "unknown error"}`,
    );
  }
  return resp;
}

/**
 * Share-mirror mode: marketable FAK limit BUY — "buy up to `sizeShares` at up
 * to `limitPrice` each, fill what the book offers, cancel the rest." Unlike a
 * market order (denominated in $), a limit order is denominated in shares,
 * which is what lets us copy the trader's share count exactly.
 */
async function placeLimitBuy(trade, sizeShares, limitPrice) {
  if (isDryRun) {
    log(
      `[DRY_RUN] would limit-BUY ${sizeShares} shares of "${trade.outcome}" ` +
        `in "${trade.title}" (token ${trade.asset}, their price ${trade.price}, ` +
        `limit ${limitPrice}, worst-case $${(sizeShares * limitPrice).toFixed(2)})`,
    );
    return { dryRun: true };
  }

  const client = await getClobClient();
  const order = await client.createOrder({
    tokenID: trade.asset,
    price: limitPrice,
    side: client._Side.BUY,
    size: sizeShares,
  });
  const resp = await client.postOrder(order, client._OrderType.FAK);
  log("order response:", JSON.stringify(resp));
  if (!resp || resp.error || resp.success === false) {
    throw new Error(
      `order rejected: ${resp?.error || resp?.errorMsg || "unknown error"}`,
    );
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Risk gate: cap active-in-trading at MAX_ACTIVE_PCT of the bankroll
// ---------------------------------------------------------------------------

// Market resolution via CLOB /markets/{condition_id} — shared cache module,
// same one the dashboard server uses for win/loss display.
const resolutions = createResolutionCache({
  host: CLOB_API_HOST,
  fetchJson: getJson,
  recheckMs: Number(RESOLUTION_RECHECK_MS) || 0,
});

/** Successful copies from the journal (the positions the gate accounts for). */
function successfulCopies() {
  return journal.filter((e) => e.copy && e.status === "success");
}

/** Market close time (ms) parsed from up/down slugs like "eth-updown-5m-1786848600". */
function marketCloseMs(slug) {
  const m = /-(\d+)m-(\d{10})$/.exec(slug || "");
  return m ? (Number(m[2]) + Number(m[1]) * 60) * 1000 : null;
}

function refreshResolutions() {
  const now = Date.now();
  return resolutions.refresh(
    successfulCopies()
      .filter((e) => {
        if (e.copy.settled) return false;
        // a market cannot resolve before it closes — don't waste lookups
        // mid-market; ask the moment the clock passes the close time
        // (unparseable slugs are checked normally as a safe fallback)
        const closeMs = marketCloseMs(e.slug);
        return !closeMs || now >= closeMs;
      })
      .map((e) => e.conditionId),
  );
}

/**
 * Refresh the resolution cache and settle whatever became resolved, off the copy
 * path. Called from the poll loop's idle gap and once at startup, never from the
 * risk gate — that is the whole point, see riskGateCheck.
 *
 * Never throws: a failed lookup leaves the market unresolved, which the gate
 * treats as still-active. Losing a refresh is harmless; crashing the poll loop
 * is not.
 */
async function warmResolutions() {
  try {
    await refreshResolutions();
    await serialize(() => {
      settleResolvedCopies();
    });
  } catch (err) {
    log("resolution refresh failed:", err.message || err);
  }
}

/**
 * Mark resolved copies as settled (so they leave "active" permanently).
 * Dry-run: also credit win payouts to the paper balance — winners pay $1/share,
 * losers pay nothing (the spend was already debited at bet time).
 */
function settleResolvedCopies() {
  for (const e of successfulCopies()) {
    if (e.copy.settled) continue;
    const c = e.conditionId && resolutions.get(e.conditionId);
    if (!c || !c.resolved) continue;
    const tokenId = e.asset || String(e.id || "").split(":")[1] || "";
    const won = c.tokens.some((t) => t.tokenId === tokenId && t.winner);
    if (isDryRun && e.copy.mode === "dry" && won) {
      paperBalance += e.copy.shares || 0;
    }
    journalUpdate(e.id, { copy: { ...e.copy, settled: true, won } });
  }
}

/** USDC committed to copies whose market hasn't resolved yet (cost basis). */
function getActiveUsdc() {
  const mode = isDryRun ? "dry" : "live";
  let sum = 0;
  for (const e of successfulCopies()) {
    // dry-run leftovers must not consume the LIVE cap (and vice versa):
    // paper exposure isn't real money, so the gate only counts its own mode
    if (e.copy.mode !== mode) continue;
    const c = e.conditionId && resolutions.get(e.conditionId);
    if (e.copy.settled || (c && c.resolved)) continue;
    sum += e.copy.spentUsdc || 0;
  }
  return sum;
}

const BALANCE_TTL_MS = 30000;
let balanceCache = { value: null, fetchedAt: 0 };

/** Spendable USDC: paper balance in dry-run, CLOB getBalanceAllowance live. */
async function getUsdcBalance() {
  if (isDryRun) return paperBalance;
  const now = Date.now();
  if (balanceCache.value != null && now - balanceCache.fetchedAt < BALANCE_TTL_MS)
    return balanceCache.value;
  const client = await getClobClient();
  const resp = await client.getBalanceAllowance({
    asset_type: client._AssetType.COLLATERAL,
  });
  const raw = Number(resp?.balance); // micro-USDC string (6 decimals)
  if (!Number.isFinite(raw)) throw new Error("balance API returned no balance");
  balanceCache = { value: raw / 1e6, fetchedAt: now };
  return balanceCache.value;
}

/**
 * Allow a new bet only while (active + bet) stays within MAX_ACTIVE_PCT of the
 * bankroll. Bankroll = balance + active: the "original money" — open bets are
 * money that still exists, just committed, so a shrinking cash balance doesn't
 * double-count them and silently tighten the cap.
 * Fail-closed: if the balance can't be read, the trade is blocked.
 */
async function riskGateCheck(amountUsdc) {
  if (!maxActivePct) return { allowed: true, disabled: true };
  // Deliberately does NOT refresh resolutions: that is a /markets round-trip
  // (~200ms) and this runs on the copy path, where every millisecond widens the
  // price drift we are trying to avoid. The poll loop keeps the cache warm in
  // its idle gap instead, so this reads it for free.
  //
  // Safe because staleness only ever errs toward caution: a market that resolved
  // but has not been re-checked still counts toward `active`, overstating
  // exposure and making the gate stricter, never looser. And the cache was
  // already allowed to be RESOLUTION_RECHECK_MS (60s) old — refreshing on the
  // poll tick makes it fresher than the old inline call did, not staler.
  settleResolvedCopies();
  const active = getActiveUsdc();
  let balance;
  try {
    balance = await getUsdcBalance();
  } catch (err) {
    riskSnapshot = { ...riskSnapshot, activeUsdc: active, balance: null };
    return {
      allowed: false,
      active,
      reason: `balance unavailable (${err.message}) — failing closed`,
    };
  }
  const bankroll = balance + active;
  const capUsdc = (maxActivePct / 100) * bankroll;
  riskSnapshot = { ...riskSnapshot, balance, activeUsdc: active };
  if (active + amountUsdc > capUsdc + 1e-9) {
    return {
      allowed: false,
      active,
      balance,
      capUsdc,
      reason:
        `$${(active + amountUsdc).toFixed(2)} at risk would exceed the ` +
        `${maxActivePct}% cap $${capUsdc.toFixed(2)} ` +
        `(active $${active.toFixed(2)} + bet $${amountUsdc.toFixed(2)}, ` +
        `bankroll $${bankroll.toFixed(2)})`,
    };
  }
  return { allowed: true, active, balance, capUsdc };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/** Base journal entry for an observed target trade. */
function observedEntry(trade, wallet, status) {
  return {
    id: tradeKey(trade),
    observedAt: Date.now(),
    tradedAt: (trade.timestamp || 0) * 1000,
    wallet: wallet.address,
    category: wallet.category,
    title: trade.title || "",
    outcome: trade.outcome || "",
    outcomeIndex: trade.outcomeIndex ?? null,
    conditionId: trade.conditionId || "",
    asset: trade.asset || "",
    slug: trade.slug || trade.eventSlug || "",
    theirPrice: trade.price,
    theirUsdc: trade.usdcSize,
    theirShares: trade.size,
    status, // baseline | filtered | stale | pending | min-skip | drift-skip | success | failed
    copy: null, // filled in when we attempt the copy
  };
}

async function pollUser(wallet, state) {
  const { address, category } = wallet;
  const tag = `[${category}:${address}]`;
  const activity = await fetchActivity(address);
  const allBuys = filterBuys(activity);
  const buys = allBuys.filter((t) =>
    matchesSubCategory(t, wallet.subCategories),
  );
  const fresh = pickNewTrades(buys, state.seen);

  if (!state.baselined.has(address)) {
    // First time we watch this wallet: record its existing history as seen,
    // only copy trades it makes from now on.
    fresh.forEach((t) => state.seen.add(tradeKey(t)));
    state.baselined.add(address);
    saveState(state);
    // oldest first: journalAdd unshifts, so this lands newest-at-top
    oldestFirst(allBuys).forEach((t) =>
      journalAdd(observedEntry(t, wallet, "baseline")),
    );
    log(`${tag} baseline: marked ${fresh.length} existing BUY trades as seen`);
    return;
  }

  // Journal every newly observed buy, including ones we won't copy.
  // Skip trades already decided (in `seen`) whose journal row was evicted by
  // the observed-pool cap — re-adding them would create zombie "pending" rows
  // that never receive a verdict (the copy loop never revisits seen keys).
  for (const t of oldestFirst(allBuys)) {
    const key = tradeKey(t);
    if (journalIds.has(key) || state.seen.has(key)) continue;
    const status = matchesSubCategory(t, wallet.subCategories)
      ? "pending"
      : "filtered";
    journalAdd(observedEntry(t, wallet, status));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // No per-wallet cutoff = copy everything regardless of trade age
  const { copyable, stale } = wallet.maxTradeAgeSec
    ? splitStale(fresh, nowSec, wallet.maxTradeAgeSec)
    : { copyable: fresh, stale: [] };

  // Too old to chase (fast markets expire) — mark seen so we never retry them
  if (stale.length > 0) {
    stale.forEach((t) => {
      state.seen.add(tradeKey(t));
      journalUpdate(tradeKey(t), { status: "stale" });
    });
    saveState(state);
    log(
      `${tag} skipped ${stale.length} stale trade(s) older than ${wallet.maxTradeAgeSec}s`,
    );
  }

  if (copyable.length === 0) {
    log(
      `${tag} no new BUY trades (${buys.length}/${allBuys.length} buys in window match sub-categories)`,
    );
    return;
  }

  // Oldest first so we copy in the order they traded
  copyable.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  await copyTrades(wallet, copyable, state, tag);
}

/** Copy a batch of fresh, non-stale BUY trades (shared by poller and ws feed). */
async function copyTrades(wallet, copyable, state, tag) {
  // which pipeline delivered the signal — recorded per copy for latency stats
  const source = tag.startsWith("[ws") ? "ws" : "poll";
  for (const trade of copyable) {
    if (maxTrades && tradesPlaced >= maxTrades) return;

    // Activity can contain several rows with the same txHash:asset (partial
    // fills of one order). pickNewTrades ran before this loop, so a key that
    // is in `seen` now was copied earlier in THIS batch — never copy it twice.
    if (state.seen.has(tradeKey(trade))) continue;

    // Exact mirroring below Polymarket's $1 order minimum is impossible —
    // optionally skip those trades instead of rounding the bet up to $1.
    // (Share-mirror mode has its own minimum, handled below.)
    if (
      mirrorBet &&
      !useLimitOrders &&
      skipBelowMin &&
      Number(trade.usdcSize) > 0 &&
      Number(trade.usdcSize) < MIN_ORDER_USDC
    ) {
      state.seen.add(tradeKey(trade));
      saveState(state);
      journalUpdate(
        tradeKey(trade),
        { status: "min-skip" },
        observedEntry(trade, wallet, "min-skip"),
      );
      log(
        `${tag} their bet $${trade.usdcSize} is under the $${MIN_ORDER_USDC} ` +
          `order minimum — skipping "${trade.title}" (SKIP_BELOW_MIN=1)`,
      );
      continue;
    }

    // Limit-order mode: size the order in shares (the trader's share count in
    // share-mirror mode, otherwise the $ budget converted at the limit price),
    // enforce the CLOB's 5-share limit-order minimum, and derive the
    // worst-case $ cost for the risk gate.
    let sizeShares = null;
    let limitPrice = null;
    let amount;
    if (useLimitOrders) {
      limitPrice = limitPriceFor(trade);
      sizeShares =
        limitPrice == null
          ? null
          : mirrorShares
            ? shareAmount(trade, limitPrice)
            : Math.floor((betAmount(trade) / limitPrice) * 100) / 100;
      if (sizeShares == null || limitPrice == null) {
        amount = betAmount(trade); // unusable trade row; fall through to $ copy
        sizeShares = null;
      } else if (sizeShares < MIN_LIMIT_SHARES) {
        // Below the 5-share minimum: bump to 5 unless the user opted to skip,
        // or 5 shares would blow the per-bet cap.
        if (skipBelowMin || MIN_LIMIT_SHARES * limitPrice > BET_USDC) {
          state.seen.add(tradeKey(trade));
          saveState(state);
          journalUpdate(
            tradeKey(trade),
            { status: "min-skip" },
            observedEntry(trade, wallet, "min-skip"),
          );
          log(
            `${tag} ${sizeShares} shares is under the ${MIN_LIMIT_SHARES}-share ` +
              `limit-order minimum — skipping "${trade.title}"`,
          );
          continue;
        }
        sizeShares = MIN_LIMIT_SHARES;
      }
      if (sizeShares != null) {
        amount = Number((sizeShares * limitPrice).toFixed(2)); // worst-case cost
      }
    } else {
      amount = betAmount(trade);
    }

    // Risk gate: never let active-in-trading exceed MAX_ACTIVE_PCT of the
    // bankroll. Blocked trades are skipped for good (chasing them minutes
    // later at a moved price is worse than missing the bet).
    const gate = await riskGateCheck(amount);
    if (!gate.allowed) {
      riskSnapshot.riskSkipped++;
      state.seen.add(tradeKey(trade));
      saveState(state);
      journalUpdate(
        tradeKey(trade),
        { status: "risk-skip", riskReason: gate.reason },
        observedEntry(trade, wallet, "risk-skip"),
      );
      log(`${tag} RISK SKIP "${trade.title}": ${gate.reason}`);
      writeStatus();
      continue;
    }

    // Price-deviation gate: the trader's price only justifies the copy while the
    // book still agrees with it. Skipped for good like a risk-skip — re-checking
    // later means an even staler read, never a better one.
    const drift = await driftGateCheck(trade, amount);
    if (!drift.allowed) {
      riskSnapshot.driftSkipped++;
      state.seen.add(tradeKey(trade));
      saveState(state);
      journalUpdate(
        tradeKey(trade),
        {
          status: "drift-skip",
          driftReason: drift.reason,
          ourPrice: drift.execPrice,
        },
        observedEntry(trade, wallet, "drift-skip"),
      );
      log(`${tag} DRIFT SKIP "${trade.title}": ${drift.reason}`);
      writeStatus();
      continue;
    }

    log(
      `${tag} new BUY: "${trade.title}" / ${trade.outcome} ` +
        `@ ${trade.price} ($${trade.usdcSize}) -> copying with ` +
        (sizeShares != null ? `${sizeShares} shares (limit ${limitPrice}, worst-case $${amount})` : `$${amount}`),
    );
    try {
      const resp = sizeShares != null
        ? await placeLimitBuy(trade, sizeShares, limitPrice)
        : await placeMarketBuy(trade, amount, drift.execPrice);
      const fill = resp.dryRun ? null : parseLiveFill(resp, amount);
      state.seen.add(tradeKey(trade));
      saveState(state);
      tradesPlaced++;
      // Dry-run cost: in share-mirror mode the realistic spend is shares x the
      // simulated fill price (the worst-case limit amount would overstate it).
      const simPriceEarly = Number.isFinite(drift.execPrice) ? drift.execPrice : trade.price;
      const spent = resp.dryRun
        ? sizeShares != null
          ? Number((sizeShares * simPriceEarly).toFixed(6))
          : amount
        : fill.spent;
      if (isDryRun) paperBalance -= spent; // paper: debit like a real fill
      balanceCache = { value: null, fetchedAt: 0 }; // live: balance changed, re-fetch
      // Dry-run fill price: prefer the executable price the drift guard just read
      // off the book. Assuming the trader's price instead would simulate a fill we
      // could not actually get, which is precisely how a paper run comes out ahead
      // of the live one. Falls back to their price only when the guard is off or
      // could not read the book.
      const simPrice = Number.isFinite(drift.execPrice)
        ? drift.execPrice
        : trade.price;
      const shares = resp.dryRun
        ? sizeShares != null
          ? sizeShares
          : simPrice > 0
            ? amount / simPrice
            : 0
        : fill.shares;
      journalUpdate(
        tradeKey(trade),
        {
          status: "success",
          // Refresh the trader-side snapshot: the activity row can grow between
          // first observation and the copy (fills aggregate), and betAmount used
          // the values at copy time — the journal must show the same numbers.
          theirPrice: trade.price,
          theirUsdc: trade.usdcSize,
          theirShares: trade.size,
          copy: {
            mode: isDryRun ? "dry" : "live",
            source, // ws | poll — which pipeline delivered the signal
            copiedAt: Date.now(),
            spentUsdc: Number(spent.toFixed(6)),
            shares: Number(shares.toFixed(4)),
            price: shares > 0 ? Number((spent / shares).toFixed(4)) : trade.price,
            orderID: resp.orderID || null,
            txHashes: resp.transactionsHashes || [],
          },
        },
        observedEntry(trade, wallet, "success"),
      );
      if (maxTrades && tradesPlaced >= maxTrades) {
        log(
          `MAX_TRADES limit reached (${tradesPlaced}/${maxTrades}) — stopping. ` +
            `Check the position on Polymarket, then raise/remove MAX_TRADES and restart.`,
        );
        writeStatus();
        process.exit(0);
      }
    } catch (err) {
      log(
        `${tag} FAILED to place order for ${tradeKey(trade)}:`,
        err.message || err,
      );
      journalUpdate(
        tradeKey(trade),
        {
          status: "failed",
          copy: {
            mode: isDryRun ? "dry" : "live",
            source,
            copiedAt: Date.now(),
            error: String(err.message || err),
          },
        },
        observedEntry(trade, wallet, "failed"),
      );
      // not marked seen -> retried next poll (until it goes stale)
    }
  }
}

// ---------------------------------------------------------------------------
// Network-failure self-shutdown: if every wallet poll fails with a network
// error for FETCH_FAIL_LIMIT consecutive cycles, the API is unreachable from
// this machine — run `yarn down` (pm2 delete) instead of spinning forever.
// A plain process.exit would NOT work here: pm2 would just restart us.
// ---------------------------------------------------------------------------

const fetchFailLimit = Math.max(0, Number(FETCH_FAIL_LIMIT) || 0); // 0 = disabled
let consecutiveNetFails = 0;
let shuttingDown = false;

const isNetworkError = (err) =>
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|activity API timeout/i.test(
    String(err?.message || err),
  );

function shutdownViaYarnDown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`SHUTTING DOWN (yarn down): ${reason}`);
  writeStatus();
  const { exec } = require("child_process");
  exec("yarn down", { cwd: __dirname }, (err, stdout, stderr) => {
    // if pm2 delete worked, this process is already dead before the callback;
    // reaching here with an error means yarn/pm2 wasn't available — exit hard
    // so at least this process stops (pm2 may restart it, but we tried).
    if (err) {
      log("yarn down failed:", stderr || err.message);
      process.exit(1);
    }
  });
}

/**
 * Extract the real fill from a live order response.
 * A FAK can be accepted yet fill NOTHING (the book moved) — that is not a
 * copy: throw so the normal failure path retries it until it goes stale,
 * instead of journaling a phantom full-price position.
 */
function parseLiveFill(resp, intendedAmount) {
  const shares = Number(resp.takingAmount);
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error(
      `order accepted but nothing filled (status ${resp.status || "?"})`,
    );
  }
  const spent = Number(resp.makingAmount);
  return {
    spent: Number.isFinite(spent) && spent > 0 ? spent : intendedAmount,
    shares,
  };
}

// ---------------------------------------------------------------------------
// Real-time websocket feed (primary signal) + serialization
// ---------------------------------------------------------------------------

const wsEnabled = WS_ENABLED === "1" || WS_ENABLED.toLowerCase() === "true";
let wsConnected = false;

// The poller and the ws feed share mutable state (seen set, journal, gate,
// tradesPlaced). Everything flows through one serial queue so a ws event can
// never interleave mid-poll and double-copy or race the risk gate.
let workQueue = Promise.resolve();
function serialize(fn) {
  const run = workQueue.then(fn);
  workQueue = run.catch((err) => log("queued task error:", err.message || err));
  return run;
}

const walletsByAddress = new Map(targetWallets.map((w) => [w.address, w]));

// ---------------------------------------------------------------------------
// Local strategy signals (LOCAL_SIGNALS_FILE): a strategy process (e.g.
// updown-5m.js in signal mode) appends ndjson rows to a file and this engine
// executes them — same journal, risk gate, dashboard and dedupe as chain
// copies. Two deliberate differences from chain copies:
//   1. orders are placed at the SIGNAL's exact price and size ("post" rests
//      as GTC, "take" fires as FAK) — never re-priced off the book;
//   2. the drift guard is skipped — a below-market post price IS the
//      strategy, not a stale read of someone else's fill.
// A {type:"cancel", slug} row cancels every order still resting for a slug.
// ---------------------------------------------------------------------------

// BOT_SIGNALS (shared with updown-5m.js): 1 = the strategy bot writes its
// trades to updown-signals.ndjson and this copier executes them; 0 = the two
// run independently. Tailing a missing file is harmless.
const BOT_SIGNALS = process.env.BOT_SIGNALS ?? "1";
const botSignals = BOT_SIGNALS === "1" || BOT_SIGNALS.toLowerCase() === "true";
const LOCAL_SIGNALS_FILE = path.join(__dirname, "updown-signals.ndjson");
const localWallet = normalizeWallets([
  { address: "local:strategy", category: "strategy" },
])[0];
const localOrders = new Map(); // slug -> [orderIDs] resting from "post" signals
const localWarm = new Map(); // tokenID -> { tickSize, negRisk }, from "prewarm" signals

/** Resolve tick-size/neg-risk for signal tokens ahead of the first order, so
 * placing it costs one postOrder round-trip instead of three lookups. */
async function prewarmLocalTokens(assets) {
  if (isDryRun || !PRIVATE_KEY) return;
  const client = await getClobClient();
  await Promise.all(
    (assets || []).map(async (tokenID) => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          client.getTickSize(tokenID),
          client.getNegRisk(tokenID),
        ]);
        localWarm.set(tokenID, { tickSize, negRisk });
      } catch {
        /* order path resolves them lazily as before */
      }
    }),
  );
}

/** Limit BUY at an exact price/size. GTC rests on the book; FAK takes-or-kills. */
async function placeLimitAt(trade, size, price, type) {
  if (isDryRun) {
    log(
      `[DRY_RUN] would ${type} limit-BUY ${size} sh of "${trade.outcome}" ` +
        `in "${trade.slug}" @ ${price}`,
    );
    return { dryRun: true };
  }
  const client = await getClobClient();
  const order = await client.createOrder(
    { tokenID: trade.asset, price, side: client._Side.BUY, size },
    localWarm.get(trade.asset), // prewarmed {tickSize,negRisk} -> zero lookups
  );
  const resp = await client.postOrder(order, client._OrderType[type]);
  log("order response:", JSON.stringify(resp));
  if (!resp || resp.error || resp.success === false) {
    throw new Error(
      `order rejected: ${resp?.error || resp?.errorMsg || "unknown error"}`,
    );
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Strategy feedback loop: the BOT decides, this engine executes and reports.
// For every resting local order we poll fill state and push {type:"fill"}
// events back over the signal socket; the bot runs the pair logic (wait /
// cancel / sell) and sends {type:"cancel-order"} / {type:"sell"} signals,
// which are executed here blindly.
// ---------------------------------------------------------------------------

const PAIR_POLL_MS = 2000;
const localLegs = new Map(); // signal id -> { orderID, journalKey, asset, outcome, slug, size, matched, finalized }
const signalClients = new Set(); // connected bot sockets, for feedback events

function pushFeedback(event) {
  const line = JSON.stringify(event) + "\n";
  for (const conn of signalClients) {
    try {
      conn.write(line);
    } catch {
      /* dead conn is removed on its close event */
    }
  }
}

/** Sell `shares` of `asset` right now: marketable FAK limit when the 5-share/
 * $1 minimums allow, else a shares-denominated market order. */
async function sellNow(asset, shares, floorPrice) {
  const client = await getClobClient();
  const price = Math.max(0.01, Math.round(floorPrice * 100) / 100);
  if (shares >= MIN_LIMIT_SHARES && shares * price >= 1) {
    const order = await client.createOrder(
      { tokenID: asset, price, side: client._Side.SELL, size: shares },
      localWarm.get(asset),
    );
    return client.postOrder(order, client._OrderType.FAK);
  }
  const order = await client.createMarketOrder(
    { tokenID: asset, amount: shares, side: client._Side.SELL, price },
    localWarm.get(asset),
  );
  return client.postOrder(order, client._OrderType.FAK);
}

/** Refresh a leg's fill state from the exchange; report changes to the bot. */
async function refreshLeg(client, id, leg) {
  if (leg.finalized) return;
  const before = `${leg.matched}:${leg.finalized}`;
  try {
    const o = await client.getOrder(leg.orderID);
    const matched = Number(o?.size_matched);
    if (Number.isFinite(matched)) leg.matched = matched;
    const st = String(o?.status || "").toUpperCase();
    if (st === "MATCHED") {
      leg.matched = leg.size;
      leg.finalized = true;
    } else if (st === "CANCELED" || st === "CANCELLED") {
      leg.finalized = true;
    }
  } catch {
    /* transient lookup failure — keep last known state */
  }
  if (`${leg.matched}:${leg.finalized}` !== before) {
    pushFeedback({
      type: "fill",
      id,
      matched: leg.matched,
      size: leg.size,
      final: leg.finalized,
    });
  }
}

async function pairWatchTick() {
  if (isDryRun) return;
  const active = [...localLegs].filter(([, l]) => !l.finalized);
  if (active.length === 0) return;
  const client = await getClobClient().catch(() => null);
  if (!client) return;
  for (const [id, leg] of active) await refreshLeg(client, id, leg);
  // prune finalized legs after 10 minutes so the map never grows unbounded
  for (const [id, l] of localLegs) {
    if (l.finalized && Date.now() - (l.createdAt || 0) > 600000) localLegs.delete(id);
  }
}

async function handleLocalSignal(sig, state) {
  if (sig.type === "prewarm") {
    await prewarmLocalTokens(sig.assets);
    return;
  }
  // Bot-directed exit steps (rule 3 lives in the bot; we just execute):
  if (sig.type === "cancel-order") {
    const leg = localLegs.get(sig.id);
    if (!leg || isDryRun) return;
    const client = await getClobClient();
    try {
      await client.cancelOrders([leg.orderID]);
    } catch {
      /* may already be filled/gone — the refresh below reports the truth */
    }
    await refreshLeg(client, sig.id, leg);
    leg.finalized = true;
    if (leg.matched === 0) journalUpdate(leg.journalKey, { status: "failed" });
    // always report the final state so the bot's exit sequence can proceed
    pushFeedback({ type: "fill", id: sig.id, matched: leg.matched, size: leg.size, final: true });
    log(`[local] cancel-order ${sig.id}: final fill ${leg.matched}/${leg.size}`);
    return;
  }
  if (sig.type === "sell") {
    if (isDryRun) return;
    const shares = Number(sig.shares);
    const floor = Number(sig.price);
    if (!(shares > 0) || !(floor > 0) || !sig.asset) return;
    // A FAK sell can whiff when the bid vanishes in the same instant. Retry a
    // few times, chasing one tick lower per attempt — in a bail-out, being
    // flat matters more than the last cent.
    let remaining = shares;
    for (let attempt = 0; attempt < 4 && remaining > 0; attempt++) {
      const price = Math.max(0.01, Math.round((floor - attempt * 0.01) * 100) / 100);
      try {
        const resp = await sellNow(sig.asset, remaining, price);
        const sold = Number(resp?.makingAmount); // maker asset on a SELL = shares given up
        const filledShares = Number.isFinite(sold) && sold > 0 ? sold : remaining;
        remaining = Math.max(0, Math.round((remaining - filledShares) * 100) / 100);
        if (remaining === 0) break;
        log(`[local] SELL partial in ${sig.slug}: ${remaining} sh left — retrying 1 tick lower`);
      } catch (err) {
        log(`[local] SELL attempt ${attempt + 1} failed for ${sig.slug} (${err.message || err}) — retrying lower`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (remaining > 0) {
      log(`[local] SELL exhausted retries for ${sig.slug}: ${remaining} sh still held`);
    } else {
      log(`[local] SELL done: ${shares} sh of "${sig.outcome || sig.asset}" in ${sig.slug} (bot bail-out)`);
    }
    const leg = sig.legId ? localLegs.get(sig.legId) : null;
    if (leg) {
      journalUpdate(leg.journalKey, {
        hedge: { action: "bailed", shares: shares - remaining, soldAt: floor, at: Date.now() },
      });
    }
    return;
  }
  if (sig.type === "cancel") {
    const ids = localOrders.get(sig.slug) || [];
    localOrders.delete(sig.slug);
    // settle leg bookkeeping for this market: legs that never filled leave
    // the P/L stats (they cost nothing), and the poller stops tracking them
    for (const [, leg] of localLegs) {
      if (leg.slug !== sig.slug || leg.finalized) continue;
      leg.finalized = true;
      if (leg.matched === 0) journalUpdate(leg.journalKey, { status: "failed" });
    }
    if (isDryRun || ids.length === 0) return;
    try {
      const client = await getClobClient();
      await client.cancelOrders(ids);
      log(`[local] cancelled ${ids.length} resting orders for ${sig.slug}`);
    } catch (err) {
      log(`[local] cancel failed for ${sig.slug}:`, err.message || err);
    }
    return;
  }
  if (sig.type !== "buy" || !sig.asset || !sig.id) return;

  const trade = {
    proxyWallet: localWallet.address,
    transactionHash: sig.id,
    asset: sig.asset,
    conditionId: sig.conditionId || "",
    title: sig.title || sig.slug || "",
    slug: sig.slug || "",
    eventSlug: sig.slug || "",
    outcome: sig.outcome || "",
    outcomeIndex: sig.outcomeIndex ?? null,
    price: Number(sig.price),
    size: Number(sig.size),
    usdcSize: Number((Number(sig.price) * Number(sig.size)).toFixed(6)),
    side: "BUY",
    timestamp: sig.timestamp || Math.floor(Date.now() / 1000),
  };
  const key = tradeKey(trade);
  if (state.seen.has(key)) return;
  const tag = `[local:${sig.kind || "post"}]`;
  if (!journalIds.has(key)) {
    journalAdd(observedEntry(trade, localWallet, "pending"));
  }

  // stale guard: signals for 5m markets are worthless after ~2 minutes
  if (Math.floor(Date.now() / 1000) - trade.timestamp > 120) {
    state.seen.add(key);
    saveState(state);
    journalUpdate(key, { status: "stale" });
    return;
  }

  // per-bet cap: scale the size down when the signal exceeds MAX_BET_USDC
  let size = Number(sig.size);
  let cost = Number((size * trade.price).toFixed(2));
  if (cost > BET_USDC) {
    size = Math.floor((BET_USDC / trade.price) * 100) / 100;
    cost = Number((size * trade.price).toFixed(2));
  }
  if (!(trade.price > 0) || size < MIN_LIMIT_SHARES) {
    state.seen.add(key);
    saveState(state);
    journalUpdate(key, { status: "min-skip" });
    log(
      `${tag} ${trade.slug} ${trade.outcome}: ${size} sh is under the ` +
        `${MIN_LIMIT_SHARES}-share limit-order minimum — skipped`,
    );
    return;
  }

  const gate = await riskGateCheck(cost);
  if (!gate.allowed) {
    riskSnapshot.riskSkipped++;
    state.seen.add(key);
    saveState(state);
    journalUpdate(key, { status: "risk-skip", riskReason: gate.reason });
    log(`${tag} RISK SKIP ${trade.slug}: ${gate.reason}`);
    writeStatus();
    return;
  }

  try {
    const type = sig.kind === "take" ? "FAK" : "GTC";
    const resp = await placeLimitAt(trade, size, trade.price, type);
    state.seen.add(key);
    saveState(state);
    tradesPlaced++;
    const spent = Number((size * trade.price).toFixed(6)); // post: worst case; take: cap
    if (isDryRun) paperBalance -= spent;
    balanceCache = { value: null, fetchedAt: 0 };
    if (!resp.dryRun && type === "GTC" && resp.orderID) {
      const ids = localOrders.get(trade.slug) || [];
      ids.push(resp.orderID);
      localOrders.set(trade.slug, ids);
      // track the leg: fills are polled and reported back to the bot
      localLegs.set(sig.id, {
        orderID: resp.orderID,
        journalKey: key,
        asset: trade.asset,
        outcome: trade.outcome,
        slug: trade.slug,
        size,
        matched: 0,
        finalized: false,
        createdAt: Date.now(),
      });
    }
    journalUpdate(key, {
      status: "success",
      copy: {
        mode: isDryRun ? "dry" : "live",
        source: "local",
        copiedAt: Date.now(),
        spentUsdc: spent,
        shares: size,
        price: trade.price,
        orderID: resp.orderID || null,
        txHashes: resp.transactionsHashes || [],
      },
    });
    log(`${tag} placed ${type} ${size} sh ${trade.outcome} @ ${trade.price} in ${trade.slug}`);
    if (maxTrades && tradesPlaced >= maxTrades) {
      log(`MAX_TRADES limit reached (${tradesPlaced}/${maxTrades}) — stopping.`);
      writeStatus();
      process.exit(0);
    }
  } catch (err) {
    log(`${tag} FAILED ${trade.slug} ${trade.outcome}:`, err.message || err);
    // a post signal is for one moment in one 5m market — never retry it later
    state.seen.add(key);
    saveState(state);
    journalUpdate(key, {
      status: "failed",
      copy: {
        mode: isDryRun ? "dry" : "live",
        source: "local",
        copiedAt: Date.now(),
        error: String(err.message || err),
      },
    });
  }
  writeStatus();
}

/** Tail the ndjson signal file from EOF; each complete new line is a signal.
 * Push-driven: fs.watch fires the read within ~1-2ms of the bot's append; a
 * slow poll remains as a safety net for missed watch events. */
function startLocalSignals(state) {
  let offset = 0;
  try {
    offset = fs.statSync(LOCAL_SIGNALS_FILE).size; // old signals are history
  } catch {
    offset = 0;
  }
  let buf = "";
  let reading = false;

  const readNewLines = () => {
    if (reading) return; // one reader at a time; the poll re-checks anyway
    let size = 0;
    try {
      size = fs.statSync(LOCAL_SIGNALS_FILE).size;
    } catch {
      return; // file not created yet
    }
    if (size < offset) {
      offset = 0; // truncated/rotated — start over
      buf = "";
    }
    if (size === offset) return;
    reading = true;
    const stream = fs.createReadStream(LOCAL_SIGNALS_FILE, { start: offset, end: size - 1 });
    offset = size;
    let chunk = "";
    stream.on("data", (d) => (chunk += d));
    stream.on("error", () => (reading = false));
    stream.on("end", () => {
      reading = false;
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop(); // keep any trailing partial line for the next read
      for (const line of lines) {
        if (!line.trim()) continue;
        let sig;
        try {
          sig = JSON.parse(line);
        } catch {
          continue;
        }
        serialize(() => handleLocalSignal(sig, state));
      }
      readNewLines(); // catch appends that landed while we were reading
    });
  };

  // Primary path: a unix-domain socket the bot writes each signal line to —
  // sub-millisecond delivery, no filesystem in the loop. The file tail below
  // stays as the fallback/replay path; duplicates are harmless because every
  // buy signal dedupes on its id (seen set) and cancels are idempotent.
  const net = require("net");
  const SIGNAL_FILE_BASE = LOCAL_SIGNALS_FILE;
  // Cross-platform IPC endpoint: a unix socket path on macOS/Linux, a named
  // pipe on Windows (unix sockets can't be created there). Derived from the
  // project dir so two checkouts never collide.
  const SIGNAL_SOCKET =
    process.platform === "win32"
      ? "\\\\.\\pipe\\" + __dirname.replace(/[^a-zA-Z0-9]/g, "-") + "-updown-signals"
      : `${SIGNAL_FILE_BASE}.sock`;
  if (process.platform !== "win32") {
    try {
      fs.unlinkSync(SIGNAL_SOCKET); // stale unix socket from a crash
    } catch {
      /* none */
    }
  }
  try {
    const server = net.createServer((conn) => {
      signalClients.add(conn);
      conn.on("close", () => signalClients.delete(conn));
      let sbuf = "";
      conn.on("data", (d) => {
        sbuf += d;
        const lines = sbuf.split("\n");
        sbuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let sig;
          try {
            sig = JSON.parse(line);
          } catch {
            continue;
          }
          serialize(() => handleLocalSignal(sig, state));
        }
      });
      conn.on("error", () => {});
    });
    server.on("error", (err) => log(`signal socket error: ${err.message}`));
    server.listen(SIGNAL_SOCKET, () =>
      log(`local signals: socket ${SIGNAL_SOCKET} (push, <1ms) + file tail fallback`),
    );
  } catch (err) {
    log(`signal socket unavailable (${err.message}) — file tail only`);
  }

  // Fallback: watch + slow poll on the ndjson file (also replays anything
  // written while the copier was down, from EOF-at-start onward).
  const sigName = path.basename(LOCAL_SIGNALS_FILE);
  try {
    fs.watch(path.dirname(LOCAL_SIGNALS_FILE), (event, filename) => {
      if (!filename || filename === sigName) readNewLines();
    });
  } catch {
    /* polling still covers it */
  }
  setInterval(readNewLines, 250);
}

/**
 * One trade row arriving from the websocket (already activity-API shaped).
 * Mirrors the poller's pipeline: baseline guard, journal, sub-category filter,
 * staleness, dedupe, then the shared copyTrades().
 */
async function handleWsTrade(row, state) {
  const wallet = walletsByAddress.get(String(row.proxyWallet || "").toLowerCase());
  if (!wallet) return; // not a wallet we follow
  if (!state.baselined.has(wallet.address)) return; // poller baselines first
  const [buy] = filterBuys([row]);
  if (!buy) return; // sells / malformed
  const key = tradeKey(buy);
  if (state.seen.has(key)) return; // already copied/skipped (poll or ws)
  const tag = `[ws:${wallet.category}:${wallet.address}]`;

  const matches = matchesSubCategory(buy, wallet.subCategories);
  if (!journalIds.has(key)) {
    journalAdd(observedEntry(buy, wallet, matches ? "pending" : "filtered"));
  }
  if (!matches) return;

  const nowSec = Math.floor(Date.now() / 1000);
  if (wallet.maxTradeAgeSec && nowSec - (buy.timestamp || 0) > wallet.maxTradeAgeSec) {
    state.seen.add(key);
    saveState(state);
    journalUpdate(key, { status: "stale" });
    return;
  }
  await copyTrades(wallet, [buy], state, tag);
}

function startWsFeed(state) {
  const { createLiveTradeFeed } = require("./live-trades-ws.js");
  return createLiveTradeFeed({
    url: WS_URL,
    log,
    debug: WS_DEBUG === "1" || WS_DEBUG.toLowerCase() === "true",
    onStatus: (up) => {
      wsConnected = up;
      log(up ? "ws: live feed is PRIMARY signal" : "ws: feed down — poller is covering");
      writeStatus();
    },
    onTrade: (row) => {
      // cheap pre-filter before paying for the queue
      if (!walletsByAddress.has(String(row.proxyWallet || "").toLowerCase())) return;
      serialize(() => handleWsTrade(row, state));
    },
  });
}

async function pollOnce(state) {
  let netFails = 0;
  for (const wallet of targetWallets) {
    try {
      await pollUser(wallet, state);
    } catch (err) {
      log(
        `[${wallet.category}:${wallet.address}] poll error:`,
        err.message || err,
      );
      if (isNetworkError(err)) netFails++;
    }
  }
  // every wallet failed with a network error -> the API is unreachable
  if (targetWallets.length > 0 && netFails === targetWallets.length) {
    consecutiveNetFails++;
    if (fetchFailLimit && consecutiveNetFails >= fetchFailLimit) {
      shutdownViaYarnDown(
        `${consecutiveNetFails} consecutive polls failed with network errors ` +
          `(FETCH_FAIL_LIMIT=${fetchFailLimit})`,
      );
    }
  } else {
    consecutiveNetFails = 0;
  }
}

async function main() {
  if (targetWallets.length === 0 && !botSignals) {
    console.error(
      "target-wallets.js is empty — add at least one {address, category}, " +
        "or enable BOT_SIGNALS=1 to run on strategy-bot signals alone",
    );
    process.exit(1);
  }
  if (targetWallets.length === 0) {
    log("no target wallets — running on strategy-bot signals only (BOT_SIGNALS=1)");
  }
  if (!isDryRun && (!PRIVATE_KEY || !FUNDER_ADDRESS)) {
    console.error(
      "PRIVATE_KEY and FUNDER_ADDRESS are required unless DRY_RUN=1",
    );
    process.exit(1);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!isDryRun && nodeMajor < 20) {
    console.error(
      `Node ${process.versions.node} is too old for live orders — ` +
        `@polymarket/clob-client-v2 requires Node >= 20.10. Please upgrade Node.`,
    );
    process.exit(1);
  }
  if (!Number.isFinite(BET_USDC) || BET_USDC < MIN_ORDER_USDC) {
    console.error(
      `MAX_BET_USDC must be a number >= ${MIN_ORDER_USDC} (Polymarket minimum)`,
    );
    process.exit(1);
  }
  if (driftGuard) {
    for (const [name, v] of [
      ["MAX_ADVERSE_DRIFT", maxAdverseDrift],
      ["MAX_OVERPAY", maxOverpay],
    ]) {
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        console.error(`${name} must be a number between 0 and 1 (got "${v}")`);
        process.exit(1);
      }
    }
    if (!PRIVATE_KEY) {
      log(
        "WARNING: DRIFT_GUARD is on but PRIVATE_KEY is unset, so the order book " +
          "cannot be read — the price-deviation gate will NOT run. Dry-run results " +
          "will overstate what a guarded live run would take.",
      );
    }
  } else {
    log(
      "WARNING: DRIFT_GUARD=0 — orders will be placed at any price the book " +
        "offers, however far it has moved from the trader's price.",
    );
  }

  log(
    `copy-trader started: targets=[${targetWallets
      .map(
        (w) =>
          `${w.category}:${w.address}` +
          (w.subCategories.length ? ` (subs: ${w.subCategories.join("|")})` : ""),
      )
      .join(
        ", ",
      )}] interval=${pollInterval}ms bet=${
        (mirrorBet
          ? `mirror ${mirrorShares ? "shares" : "$"} (cap $${BET_USDC})`
          : `$${BET_USDC} (fixed)`) +
          ` · ${useLimitOrders ? "limit" : "market"} orders`
      } dryRun=${isDryRun} ` +
      `maxTrades=${maxTrades || "unlimited"} ` +
      `skipBelowMin=${skipBelowMin ? "on" : "off"} ` +
      `driftGuard=${
        driftGuard ? `-${maxAdverseDrift}/+${maxOverpay}` : "off"
      }`,
  );

  const state = loadState();
  writeStatus();

  // Build the CLOB client before the first signal arrives. Deriving API creds is
  // a signature plus a round-trip, and it would otherwise land on the first
  // trade's critical path — the one moment latency costs money. Non-fatal: if it
  // fails here, the normal lazy path retries and reports errors as it always did.
  if (PRIVATE_KEY) {
    const t0 = Date.now();
    try {
      await getClobClient();
      log(`clob client ready (warmed in ${Date.now() - t0}ms)`);
    } catch (err) {
      log(`clob client warm-up failed (${err.message}) — will retry on first use`);
    }
  }

  // Populate the resolution cache before any signal can arrive. The ws feed
  // starts below and can copy before the first poll completes, and an empty
  // cache makes every past position look unresolved — which would over-count
  // active exposure and could gate the first trade for no reason.
  await warmResolutions();

  if (wsEnabled) {
    startWsFeed(state);
    log(`ws: real-time feed enabled (${WS_URL}) — poller runs as fallback`);
  }

  if (botSignals) {
    startLocalSignals(state);
    if (!isDryRun) {
      setInterval(() => {
        pairWatchTick().catch((err) => log("pair watch error:", err.message || err));
      }, PAIR_POLL_MS);
      log("fill reporter active: leg fills stream back to the bot; bot drives cancel/sell");
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // through the same queue as ws events, so the two sources never interleave
    await serialize(() => pollOnce(state));
    writeStatus();
    // Refresh resolutions while we are idle anyway, overlapping the sleep so it
    // costs no wall-clock and never delays a copy. Settling mutates the journal,
    // so it goes through the same queue as poll/ws work.
    await Promise.all([
      new Promise((r) => setTimeout(r, pollInterval)),
      warmResolutions(),
    ]);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  filterBuys,
  pickNewTrades,
  betAmount,
  shareAmount,
  limitPriceFor,
  tradeKey,
  normalizeWallets,
  splitStale,
  matchesSubCategory,
  oldestFirst,
  prunedJournal,
  resumedSkipCounts,
  bestAsk,
  driftVerdict,
  marketOrderArgs,
  pollUser,
  riskGateCheck,
  getActiveUsdc,
  parseLiveFill,
  handleWsTrade,
  handleLocalSignal,
  TARGET_WALLETS,
};
