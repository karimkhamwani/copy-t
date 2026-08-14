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
  GAMMA_API_HOST = "https://gamma-api.polymarket.com",
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
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Win/loss resolution via the gamma markets API.
// Resolved markets are cached forever; unresolved ones are re-checked every 60s.
// ---------------------------------------------------------------------------

const resolutionCache = new Map(); // conditionId -> { resolved, prices, checkedAt }
const PENDING_RECHECK_MS = 60000;
const MAX_LOOKUPS_PER_REQUEST = 40;

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

  // Whatever happens, don't re-ask for these ids for a while
  const markChecked = () => {
    for (const id of need) {
      if (!resolutionCache.get(id)?.resolved) {
        resolutionCache.set(id, { resolved: false, prices: [], checkedAt: now });
      }
    }
  };

  try {
    const qs = need.map((id) => `condition_ids=${id}`).join("&");
    const res = await fetch(`${GAMMA_API_HOST}/markets?${qs}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`gamma API ${res.status}`);
    const markets = await res.json();
    markChecked();
    for (const m of Array.isArray(markets) ? markets : []) {
      let prices = [];
      try {
        prices = JSON.parse(m.outcomePrices || "[]").map(Number);
      } catch {
        /* ignore malformed prices */
      }
      resolutionCache.set(m.conditionId, {
        resolved: Boolean(m.closed) && prices.length > 0,
        prices,
        checkedAt: now,
      });
    }
  } catch {
    markChecked(); // offline/blocked -> everything stays "pending"
  }
}

/** win | loss | pending for a successfully copied trade, undefined otherwise. */
function resultFor(entry) {
  if (!entry.copy || entry.status !== "success") return undefined;
  const c = entry.conditionId && resolutionCache.get(entry.conditionId);
  if (!c || !c.resolved || entry.outcomeIndex == null) return "pending";
  const p = c.prices[entry.outcomeIndex];
  if (p >= 0.99) return "win";
  if (p <= 0.01) return "loss";
  return "pending"; // market closed but not fully resolved yet
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

  const entry = STATIC_FILES[url];
  if (entry && fs.existsSync(entry.file)) {
    res.writeHead(200, { "content-type": entry.type });
    return res.end(fs.readFileSync(entry.file));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(Number(DASHBOARD_PORT), () => {
  console.log(`dashboard running at http://localhost:${DASHBOARD_PORT}`);
});
