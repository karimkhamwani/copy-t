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
  {
    address: "0x30c7ac0158499ddc6761047f7f69bcf7d036ac3b",
    category: "esports",
  },
];

const {
  DATA_API_HOST = "https://data-api.polymarket.com",
  CLOB_API_HOST = "https://clob.polymarket.com",
  TARGET_USERS, // optional env override (comma-separated addresses), mainly for tests
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  SIGNATURE_TYPE = "1",
  POLL_INTERVAL_MS = "30000",
  MAX_BET_USDC = "1",
  DRY_RUN = "0",
  SEEN_FILE = path.join(__dirname, "seen-trades.json"),
} = process.env;

const CHAIN_ID = 137; // Polygon mainnet
const MIN_ORDER_USDC = 1; // Polymarket minimum for market orders
const BET_USDC = Number(MAX_BET_USDC); // USDC spent per copied bet (from env, default $1)

const isDryRun = DRY_RUN === "1" || DRY_RUN.toLowerCase() === "true";
const pollInterval = Number(POLL_INTERVAL_MS);

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
    out.push({ address, category: w.category || "uncategorized" });
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
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify(
      { seen: [...state.seen], baselined: [...state.baselined] },
      null,
      2,
    ),
  );
}

function tradeKey(t) {
  return `${t.transactionHash}:${t.asset}`;
}

// ---------------------------------------------------------------------------
// Activity API
// ---------------------------------------------------------------------------

async function fetchActivity(user) {
  const url =
    `${DATA_API_HOST}/activity?limit=100&offset=0` +
    `&excludeDepositsWithdrawals=true&sortBy=TIMESTAMP&sortDirection=DESC` +
    `&user=${user}`;
  const res = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*" },
  });
  if (!res.ok) throw new Error(`activity API ${res.status} ${res.statusText}`);
  const data = await res.json();
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

/** Fixed bet per copied trade: MAX_BET_USDC from env (ignores their trade size). */
function betAmount() {
  return BET_USDC;
}

// ---------------------------------------------------------------------------
// Order placement (CLOB)
// ---------------------------------------------------------------------------

let clobClient = null;

async function getClobClient() {
  if (clobClient) return clobClient;

  const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
  const { Wallet } = require("@ethersproject/wallet");

  const signer = new Wallet(PRIVATE_KEY);
  const sigType = Number(SIGNATURE_TYPE);

  // First client only to derive API creds, then the real one with creds
  const bootstrap = new ClobClient(
    CLOB_API_HOST,
    CHAIN_ID,
    signer,
    undefined,
    sigType,
    FUNDER_ADDRESS,
  );
  const creds = await bootstrap.createOrDeriveApiKey();
  clobClient = new ClobClient(
    CLOB_API_HOST,
    CHAIN_ID,
    signer,
    creds,
    sigType,
    FUNDER_ADDRESS,
  );
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
  return resp;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function pollUser(wallet, state) {
  const { address, category } = wallet;
  const tag = `[${category}:${address}]`;
  const activity = await fetchActivity(address);
  const buys = filterBuys(activity);
  const fresh = pickNewTrades(buys, state.seen);

  if (!state.baselined.has(address)) {
    // First time we watch this wallet: record its existing history as seen,
    // only copy trades it makes from now on.
    fresh.forEach((t) => state.seen.add(tradeKey(t)));
    state.baselined.add(address);
    saveState(state);
    log(`${tag} baseline: marked ${fresh.length} existing BUY trades as seen`);
    return;
  }

  if (fresh.length === 0) {
    log(`${tag} no new BUY trades (${buys.length} buys in window)`);
    return;
  }

  // Oldest first so we copy in the order they traded
  fresh.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  for (const trade of fresh) {
    const amount = betAmount();
    log(
      `${tag} new BUY: "${trade.title}" / ${trade.outcome} ` +
        `@ ${trade.price} ($${trade.usdcSize}) -> copying with $${amount}`,
    );
    try {
      await placeMarketBuy(trade, amount);
      state.seen.add(tradeKey(trade));
      saveState(state);
    } catch (err) {
      log(
        `${tag} FAILED to place order for ${tradeKey(trade)}:`,
        err.message || err,
      );
      // not marked seen -> retried next poll
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
  if (!Number.isFinite(BET_USDC) || BET_USDC < MIN_ORDER_USDC) {
    console.error(
      `MAX_BET_USDC must be a number >= ${MIN_ORDER_USDC} (Polymarket minimum)`,
    );
    process.exit(1);
  }

  log(
    `copy-trader started: targets=[${targetWallets
      .map((w) => `${w.category}:${w.address}`)
      .join(
        ", ",
      )}] interval=${pollInterval}ms bet=$${BET_USDC} (fixed) dryRun=${isDryRun}`,
  );

  const state = loadState();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce(state);
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
  TARGET_WALLETS,
};
