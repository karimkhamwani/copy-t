/**
 * Dashboard server for the copy-trader.
 *
 * Serves the React dashboard (dashboard/) plus two JSON endpoints backed by
 * the files copy-trader.js writes:
 *   GET /api/trades  -> trades-log.json  (observed + copied trades)
 *   GET /api/status  -> status.json      (engine mode/config/heartbeat)
 *
 * Run alongside the trader:  npm run dashboard   (default http://localhost:3210)
 */

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  DASHBOARD_PORT = "3210",
  TRADES_LOG_FILE = path.join(__dirname, "trades-log.json"),
  STATUS_FILE = path.join(__dirname, "status.json"),
  CLOB_API_HOST = "https://clob.polymarket.com",
  FUNDER_ADDRESS,
  PRIVATE_KEY,
  SIGNATURE_TYPE = "1",
} = process.env;

const CHAIN_ID = 137; // Polygon mainnet

const STATIC_FILES = {
  "/": { file: path.join(__dirname, "dashboard", "index.html"), type: "text/html" },
  "/app.js": { file: path.join(__dirname, "dashboard", "app.js"), type: "text/javascript" },
  "/vendor/react.js": {
    file: path.join(__dirname, "node_modules", "react", "umd", "react.production.min.js"),
    type: "text/javascript",
  },
  "/vendor/react-dom.js": {
    file: path.join(__dirname, "node_modules", "react-dom", "umd", "react-dom.production.min.js"),
    type: "text/javascript",
  },
  "/vendor/htm.js": {
    file: path.join(__dirname, "node_modules", "htm", "dist", "htm.js"),
    type: "text/javascript",
  },
  "/vendor/prop-types.js": {
    file: path.join(__dirname, "node_modules", "prop-types", "prop-types.min.js"),
    type: "text/javascript",
  },
  "/vendor/recharts.js": {
    file: path.join(__dirname, "node_modules", "recharts", "umd", "Recharts.js"),
    type: "text/javascript",
  },
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Win/loss resolution via the CLOB markets API — shared cache module (the
// trader's risk gate uses the same one). The gamma API stops returning fast
// markets (5-minute up/down) once they close, so resolved ones would stay
// "pending" forever there; the CLOB API keeps them and flags tokens[].winner.
// ---------------------------------------------------------------------------

const { createResolutionCache } = require("./market-resolution.js");

const resolutions = createResolutionCache({
  host: CLOB_API_HOST,
  fetchJson: async (url) => {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000), // a hung request must not stall /api/trades
    });
    if (!res.ok) throw new Error(`clob API ${res.status}`);
    return res.json();
  },
});

function refreshResolutions(entries) {
  return resolutions.refresh(
    entries
      .filter((e) => e.copy && e.status === "success")
      .map((e) => e.conditionId),
  );
}

/** The outcome token this entry bought (journal id is "txHash:asset"). */
function entryTokenId(entry) {
  return entry.asset || String(entry.id || "").split(":")[1] || "";
}

/** win | loss | pending for a successfully copied trade, undefined otherwise. */
function resultFor(entry) {
  if (!entry.copy || entry.status !== "success") return undefined;
  const c = entry.conditionId && resolutions.get(entry.conditionId);
  if (!c || !c.resolved) return "pending";
  const mine = c.tokens.find((t) => t.tokenId === entryTokenId(entry));
  if (mine) return mine.winner ? "win" : "loss";
  // fall back to outcomeIndex if the token id didn't match
  if (entry.outcomeIndex != null && c.tokens[entry.outcomeIndex]) {
    return c.tokens[entry.outcomeIndex].winner ? "win" : "loss";
  }
  return "pending";
}

// ---------------------------------------------------------------------------
// USDC balance via the CLOB client's getBalanceAllowance (COLLATERAL).
// Needs PRIVATE_KEY (+ FUNDER_ADDRESS) — without them /api/balance returns null.
// Cached briefly so the dashboard's 3s poll doesn't hammer the API.
// ---------------------------------------------------------------------------

let clobClient = null;

async function getClobClient() {
  if (clobClient) return clobClient;
  // clob-client-v2 is ESM-only — same dynamic-import dance as copy-trader.js
  const { ClobClient, AssetType } = await import("@polymarket/clob-client-v2");
  const { Wallet } = require("@ethersproject/wallet");
  const signer = new Wallet(PRIVATE_KEY);
  const bootstrap = new ClobClient({
    host: CLOB_API_HOST,
    chain: CHAIN_ID,
    signer,
    signatureType: Number(SIGNATURE_TYPE),
    funderAddress: FUNDER_ADDRESS,
  });
  const creds = await bootstrap.createOrDeriveApiKey();
  clobClient = new ClobClient({
    host: CLOB_API_HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: Number(SIGNATURE_TYPE),
    funderAddress: FUNDER_ADDRESS,
  });
  clobClient._AssetType = AssetType;
  return clobClient;
}

const BALANCE_TTL_MS = 30000;
let balanceCache = { balance: null, fetchedAt: 0 };

async function getUsdcBalance() {
  if (!PRIVATE_KEY) return null;
  const now = Date.now();
  if (now - balanceCache.fetchedAt < BALANCE_TTL_MS) return balanceCache.balance;
  try {
    const client = await getClobClient();
    const resp = await client.getBalanceAllowance({
      asset_type: client._AssetType.COLLATERAL,
    });
    // balance is a micro-USDC string (6 decimals)
    const raw = Number(resp?.balance);
    balanceCache = {
      balance: Number.isFinite(raw) ? raw / 1e6 : null,
      fetchedAt: now,
    };
  } catch {
    // keep last known balance, retry after the TTL
    balanceCache.fetchedAt = now;
  }
  return balanceCache.balance;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/trades") {
    const trades = readJson(TRADES_LOG_FILE, []);
    // Answer from the resolution cache and refresh it in the background: a slow
    // CLOB lookup must never delay the response, or the dashboard's first paint
    // after a reload sits empty until the API answers. Newly resolved markets
    // show up on the next poll instead.
    refreshResolutions(trades).catch(() => {
      /* cache keeps the last known state; retried on the next request */
    });
    const withResults = trades.map((t) => ({ ...t, result: resultFor(t) }));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(withResults));
  }

  if (url === "/api/status") {
    const status = readJson(STATUS_FILE, null);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...(status || {}), serverTime: Date.now() }));
  }

  if (url === "/api/balance") {
    const balance = await getUsdcBalance();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ balance }));
  }

  const entry = STATIC_FILES[url];
  if (entry && fs.existsSync(entry.file)) {
    res.writeHead(200, {
      "content-type": entry.type,
      // Never let the browser cache the UI — after a code update + pm2 restart,
      // a plain refresh must always load the new dashboard.
      "cache-control": "no-store",
    });
    return res.end(fs.readFileSync(entry.file));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(Number(DASHBOARD_PORT), () => {
  console.log(`dashboard running at http://localhost:${DASHBOARD_PORT}`);
});
