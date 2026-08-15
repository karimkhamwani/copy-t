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
  DATA_API_HOST = "https://data-api.polymarket.com",
  FUNDER_ADDRESS,
} = process.env;

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
// Win/loss resolution via the CLOB markets API (GET /markets/{condition_id}).
// The gamma API stops returning fast markets (5-minute up/down) once they close,
// so resolved ones would stay "pending" forever there. The CLOB API keeps them
// and flags the winning token directly: tokens[].winner.
// Resolved markets are cached forever; unresolved ones are re-checked every 60s.
// ---------------------------------------------------------------------------

const resolutionCache = new Map(); // conditionId -> { resolved, tokens, checkedAt }
const PENDING_RECHECK_MS = 60000;
const MAX_LOOKUPS_PER_REQUEST = 10;

async function fetchResolution(conditionId) {
  const now = Date.now();
  try {
    const res = await fetch(`${CLOB_API_HOST}/markets/${conditionId}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000), // a hung request must not stall /api/trades
    });
    if (!res.ok) throw new Error(`clob API ${res.status}`);
    const m = await res.json();
    const tokens = (m.tokens || []).map((t) => ({
      tokenId: t.token_id,
      outcome: t.outcome,
      winner: Boolean(t.winner),
    }));
    resolutionCache.set(conditionId, {
      // resolved once a winner is flagged (closed alone isn't enough)
      resolved: Boolean(m.closed) && tokens.some((t) => t.winner),
      tokens,
      checkedAt: now,
    });
  } catch {
    // offline/blocked/unknown market -> stays "pending", re-checked later
    if (!resolutionCache.get(conditionId)?.resolved) {
      resolutionCache.set(conditionId, {
        resolved: false,
        tokens: [],
        checkedAt: now,
      });
    }
  }
}

async function refreshResolutions(entries) {
  const now = Date.now();
  const need = [
    ...new Set(
      entries
        .filter((e) => e.copy && e.status === "success" && e.conditionId)
        .map((e) => e.conditionId)
        .filter((id) => {
          const c = resolutionCache.get(id);
          return !c || (!c.resolved && now - c.checkedAt > PENDING_RECHECK_MS);
        }),
    ),
  ].slice(0, MAX_LOOKUPS_PER_REQUEST);
  if (need.length === 0) return;
  await Promise.all(need.map(fetchResolution));
}

/** The outcome token this entry bought (journal id is "txHash:asset"). */
function entryTokenId(entry) {
  return entry.asset || String(entry.id || "").split(":")[1] || "";
}

/** win | loss | pending for a successfully copied trade, undefined otherwise. */
function resultFor(entry) {
  if (!entry.copy || entry.status !== "success") return undefined;
  const c = entry.conditionId && resolutionCache.get(entry.conditionId);
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
// Portfolio value via the data API (GET /value?user=<address>).
// Cached briefly so the dashboard's 3s poll doesn't hammer the API.
// ---------------------------------------------------------------------------

const PORTFOLIO_TTL_MS = 30000;
let portfolioCache = { value: null, fetchedAt: 0 };

async function fetchPortFolioValue({ user }) {
  const res = await fetch(`${DATA_API_HOST}/value?user=${user}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`data API ${res.status}`);
  const data = await res.json();
  // response shape: [{ user, value }]
  const value = Array.isArray(data) ? data[0]?.value : data?.value;
  return value == null ? null : Number(value);
}

async function getPortfolioValue() {
  if (!FUNDER_ADDRESS) return null;
  const now = Date.now();
  if (now - portfolioCache.fetchedAt < PORTFOLIO_TTL_MS) return portfolioCache.value;
  try {
    portfolioCache = {
      value: await fetchPortFolioValue({ user: FUNDER_ADDRESS }),
      fetchedAt: now,
    };
  } catch {
    // keep last known value, retry after the TTL
    portfolioCache.fetchedAt = now;
  }
  return portfolioCache.value;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/trades") {
    const trades = readJson(TRADES_LOG_FILE, []);
    await refreshResolutions(trades);
    const withResults = trades.map((t) => ({ ...t, result: resultFor(t) }));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(withResults));
  }

  if (url === "/api/status") {
    const status = readJson(STATUS_FILE, null);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...(status || {}), serverTime: Date.now() }));
  }

  if (url === "/api/portfolio") {
    const value = await getPortfolioValue();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ user: FUNDER_ADDRESS || null, value }));
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
