/**
 * Binance -> Polymarket lead-lag signal bot (delta-signals.js).
 *
 * Idea: Binance spot is the price the world watches; the 5m up/down books on
 * Polymarket re-price a beat later. This process watches both in real time:
 *
 *   Binance bookTicker ws  ->  live BTC (ETH/SOL/XRP) mid price
 *   Polymarket CLOB market ws ->  live best bid/ask of the Up & Down tokens
 *
 * Each 5m window it captures the strike (Binance mid at window open), then
 * continuously computes a fair probability that the window closes UP:
 *
 *   fair = Phi( ln(S/K) / (sigma * sqrt(tau)) )
 *
 * where S = live Binance mid, K = strike, tau = seconds to close, sigma =
 * realized per-second vol from the last ~10min of Binance ticks. When the
 * Polymarket ask lags the move enough — fair - askUp >= DELTA_EDGE (or the
 * mirror for Down) — it emits a "take" buy signal that copy-trader.js
 * executes as a FAK at that exact ask, under its own journal, risk gate and
 * dashboard (source shows as BOT, ids are "delta-…").
 *
 *   npm run delta        (DELTA_DRY_RUN=1 by default: log edges, don't signal)
 *
 * NOTE: the official resolution source for the up/down series is per market
 * rules and may not be Binance tick-for-tick. The strike captured here is our
 * own Binance reference; DELTA_EDGE must stay wide enough to absorb small
 * strike/feed drift — this bot hunts obvious lag, not the last cent.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const net = require("net");
const WebSocket = require("ws");

const {
  GAMMA_API_HOST = "https://gamma-api.polymarket.com",
  // binance.vision is Binance's public market-data mirror: same feed, no
  // geo-block (stream.binance.com returns 451 from US IPs)
  BINANCE_WS_URL = "wss://data-stream.binance.vision",
  BINANCE_REST_HOST = "https://data-api.binance.vision",
  CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  DELTA_DRY_RUN = "1",
  // markets to watch; prefix maps to a Binance symbol (btc -> BTCUSDT)
  DELTA_SLUG_PREFIX = "btc-updown-5m",
  DELTA_SHARES = "5", // shares per take signal (CLOB limit-order minimum is 5)
  DELTA_EDGE = "0.06", // min (fair - ask) to fire, in probability points
  DELTA_COOLDOWN_SEC = "5", // per market+side, between signals
  DELTA_MAX_SIGNALS = "60", // per market window (both sides combined)
  DELTA_MIN_TAU_SEC = "15", // stop signalling this close to the window end
  DELTA_ENTRY_START_SEC = "10", // no signals before this (strike just formed)
  DELTA_MIN_PRICE = "0.10", // only buy asks inside this band: cheaper means
  DELTA_MAX_PRICE = "0.90", // the market is basically decided, worst fills
  DELTA_VOL_FALLBACK = "0.0003", // per-second log-return vol until measured
} = process.env;

const MARKET_SECONDS = 300;
const isDryRun = DELTA_DRY_RUN === "1" || DELTA_DRY_RUN.toLowerCase() === "true";
const sharesPerSignal = Math.max(5, Number(DELTA_SHARES) || 5);
const minEdge = Number(DELTA_EDGE);
const cooldownSec = Number(DELTA_COOLDOWN_SEC);
const maxSignals = Number(DELTA_MAX_SIGNALS);
const minTauSec = Number(DELTA_MIN_TAU_SEC);
const entryStartSec = Number(DELTA_ENTRY_START_SEC);
const minPrice = Number(DELTA_MIN_PRICE);
const maxPrice = Number(DELTA_MAX_PRICE);
const volFallback = Number(DELTA_VOL_FALLBACK);

const prefixes = DELTA_SLUG_PREFIX.split(",").map((s) => s.trim()).filter(Boolean);

/** btc-updown-5m -> BTCUSDT etc. */
function binanceSymbol(prefix) {
  const coin = prefix.split("-")[0].toUpperCase();
  return `${coin}USDT`;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`GET ${url} -> ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Signal delivery — identical contract to updown-5m.js: unix socket (named
// pipe on Windows) for sub-ms push, ndjson append as durable fallback. The
// copier dedupes on id, so double delivery is harmless.
// ---------------------------------------------------------------------------

const SIGNAL_FILE = path.join(__dirname, "updown-signals.ndjson");
const SIGNAL_SOCKET =
  process.platform === "win32"
    ? "\\\\.\\pipe\\" + __dirname.replace(/[^a-zA-Z0-9]/g, "-") + "-updown-signals"
    : `${SIGNAL_FILE}.sock`;
let sigSock = null;
let sigSockOk = false;

function connectSignalSocket() {
  if (sigSock) return;
  const s = net.createConnection(SIGNAL_SOCKET);
  s.on("connect", () => {
    sigSockOk = true;
    log("signal socket connected (sub-ms delivery to copy-trader)");
  });
  s.on("error", () => {});
  s.on("close", () => {
    sigSockOk = false;
    sigSock = null;
    setTimeout(connectSignalSocket, 1000).unref();
  });
  sigSock = s;
}

function emitSignal(obj) {
  const line = JSON.stringify(obj) + "\n";
  if (sigSockOk) {
    try {
      sigSock.write(line);
    } catch {
      /* file below still delivers */
    }
  }
  fs.appendFileSync(SIGNAL_FILE, line);
}

// ---------------------------------------------------------------------------
// Binance feed: bookTicker mids + a rolling realized-vol estimate per symbol
// ---------------------------------------------------------------------------

const VOL_WINDOW_SEC = 600; // realized vol lookback
const binance = new Map(); // SYMBOL -> { mid, at, samples: [{t, p}] }
for (const p of prefixes) binance.set(binanceSymbol(p), { mid: null, at: 0, samples: [] });

function startBinance() {
  const streams = [...binance.keys()]
    .map((s) => `${s.toLowerCase()}@bookTicker`)
    .join("/");
  const url = `${BINANCE_WS_URL}/stream?streams=${streams}`;
  const ws = new WebSocket(url);
  ws.on("open", () => log(`binance ws connected (${[...binance.keys()].join(", ")})`));
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const d = msg.data || msg;
    const sym = String(d.s || "").toUpperCase();
    const st = binance.get(sym);
    if (!st) return;
    const bid = Number(d.b);
    const ask = Number(d.a);
    if (!(bid > 0) || !(ask > 0)) return;
    st.mid = (bid + ask) / 2;
    st.at = Date.now();
    // ~1Hz sampling is plenty for a 10-minute vol estimate
    const last = st.samples[st.samples.length - 1];
    if (!last || st.at - last.t >= 1000) {
      st.samples.push({ t: st.at, p: st.mid });
      const cutoff = st.at - VOL_WINDOW_SEC * 1000;
      while (st.samples.length && st.samples[0].t < cutoff) st.samples.shift();
    }
  });
  ws.on("error", (err) => log("binance ws error:", err.message));
  ws.on("close", () => {
    log("binance ws closed — reconnecting in 2s");
    setTimeout(startBinance, 2000).unref();
  });
}

/** Per-second log-return volatility from the sample buffer; falls back to a
 * conservative default until there's enough history. */
function perSecVol(sym) {
  const st = binance.get(sym);
  const s = st?.samples || [];
  if (s.length < 60) return volFallback;
  const rets = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i].t - s[i - 1].t) / 1000;
    if (dt <= 0) continue;
    rets.push(Math.log(s[i].p / s[i - 1].p) / Math.sqrt(dt));
  }
  if (rets.length < 30) return volFallback;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(varr);
  return vol > 0 ? vol : volFallback;
}

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation
 * (max abs error ~1.5e-7 — far below any tradable edge). */
function phi(z) {
  if (z > 8) return 1;
  if (z < -8) return 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

// ---------------------------------------------------------------------------
// Polymarket market-channel feed: live best bid/ask for the Up/Down tokens.
// One socket per 5m window (the subscription is fixed at connect time).
// ---------------------------------------------------------------------------

/** Minimal L2 book that survives snapshot + delta updates. */
function newBook() {
  return { bids: new Map(), asks: new Map() }; // price(str) -> size(number)
}
function bookBest(book) {
  let bid = null;
  let ask = null;
  for (const [p, s] of book.bids) if (s > 0) bid = Math.max(bid ?? -1, Number(p));
  for (const [p, s] of book.asks) if (s > 0) ask = Math.min(ask ?? 2, Number(p));
  return { bid: bid === -1 ? null : bid, ask: ask === 2 ? null : ask };
}
function applySnapshot(book, msg) {
  book.bids.clear();
  book.asks.clear();
  for (const l of msg.bids || msg.buys || []) book.bids.set(String(l.price), Number(l.size));
  for (const l of msg.asks || msg.sells || []) book.asks.set(String(l.price), Number(l.size));
}
function applyChange(book, ch) {
  const side = String(ch.side || "").toUpperCase() === "BUY" ? book.bids : book.asks;
  const size = Number(ch.size);
  if (size > 0) side.set(String(ch.price), size);
  else side.delete(String(ch.price));
}

function subscribeBooks(win) {
  const assetIds = [];
  for (const st of win.states.values()) {
    if (st.market) assetIds.push(st.market.upToken, st.market.downToken);
  }
  if (assetIds.length === 0) return;
  const ws = new WebSocket(CLOB_WS_URL);
  win.clobWs = ws;
  ws.on("open", () => {
    win.clobErrLogged = false;
    ws.send(JSON.stringify({ assets_ids: assetIds, type: "market" }));
    log(`clob market ws subscribed (${assetIds.length} tokens)`);
  });
  ws.on("message", (buf) => {
    let msgs;
    try {
      msgs = JSON.parse(buf.toString());
    } catch {
      return;
    }
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      const asset = String(msg.asset_id || "");
      const book = win.books.get(asset);
      if (!book) continue;
      if (msg.event_type === "book") applySnapshot(book, msg);
      else if (msg.event_type === "price_change") {
        for (const ch of msg.changes || [msg]) applyChange(book, ch);
      }
    }
  });
  ws.on("error", (err) => {
    if (!win.clobErrLogged) {
      log("clob ws error (suppressing repeats until reconnected):", err.message);
      win.clobErrLogged = true;
    }
  });
  ws.on("close", () => {
    // reconnect (with backoff) only while this window is still the live one
    if (win.start === currentMarketStart() && !win.closed) {
      setTimeout(() => subscribeBooks(win), 3000).unref();
    }
  });
}

// ---------------------------------------------------------------------------
// Window lifecycle + signal engine
// ---------------------------------------------------------------------------

function currentMarketStart(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / MARKET_SECONDS) * MARKET_SECONDS;
}

async function discoverMarket(slug) {
  const rows = await fetchJson(`${GAMMA_API_HOST}/markets?slug=${slug}`);
  const m = Array.isArray(rows) ? rows[0] : null;
  if (!m) throw new Error(`market not found for slug ${slug}`);
  const tokenIds = JSON.parse(m.clobTokenIds || "[]");
  const outcomes = JSON.parse(m.outcomes || "[]");
  if (tokenIds.length !== 2 || outcomes.length !== 2)
    throw new Error(`unexpected market shape for ${slug}`);
  const byOutcome = {};
  outcomes.forEach((o, i) => (byOutcome[String(o).toLowerCase()] = tokenIds[i]));
  return {
    slug,
    title: m.question || m.title || slug,
    conditionId: m.conditionId,
    upToken: byOutcome.up ?? tokenIds[0],
    downToken: byOutcome.down ?? tokenIds[1],
  };
}

let win = null; // the live 5m window: { start, states, books, clobWs, closed }

function freshWindow(start) {
  return {
    start,
    closed: false,
    clobWs: null,
    books: new Map(), // tokenID -> book
    states: new Map(), // prefix -> per-market state
  };
}

function freshState(prefix, start) {
  return {
    prefix,
    slug: `${prefix}-${start}`,
    symbol: binanceSymbol(prefix),
    market: null,
    strike: null, // Binance mid captured at window open
    signals: 0,
    lastSignalAt: { Up: 0, Down: 0 },
    discovering: false,
  };
}

async function rollWindow(start) {
  if (win) {
    win.closed = true;
    try {
      win.clobWs?.close();
    } catch {
      /* already gone */
    }
  }
  win = freshWindow(start);
  for (const prefix of prefixes) {
    const st = freshState(prefix, start);
    // strike = Binance mid at (or as close as possible to) the window open
    const b = binance.get(st.symbol);
    st.strike = b?.mid ?? null;
    win.states.set(prefix, st);
    log(
      `[${prefix}] new window ${st.slug}` +
        (st.strike ? ` strike ${st.strike.toFixed(2)}` : " (no ws mid yet — backfilling strike)"),
    );
    if (!st.strike) backfillStrike(win, st);
  }
  await discoverAll();
}

/** No ws mid at the window open (e.g. first window after startup): recover
 * the strike from Binance REST — the 1m kline whose openTime IS the window
 * open, so its open price is exactly the price at that moment. */
async function backfillStrike(w, st) {
  try {
    const url =
      `${BINANCE_REST_HOST}/api/v3/klines?symbol=${st.symbol}` +
      `&interval=1m&startTime=${w.start * 1000}&limit=1`;
    const rows = await fetchJson(url);
    const open = Number(rows?.[0]?.[1]);
    if (w === win && !st.strike && open > 0) {
      st.strike = open;
      log(`[${st.prefix}] strike backfilled from kline: ${open.toFixed(2)}`);
    }
  } catch (err) {
    log(`[${st.prefix}] strike backfill failed (${err.message}) — window stays skipped`);
  }
}

async function discoverAll() {
  const w = win;
  let found = false;
  await Promise.all(
    [...w.states.values()].map(async (st) => {
      if (st.market || st.discovering) return;
      st.discovering = true;
      try {
        st.market = await discoverMarket(st.slug);
        w.books.set(st.market.upToken, newBook());
        w.books.set(st.market.downToken, newBook());
        found = true;
        if (!isDryRun)
          emitSignal({ type: "prewarm", slug: st.slug, assets: [st.market.upToken, st.market.downToken] });
        log(`[${st.prefix}] market found: ${st.slug}`);
      } catch (err) {
        log(`[${st.prefix}] discovery failed (${err.message}) — retrying`);
      } finally {
        st.discovering = false;
      }
    }),
  );
  if (found && w === win && !w.closed) {
    try {
      w.clobWs?.close(); // resubscribe with the fuller token set
    } catch {
      /* fine */
    }
    subscribeBooks(w);
  }
}

function maybeSignal(st, side, fair, ask, tau) {
  const prob = side === "Up" ? fair : 1 - fair;
  const edge = prob - ask;
  if (edge < minEdge) return;
  if (ask < minPrice || ask > maxPrice) return;
  if (ask * sharesPerSignal < 1) return; // exchange $1 marketable minimum
  const now = Date.now();
  if (now - st.lastSignalAt[side] < cooldownSec * 1000) return;
  if (st.signals >= maxSignals) return;

  st.lastSignalAt[side] = now;
  st.signals++;
  const b = binance.get(st.symbol);
  const line =
    `[${st.prefix}] ${side} edge ${(edge * 100).toFixed(1)}pt: fair ${prob.toFixed(3)} vs ask ${ask} ` +
    `(spot ${b.mid.toFixed(2)} / strike ${st.strike.toFixed(2)}, ${Math.round(tau)}s left)`;

  if (isDryRun) {
    log(`[DRY_RUN] ${line} — would TAKE ${sharesPerSignal} sh`);
    return;
  }
  const token = side === "Up" ? st.market.upToken : st.market.downToken;
  emitSignal({
    type: "buy",
    kind: "take", // copier fires a FAK at exactly this price
    id: `delta-${st.slug}-${side.toLowerCase()}-${st.signals}`,
    slug: st.slug,
    conditionId: st.market.conditionId,
    title: st.market.title,
    asset: token,
    outcome: side,
    outcomeIndex: side === "Up" ? 0 : 1,
    price: ask,
    size: sharesPerSignal,
    timestamp: Math.floor(now / 1000),
  });
  log(`${line} — TAKE signal emitted (${sharesPerSignal} sh @ ${ask})`);
}

function evaluate() {
  if (!win) return;
  const nowSec = Date.now() / 1000;
  const t = nowSec - win.start;
  if (t < entryStartSec) return;
  const tau = win.start + MARKET_SECONDS - nowSec;
  if (tau < minTauSec) return;

  for (const st of win.states.values()) {
    if (!st.market || !st.strike) continue;
    const b = binance.get(st.symbol);
    if (!b?.mid || Date.now() - b.at > 5000) continue; // stale feed — never price off it
    const upBest = bookBest(win.books.get(st.market.upToken));
    const downBest = bookBest(win.books.get(st.market.downToken));
    const sigma = perSecVol(st.symbol);
    const z = Math.log(b.mid / st.strike) / (sigma * Math.sqrt(Math.max(tau, 1)));
    const fair = phi(z);
    if (upBest.ask != null) maybeSignal(st, "Up", fair, upBest.ask, tau);
    if (downBest.ask != null) maybeSignal(st, "Down", fair, downBest.ask, tau);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (!(minEdge > 0 && minEdge < 1)) {
    console.error(`DELTA_EDGE must be between 0 and 1 (got ${DELTA_EDGE})`);
    process.exit(1);
  }
  log(
    `delta-signals starting: [${prefixes.join(", ")}] edge>=${minEdge}, ` +
      `${sharesPerSignal} sh takes, max ${maxSignals}/window, cooldown ${cooldownSec}s, ` +
      `mode ${isDryRun ? "DRY" : "LIVE -> copy-trader"}`,
  );
  startBinance();
  if (!isDryRun) connectSignalSocket();

  let rolling = false;
  setInterval(async () => {
    const start = currentMarketStart();
    if (!win || win.start !== start) {
      if (rolling) return;
      rolling = true;
      try {
        await rollWindow(start);
      } catch (err) {
        log("window roll error:", err.message || err);
        win = null; // retried next tick
      } finally {
        rolling = false;
      }
      return;
    }
    // late discovery retries (market sometimes appears seconds after open)
    if ([...win.states.values()].some((s) => !s.market)) discoverAll();
  }, 1000);

  // evaluate on a fast clock — the inputs (Binance mid, books) update by push,
  // so this is pure math with zero network on the hot path
  setInterval(evaluate, 250);
}

module.exports = { phi, perSecVol, bookBest, applySnapshot, applyChange };
