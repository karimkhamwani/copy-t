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

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/trades") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(readJson(TRADES_LOG_FILE, [])));
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
