/**
 * Polymarket copy-trader (test version)
 *
 * - Listens to the real-time websocket trade feed for the target user's trades
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
  CLOB_API_HOST = "https://clob.polymarket.com",
  TARGET_USERS, // optional env override (comma-separated addresses), mainly for tests
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  SIGNATURE_TYPE = "1",
  MAX_BET_USDC = "1",
  MIRROR_TRADER_BET = "0", // 1 = bet what the trader bet (capped by MAX_BET_USDC)
  SKIP_BELOW_MIN = "0", // 1 = in mirror mode, skip trades under Polymarket's $1 minimum instead of rounding up to $1
  MAX_TRADES = "0", // stop after this many placed trades (0 = unlimited)
  MAX_ACTIVE_PCT = "50", // cap: active bets <= this % of (balance + active). 0 = gate disabled
  MAX_ENTRY_PRICE = "0.85", // skip entries above this price (upside < realistic slippage). 0 = off
  MIN_ENTRY_PRICE = "0", // skip entries below this price (lottery tickets). 0 = off
  ONE_SIDE_PER_MARKET = "1", // 1 = never buy the opposite outcome of a market we're already in
  MAX_COPIES_PER_MARKET = "0", // stop copying a market after N fills (0 = unlimited)
  LOG_THEIR_SELLS = "1", // 1 = journal the target's SELLs (observe-only) so exits are measurable
  USE_BOOK_PRICE = "1", // 1 = read our real ask before copying: dry-run fills there, live records slippage
  MAX_SLIPPAGE_CENTS = "1.5", // skip when our ask is this many cents worse than their fill. 0 = off
  DRY_RUN_BALANCE_USDC = "100", // paper balance used by the risk gate in dry-run
  RESOLUTION_RECHECK_MS = "60000", // how often unresolved markets are re-checked
  BASELINE_WINDOW_MS = "120000", // after startup, journal trades as baseline (no copying) for this long. 0 = off
  WS_URL = "wss://ws-live-data.polymarket.com",
  WS_DEBUG = "0", // 1 = log every raw ws message (verbose; first 3 after connect are always logged)
  DRY_RUN = "0",
  SEEN_FILE = path.join(__dirname, "seen-trades.json"),
  TRADES_LOG_FILE = path.join(__dirname, "trades-log.json"),
  STATUS_FILE = path.join(__dirname, "status.json"),
} = process.env;

const CHAIN_ID = 137; // Polygon mainnet
const MIN_ORDER_USDC = 1; // Polymarket minimum for market orders
const BET_USDC = Number(MAX_BET_USDC); // USDC spent per copied bet (from env, default $1)

const isDryRun = DRY_RUN === "1" || DRY_RUN.toLowerCase() === "true";
const maxActivePct = Math.max(0, Number(MAX_ACTIVE_PCT) || 0); // 0 = disabled
const mirrorBet = MIRROR_TRADER_BET === "1" || MIRROR_TRADER_BET.toLowerCase() === "true";
const skipBelowMin = SKIP_BELOW_MIN === "1" || SKIP_BELOW_MIN.toLowerCase() === "true";
const maxTrades = Number(MAX_TRADES) || 0; // 0 = unlimited
const maxEntryPrice = Math.max(0, Number(MAX_ENTRY_PRICE) || 0); // 0 = disabled
const minEntryPrice = Math.max(0, Number(MIN_ENTRY_PRICE) || 0); // 0 = disabled
const oneSidePerMarket =
  ONE_SIDE_PER_MARKET === "1" || ONE_SIDE_PER_MARKET.toLowerCase() === "true";
const maxCopiesPerMarket = Math.max(0, Number(MAX_COPIES_PER_MARKET) || 0); // 0 = unlimited
const logTheirSells =
  LOG_THEIR_SELLS === "1" || LOG_THEIR_SELLS.toLowerCase() === "true";
const useBookPrice =
  USE_BOOK_PRICE === "1" || USE_BOOK_PRICE.toLowerCase() === "true";
const maxSlippageCents = Math.max(0, Number(MAX_SLIPPAGE_CENTS) || 0); // 0 = disabled
let tradesPlaced = 0;

// Startup baseline window: for the first BASELINE_WINDOW_MS after boot, target
// trades are journaled and marked seen but NOT copied — the engine observes
// only, so it never chases positions it didn't watch develop from the start.
const baselineWindowMs = Math.max(0, Number(BASELINE_WINDOW_MS) || 0);
const bootAt = Date.now();
const inBaselineWindow = () => Date.now() - bootAt < baselineWindowMs;

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
      // legacy format: plain array of seen keys
      return { seen: new Set(raw) };
    }
    return { seen: new Set(raw.seen || []) };
  } catch {
    return { seen: new Set() };
  }
}

function saveState(state) {
  writeJsonAtomic(SEEN_FILE, { seen: [...state.seen] });
}

function tradeKey(t) {
  return `${t.transactionHash}:${t.asset}`;
}

// ---------------------------------------------------------------------------
// Trade journal + status (read by the dashboard)
// ---------------------------------------------------------------------------

// Rows WITHOUT a copy attempt (baseline/filtered/stale/pending) rotate in a
// small pool so observation churn can't bloat the journal. Rows WITH a copy
// attempt are NEVER evicted — the full lifetime copy history is kept.
const MAX_OBSERVED_ENTRIES = 300;

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

/** Evict oldest observed-only rows past the cap. Copied rows are never evicted. */
function trimJournal() {
  const isObserved = (e) => !e.copy;
  let count = journal.reduce((n, e) => n + (isObserved(e) ? 1 : 0), 0);
  for (let i = journal.length - 1; i >= 0 && count > MAX_OBSERVED_ENTRIES; i--) {
    if (isObserved(journal[i])) {
      journalIds.delete(journal[i].id);
      journal.splice(i, 1);
      count--;
    }
  }
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

// Last risk-gate snapshot, surfaced to the dashboard via status.json
let riskSnapshot = { balance: null, activeUsdc: null, riskSkipped: 0 };

function writeStatus() {
  try {
    writeJsonAtomic(STATUS_FILE, {
      mode: isDryRun ? "dry" : "live",
      betUsdc: BET_USDC,
      betMode: mirrorBet ? "mirror" : "fixed",
      maxTrades,
      tradesPlaced,
      targets: targetWallets,
      startedAt: engineStartedAt,
      maxActivePct,
      maxEntryPrice,
      minEntryPrice,
      oneSidePerMarket,
      maxCopiesPerMarket,
      maxSlippageCents,
      useBookPrice,
      wsConnected,
      paperBalance: isDryRun ? paperBalance : undefined,
      balance: riskSnapshot.balance,
      activeUsdc: riskSnapshot.activeUsdc,
      riskSkipped: riskSnapshot.riskSkipped,
      updatedAt: Date.now(),
    });
  } catch (err) {
    log("failed to write status file:", err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP helper (used by the market-resolution cache)
// ---------------------------------------------------------------------------

/** GET a JSON URL. Uses global fetch (Node 18+) or falls back to http/https (Node 16). */
function getJson(url) {
  if (typeof fetch === "function") {
    return fetch(url, {
      headers: { accept: "application/json, text/plain, */*" },
    }).then((res) => {
      if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
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
            new Error(`API ${res.statusCode} ${res.statusMessage}`),
          );
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`API returned invalid JSON: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("API timeout")));
  });
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
 * Entry-price guard. Above maxEntryPrice the best case is smaller than a
 * realistic fill cost (at 0.98 the whole upside is 2c); below minEntryPrice
 * we're buying lottery tickets. Returns null when the entry is allowed,
 * otherwise the reason string.
 */
function priceBandReject(
  price,
  { max = maxEntryPrice, min = minEntryPrice } = {},
) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null; // unknown price -> other guards decide
  if (max && p > max) return `entry ${p} above MAX_ENTRY_PRICE ${max}`;
  if (min && p < min) return `entry ${p} below MIN_ENTRY_PRICE ${min}`;
  return null;
}

/**
 * Copies we already hold in a market, from the journal: { shares, assets }.
 * `open` rows only — a settled market is a clean slate.
 */
function openCopiesInMarket(conditionId, copies) {
  return (copies || []).filter(
    (e) => e.conditionId && e.conditionId === conditionId && !e.copy.settled,
  );
}

/**
 * Buying both outcomes of the same market is a self-hedge: N shares of Up plus
 * N of Down cost more than the $N they are guaranteed to pay back. The target
 * can do it because they SELL to flatten; a buy-only copier just burns the
 * spread. Returns a reason string when this trade would open the other side.
 */
function hedgeReject(trade, copies, { enabled = oneSidePerMarket } = {}) {
  if (!enabled) return null;
  const held = openCopiesInMarket(trade.conditionId, copies).find(
    (e) => e.asset && e.asset !== trade.asset,
  );
  return held
    ? `already long "${held.outcome}" in this market — not buying "${trade.outcome}" against it`
    : null;
}

/** Per-market fill cap: keeps one market from eating the whole bankroll. */
function marketCapReject(trade, copies, { max = maxCopiesPerMarket } = {}) {
  if (!max) return null;
  const n = openCopiesInMarket(trade.conditionId, copies).length;
  return n >= max ? `already ${n} copies in this market (MAX_COPIES_PER_MARKET=${max})` : null;
}

/** How much worse (in cents) our ask is than the price they filled at. */
function slippageCents(ourPrice, theirPrice) {
  if (ourPrice == null || theirPrice == null) return null;
  const a = Number(ourPrice);
  const b = Number(theirPrice);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Number(((a - b) * 100).toFixed(2));
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

const ASK_TIMEOUT_MS = 1500; // a stale quote is worse than no quote

/**
 * The price WE would pay right now: best ask from the CLOB book. Copying is
 * ~1s behind the target, so their fill price is not our fill price — this is
 * the number that decides whether the edge survives. Returns null on any
 * failure (fail-open: the copy proceeds on their price, unpriced).
 */
async function getAskPrice(tokenId) {
  if (!useBookPrice || !tokenId) return null;
  try {
    const url = `${CLOB_API_HOST}/price?token_id=${tokenId}&side=buy`;
    const json = await Promise.race([
      getJson(url),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("ask timeout")), ASK_TIMEOUT_MS),
      ),
    ]);
    const p = Number(json?.price);
    return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
  } catch {
    return null;
  }
}

async function placeMarketBuy(trade, amountUsdc, entryPrice) {
  if (isDryRun) {
    log(
      `[DRY_RUN] would market-BUY $${amountUsdc} of "${trade.outcome}" ` +
        `in "${trade.title}" (token ${trade.asset}, their price ${trade.price}` +
        `${entryPrice != null && entryPrice !== trade.price ? `, our ask ${entryPrice}` : ""})`,
    );
    return { dryRun: true };
  }

  const client = await getClobClient();
  // FAK (fill-and-kill): take whatever liquidity is available at the computed
  // market price and cancel the rest — partial directional exposure beats the
  // all-or-nothing FOK, which fails exactly when fast markets move.
  const order = await client.createMarketOrder({
    tokenID: trade.asset,
    amount: amountUsdc, // USDC to spend for a BUY market order
    side: client._Side.BUY,
    orderType: client._OrderType.FAK,
  });
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
  await refreshResolutions();
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
    status, // baseline | filtered | stale | pending | their-sell | min-skip
    // | hedge-skip | market-skip | price-skip | slippage-skip | risk-skip
    // | success | failed
    copy: null, // filled in when we attempt the copy
  };
}

/**
 * Record a trade we deliberately did not copy and never look at it again.
 * Chasing a skipped trade later, at a moved price, is worse than missing it.
 */
function skipTrade(trade, wallet, state, status, reason, tag) {
  state.seen.add(tradeKey(trade));
  saveState(state);
  journalUpdate(
    tradeKey(trade),
    { status, skipReason: reason },
    observedEntry(trade, wallet, status),
  );
  log(`${tag} ${status.toUpperCase()} "${trade.title}": ${reason}`);
}

/** Copy a batch of fresh, non-stale BUY trades from the ws feed. */
async function copyTrades(wallet, copyable, state, tag) {
  const source = "ws"; // recorded per copy for latency stats
  for (const trade of copyable) {
    if (maxTrades && tradesPlaced >= maxTrades) return;

    // The feed can deliver several rows with the same txHash:asset (partial
    // fills of one order). Dedupe ran before this loop, so a key that is in
    // `seen` now was copied earlier in THIS batch — never copy it twice.
    if (state.seen.has(tradeKey(trade))) continue;

    // Exact mirroring below Polymarket's $1 order minimum is impossible —
    // optionally skip those trades instead of rounding the bet up to $1.
    if (
      mirrorBet &&
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

    // Self-hedge guard: never take the other side of a market we're in.
    const copies = successfulCopies();
    const hedge = hedgeReject(trade, copies);
    if (hedge) {
      skipTrade(trade, wallet, state, "hedge-skip", hedge, tag);
      continue;
    }
    const capped = marketCapReject(trade, copies);
    if (capped) {
      skipTrade(trade, wallet, state, "market-skip", capped, tag);
      continue;
    }

    // What WE would pay, not what they paid. Null = book unavailable.
    const ask = await getAskPrice(trade.asset);
    const entryPrice = ask ?? trade.price;
    const slip = ask == null ? null : slippageCents(ask, trade.price);

    const band = priceBandReject(entryPrice);
    if (band) {
      skipTrade(trade, wallet, state, "price-skip", band, tag);
      continue;
    }
    if (maxSlippageCents && slip != null && slip > maxSlippageCents) {
      skipTrade(
        trade,
        wallet,
        state,
        "slippage-skip",
        `our ask ${ask} is ${slip}c worse than their ${trade.price} ` +
          `(MAX_SLIPPAGE_CENTS=${maxSlippageCents})`,
        tag,
      );
      continue;
    }

    const amount = betAmount(trade);

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

    log(
      `${tag} new BUY: "${trade.title}" / ${trade.outcome} ` +
        `@ ${trade.price} ($${trade.usdcSize}) -> copying with $${amount}`,
    );
    try {
      const resp = await placeMarketBuy(trade, amount, entryPrice);
      const fill = resp.dryRun ? null : parseLiveFill(resp, amount);
      state.seen.add(tradeKey(trade));
      saveState(state);
      tradesPlaced++;
      const spent = resp.dryRun ? amount : fill.spent;
      if (isDryRun) paperBalance -= spent; // paper: debit like a real fill
      balanceCache = { value: null, fetchedAt: 0 }; // live: balance changed, re-fetch
      // Dry-run fills at OUR ask, not their price: a paper edge measured at
      // their fill price is the edge we do not get.
      const shares = resp.dryRun
        ? entryPrice > 0
          ? amount / entryPrice
          : 0
        : fill.shares;
      journalUpdate(
        tradeKey(trade),
        {
          status: "success",
          // Refresh the trader-side snapshot: the trade row can grow between
          // first observation and the copy (fills aggregate), and betAmount used
          // the values at copy time — the journal must show the same numbers.
          theirPrice: trade.price,
          theirUsdc: trade.usdcSize,
          theirShares: trade.size,
          copy: {
            mode: isDryRun ? "dry" : "live",
            source, // which pipeline delivered the signal
            copiedAt: Date.now(),
            spentUsdc: Number(spent.toFixed(6)),
            shares: Number(shares.toFixed(4)),
            price: shares > 0 ? Number((spent / shares).toFixed(4)) : trade.price,
            bookAsk: ask, // our quote at copy time (null = book unavailable)
            slippageCents:
              shares > 0 ? slippageCents(spent / shares, trade.price) : slip,
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
      // not marked seen — but the ws feed never redelivers a trade, so a
      // failed copy is not retried
    }
  }
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
// Real-time websocket feed (sole signal) + serialization
// ---------------------------------------------------------------------------

let wsConnected = false;

// ws events share mutable state (seen set, journal, gate, tradesPlaced).
// Everything flows through one serial queue so two events can never
// interleave mid-copy and double-copy or race the risk gate.
let workQueue = Promise.resolve();
function serialize(fn) {
  const run = workQueue.then(fn);
  workQueue = run.catch((err) => log("queued task error:", err.message || err));
  return run;
}

const walletsByAddress = new Map(targetWallets.map((w) => [w.address, w]));

/**
 * One trade row arriving from the websocket (already activity-API shaped).
 * Pipeline: journal, sub-category filter, staleness, dedupe, then copyTrades().
 */
async function handleWsTrade(row, state) {
  const wallet = walletsByAddress.get(String(row.proxyWallet || "").toLowerCase());
  if (!wallet) return; // not a wallet we follow
  // Their exits are the half of the strategy a buy-only copier never sees.
  // We don't mirror them (we hold to resolution) but we log them, so
  // "do they flatten before expiry?" is answerable from the journal.
  if (String(row.side || "").toUpperCase() === "SELL") {
    if (
      logTheirSells &&
      row.transactionHash &&
      row.asset &&
      matchesSubCategory(row, wallet.subCategories)
    ) {
      journalAdd(observedEntry(row, wallet, "their-sell"));
    }
    return;
  }
  const [buy] = filterBuys([row]);
  if (!buy) return; // sells / malformed
  const key = tradeKey(buy);
  if (state.seen.has(key)) return; // already copied/skipped
  const tag = `[ws:${wallet.category}:${wallet.address}]`;

  // Startup baseline window: observe and record, never copy.
  if (inBaselineWindow()) {
    state.seen.add(key);
    saveState(state);
    journalAdd(observedEntry(buy, wallet, "baseline"));
    log(
      `${tag} baseline: observed "${buy.title}" / ${buy.outcome} — not copying ` +
        `(${Math.ceil((baselineWindowMs - (Date.now() - bootAt)) / 1000)}s left in window)`,
    );
    return;
  }

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
      log(up ? "ws: live feed connected" : "ws: feed down — reconnecting");
      writeStatus();
    },
    onTrade: (row) => {
      // cheap pre-filter before paying for the queue
      if (!walletsByAddress.has(String(row.proxyWallet || "").toLowerCase())) return;
      serialize(() => handleWsTrade(row, state));
    },
  });
}

// Heartbeat: keep status.json fresh so the dashboard can tell we're alive
const HEARTBEAT_MS = 10000;

async function main() {
  if (targetWallets.length === 0) {
    console.error(
      "target-wallets.js is empty — add at least one {address, category}",
    );
    process.exit(1);
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

  log(
    `copy-trader started: targets=[${targetWallets
      .map(
        (w) =>
          `${w.category}:${w.address}` +
          (w.subCategories.length ? ` (subs: ${w.subCategories.join("|")})` : ""),
      )
      .join(
        ", ",
      )}] bet=${
        mirrorBet ? `mirror (cap $${BET_USDC})` : `$${BET_USDC} (fixed)`
      } dryRun=${isDryRun} ` +
      `maxTrades=${maxTrades || "unlimited"} ` +
      `skipBelowMin=${skipBelowMin ? "on" : "off"}`,
  );

  const state = loadState();
  writeStatus();

  startWsFeed(state);
  log(`ws: real-time trade feed is the sole signal (${WS_URL})`);
  if (baselineWindowMs > 0) {
    log(
      `baseline window: observing only for the first ${baselineWindowMs / 1000}s — no copies until it ends`,
    );
    setTimeout(
      () => log("baseline window over — copying enabled"),
      baselineWindowMs,
    );
  }

  setInterval(() => {
    // through the queue so a status write can't observe a half-applied copy
    serialize(writeStatus);
  }, HEARTBEAT_MS);
}

if (require.main === module) {
  main();
}

module.exports = {
  filterBuys,
  pickNewTrades,
  betAmount,
  tradeKey,
  normalizeWallets,
  splitStale,
  matchesSubCategory,
  priceBandReject,
  hedgeReject,
  marketCapReject,
  slippageCents,
  riskGateCheck,
  getActiveUsdc,
  parseLiveFill,
  handleWsTrade,
  TARGET_WALLETS,
};
