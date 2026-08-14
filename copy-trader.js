/**
 * Polymarket copy-trader (test version)
 *
 * - Polls the activity API every POLL_INTERVAL_MS for the target user's trades
 * - Filters to BUY trades only
 * - Dedupes by transactionHash + asset (persisted to seen-trades.json)
 * - Mirrors each new trade as a FOK market BUY order via the CLOB client
 * - Every copied bet spends a fixed MAX_BET_USDC (env, default $1), regardless of their trade size
 * - DRY_RUN=1 logs orders instead of placing them
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Wallets to copy — edit this list to add/remove users
// ---------------------------------------------------------------------------

const TARGET_WALLETS = [
  // {
  //   address: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
  //   category: "crypto",
  //   sub_category: ["btc"],
  // },
  {
    address: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
    category: "crypto",
    sub_category: ["btc"],
  },
];

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
  MAX_TRADES = "0", // stop after this many placed trades (0 = unlimited)
  MAX_TRADE_AGE_SEC = "120", // skip trades older than this (avoids expired fast markets)
  DRY_RUN = "0",
  SEEN_FILE = path.join(__dirname, "seen-trades.json"),
  TRADES_LOG_FILE = path.join(__dirname, "trades-log.json"),
  STATUS_FILE = path.join(__dirname, "status.json"),
} = process.env;

const CHAIN_ID = 137; // Polygon mainnet
const MIN_ORDER_USDC = 1; // Polymarket minimum for market orders
const BET_USDC = Number(MAX_BET_USDC); // USDC spent per copied bet (from env, default $1)

const isDryRun = DRY_RUN === "1" || DRY_RUN.toLowerCase() === "true";
const mirrorBet = MIRROR_TRADER_BET === "1" || MIRROR_TRADER_BET.toLowerCase() === "true";
const pollInterval = Number(POLL_INTERVAL_MS);
const maxTrades = Number(MAX_TRADES) || 0; // 0 = unlimited
const maxTradeAgeSec = Number(MAX_TRADE_AGE_SEC) || 120;
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

/** Write JSON atomically (tmp file + rename) so a mid-write crash can't corrupt it. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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
function writeStatus() {
  try {
    writeJsonAtomic(STATUS_FILE, {
      mode: isDryRun ? "dry" : "live",
      betUsdc: BET_USDC,
      betMode: mirrorBet ? "mirror" : "fixed",
      pollIntervalMs: pollInterval,
      maxTrades,
      tradesPlaced,
      targets: targetWallets,
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
    `${DATA_API_HOST}/activity?limit=100&offset=0` +
    `&excludeDepositsWithdrawals=true&sortBy=TIMESTAMP&sortDirection=DESC` +
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
  const { ClobClient, Side, OrderType } =
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
  return clobClient;
}

async function placeMarketBuy(trade, amountUsdc) {
  if (isDryRun) {
    log(
      `[DRY_RUN] would market-BUY $${amountUsdc} of "${trade.outcome}" ` +
        `in "${trade.title}" (token ${trade.asset}, their price ${trade.price})`,
    );
    return { dryRun: true };
  }

  const client = await getClobClient();
  const order = await client.createMarketOrder({
    tokenID: trade.asset,
    amount: amountUsdc, // USDC to spend for a BUY market order
    side: client._Side.BUY,
    orderType: client._OrderType.FOK,
  });
  const resp = await client.postOrder(order, client._OrderType.FOK);
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
    status, // baseline | filtered | stale | pending | success | failed
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
    allBuys.forEach((t) => journalAdd(observedEntry(t, wallet, "baseline")));
    log(`${tag} baseline: marked ${fresh.length} existing BUY trades as seen`);
    return;
  }

  // Journal every newly observed buy, including ones we won't copy
  for (const t of allBuys) {
    if (journalIds.has(tradeKey(t))) continue;
    const status = matchesSubCategory(t, wallet.subCategories)
      ? "pending"
      : "filtered";
    journalAdd(observedEntry(t, wallet, status));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const { copyable, stale } = splitStale(fresh, nowSec, maxTradeAgeSec);

  // Too old to chase (fast markets expire) — mark seen so we never retry them
  if (stale.length > 0) {
    stale.forEach((t) => {
      state.seen.add(tradeKey(t));
      journalUpdate(tradeKey(t), { status: "stale" });
    });
    saveState(state);
    log(
      `${tag} skipped ${stale.length} stale trade(s) older than ${maxTradeAgeSec}s`,
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

  for (const trade of copyable) {
    if (maxTrades && tradesPlaced >= maxTrades) return;
    const amount = betAmount(trade);
    log(
      `${tag} new BUY: "${trade.title}" / ${trade.outcome} ` +
        `@ ${trade.price} ($${trade.usdcSize}) -> copying with $${amount}`,
    );
    try {
      const resp = await placeMarketBuy(trade, amount);
      state.seen.add(tradeKey(trade));
      saveState(state);
      tradesPlaced++;
      const spent = resp.dryRun ? amount : Number(resp.makingAmount) || amount;
      const shares = resp.dryRun
        ? trade.price > 0
          ? amount / trade.price
          : 0
        : Number(resp.takingAmount) || 0;
      journalUpdate(
        tradeKey(trade),
        {
          status: "success",
          copy: {
            mode: isDryRun ? "dry" : "live",
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

async function pollOnce(state) {
  for (const wallet of targetWallets) {
    try {
      await pollUser(wallet, state);
    } catch (err) {
      log(
        `[${wallet.category}:${wallet.address}] poll error:`,
        err.message || err,
      );
    }
  }
}

async function main() {
  if (targetWallets.length === 0) {
    console.error(
      "TARGET_WALLETS in copy-trader.js is empty — add at least one {address, category}",
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
      )}] interval=${pollInterval}ms bet=${
        mirrorBet ? `mirror (cap $${BET_USDC})` : `$${BET_USDC} (fixed)`
      } dryRun=${isDryRun} ` +
      `maxTrades=${maxTrades || "unlimited"}`,
  );

  const state = loadState();
  writeStatus();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce(state);
    writeStatus();
    await new Promise((r) => setTimeout(r, pollInterval));
  }
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
  TARGET_WALLETS,
};
