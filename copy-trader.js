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
    address: "0x0cb038487586d1119b165466072e9baf666f3a90",
    category: "crypto",
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
  MAX_TRADES = "0", // stop after this many placed trades (0 = unlimited)
  DRY_RUN = "0",
  SEEN_FILE = path.join(__dirname, "seen-trades.json"),
} = process.env;

const CHAIN_ID = 137; // Polygon mainnet
const MIN_ORDER_USDC = 1; // Polymarket minimum for market orders
const BET_USDC = Number(MAX_BET_USDC); // USDC spent per copied bet (from env, default $1)

const isDryRun = DRY_RUN === "1" || DRY_RUN.toLowerCase() === "true";
const pollInterval = Number(POLL_INTERVAL_MS);
const maxTrades = Number(MAX_TRADES) || 0; // 0 = unlimited
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

/** GET a JSON URL. Uses global fetch (Node 18+) or falls back to http/https (Node 16). */
function getJson(url) {
  if (typeof fetch === "function") {
    return fetch(url, {
      headers: { accept: "application/json, text/plain, */*" },
    }).then((res) => {
      if (!res.ok) throw new Error(`activity API ${res.status} ${res.statusText}`);
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
          return reject(new Error(`activity API ${res.statusCode} ${res.statusMessage}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`activity API returned invalid JSON: ${err.message}`));
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
    if (maxTrades && tradesPlaced >= maxTrades) return;
    const amount = betAmount();
    log(
      `${tag} new BUY: "${trade.title}" / ${trade.outcome} ` +
        `@ ${trade.price} ($${trade.usdcSize}) -> copying with $${amount}`,
    );
    try {
      await placeMarketBuy(trade, amount);
      state.seen.add(tradeKey(trade));
      saveState(state);
      tradesPlaced++;
      if (maxTrades && tradesPlaced >= maxTrades) {
        log(
          `MAX_TRADES limit reached (${tradesPlaced}/${maxTrades}) — stopping. ` +
            `Check the position on Polymarket, then raise/remove MAX_TRADES and restart.`,
        );
        process.exit(0);
      }
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
      )}] interval=${pollInterval}ms bet=$${BET_USDC} (fixed) dryRun=${isDryRun} ` +
      `maxTrades=${maxTrades || "unlimited"}`,
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
