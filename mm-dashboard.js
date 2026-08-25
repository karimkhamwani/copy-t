/**
 * Dashboard server for mm-bot.js — deliberately separate from
 * dashboard-server.js, because the market maker's question is a different one.
 *
 * The copy-trader dashboard answers "what did we trade and did it win". For the
 * market maker the live question is "is the fair-value model right", since the
 * whole edge (2.37c/share on the wallet we modelled) evaporates if fair is
 * biased — a biased model just buys the losing side over and over. So this UI
 * is built around fair vs the book, and why the bot is or isn't quoting.
 *
 * Backed by the files mm-bot.js writes:
 *   GET /api/mm/status    -> mm-status.json     (live snapshot, ~1/s)
 *   GET /api/mm/signals   -> mm-signals.ndjson  (fair-vs-market trail)
 *   GET /api/mm/journal   -> mm-journal.json    (cuts + settled holds)
 *
 * Run alongside the bot:  npm run mm-dashboard   (default http://localhost:3211)
 */

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  MM_DASHBOARD_PORT = "3211",
  MM_STATUS_FILE = path.join(__dirname, "mm-status.json"),
  MM_SIGNALS_FILE = path.join(__dirname, "mm-signals.ndjson"),
  MM_JOURNAL_FILE = path.join(__dirname, "mm-journal.json"),
} = process.env;

const STATIC_FILES = {
  "/": { file: path.join(__dirname, "mm-dashboard", "index.html"), type: "text/html" },
  "/app.js": { file: path.join(__dirname, "mm-dashboard", "app.js"), type: "text/javascript" },
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

/**
 * Tail the ndjson trail without reading a 5MB file on every 1s poll: seek to
 * the last `bytes` and drop the (probably partial) first line.
 */
function readSignalTail(file, bytes = 512 * 1024) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // torn write at the tail; the next poll picks it up
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const server = http.createServer((req, res) => {
  const [url, query] = req.url.split("?");
  const params = new URLSearchParams(query || "");

  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url === "/api/mm/status") {
    const status = readJson(MM_STATUS_FILE, null);
    return json({
      ...(status || {}),
      serverTime: Date.now(),
      // the bot rewrites this ~1/s; a stale file means the bot is not running
      running: Boolean(status && Date.now() - status.updatedAt < 15000),
    });
  }

  if (url === "/api/mm/signals") {
    const minutes = Math.min(360, Math.max(1, Number(params.get("minutes")) || 30));
    const cut = Date.now() - minutes * 60000;
    return json(readSignalTail(MM_SIGNALS_FILE).filter((r) => r.t >= cut));
  }

  if (url === "/api/mm/journal") {
    return json(readJson(MM_JOURNAL_FILE, []));
  }

  const entry = STATIC_FILES[url];
  if (entry && fs.existsSync(entry.file)) {
    res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" });
    return res.end(fs.readFileSync(entry.file));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(Number(MM_DASHBOARD_PORT), () => {
  console.log(`mm dashboard running at http://localhost:${MM_DASHBOARD_PORT}`);
});
