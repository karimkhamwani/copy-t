/**
 * mm-bot.js — market maker modelled on wallet 0xeebde7a0…eba30.
 *
 * Built from 397,645 of that wallet's on-chain fills (see
 * wallet-analysis-0xeebde7a0.md). What the data showed it actually does, and
 * what this bot copies:
 *
 *   1. Quotes PASSIVE BIDS on both sides, never resting offers.
 *      (it posted 199,209 resting buys and exactly 1 resting sell in 3 days)
 *   2. Does NOT require the legs to sum under $1. Its median paired market
 *      cost 1.018; only 39% were riskless arb. Each leg is quoted below ITS
 *      OWN fair value instead — fair comes from Binance spot vs the window's
 *      strike, time left and realized vol (same model as delta-signals.js).
 *   3. Re-quotes as fair moves: cancel + replace when the resting bid drifts
 *      away from fair.
 *   4. CUTS FAST and often: 44% of every share it buys is sold back, median
 *      54s after the buy (p25 24s). Exits are aggressive taker sells into the
 *      bid — triggered by fair value turning, not by a fixed clock.
 *   5. Holds the rest to resolution (64% of held shares won).
 *   6. Tiny clips, many markets: median fill $5, ~1,350 markets/day.
 *
 * Its measured edge was 2.37 cents per share bought. That edge only exists if
 * the fair-value model is calibrated — with a biased model this strategy buys
 * the losing side systematically. RUN IT IN DRY MODE FIRST and check the
 * logged fair values against what actually resolves.
 *
 *   npm run mm            (MM_DRY_RUN=1 by default: simulate, place nothing)
 *
 * Standalone by design: own orders, own journal (mm-journal.json), own risk
 * caps. It does not touch copy-trader.js, updown-5m.js or their state.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const {
  CLOB_API_HOST = "https://clob.polymarket.com",
  GAMMA_API_HOST = "https://gamma-api.polymarket.com",
  BINANCE_WS_URL = "wss://data-stream.binance.vision",
  BINANCE_REST_HOST = "https://data-api.binance.vision",
  CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  SIGNATURE_TYPE = "1",

  MM_DRY_RUN = "1",
  // markets to make; "<coin>-updown-<n>m" — duration parsed from the slug
  MM_SERIES = "btc-updown-5m",
  MM_SHARES = "5", // shares per clip (CLOB minimum is 5)
  MM_MARGIN = "0.04", // quote this far BELOW fair (our edge per share)
  MM_REQUOTE = "0.02", // re-quote when |fair - margin - restingBid| exceeds this
  MM_MAX_CLIPS_PER_SIDE = "2", // max open clips per token (inventory cap)
  MM_MIN_PRICE = "0.08", // never quote outside this band — too decided
  MM_MAX_PRICE = "0.92",
  // sit out when the book disagrees with our fair by more than this: a big
  // gap usually means the model is wrong, not that the market is mispriced
  MM_MAX_DISAGREE = "0.15",
  MM_DEBUG = "0", // log why a leg is not being quoted
  // Loop cadence: with the book websocket up, quoting reacts on push; the REST
  // fallback is deliberately slower so we do not hammer the API.
  MM_LOOP_MS = "250",
  MM_REST_LOOP_MS = "1000",
  MM_BOOK_STALE_MS = "4000", // never quote off a book older than this
  MM_SKIP_PREFLIGHT = "0", // 1 = run even where Binance/Polymarket are blocked
  MM_QUOTE_START_SEC = "15", // quote window inside the market, from open
  MM_QUOTE_END_FRAC = "0.75", // stop quoting after this fraction of the window
  MM_CANCEL_BEFORE_CLOSE_SEC = "20",

  // exits — the wallet's loss-cutting, expressed as rules
  MM_EXIT_FAIR_DROP = "0.12", // cut if fair falls this far below entry fair
  MM_EXIT_FAIR_FLOOR = "0.35", // cut if fair for the held side drops under this
  MM_EXIT_MAX_HOLD_SEC = "120", // backstop: their p75 hold was 108s
  MM_EXIT_MIN_TAU_SEC = "12", // too close to close to exit; ride it out

  MM_MAX_ACTIVE_USDC = "50", // hard cap on cost basis outstanding at once
  MM_VOL_FALLBACK = "0.0003", // per-second log-return vol until measured
  MM_JOURNAL_FILE = path.join(__dirname, "mm-journal.json"),
} = process.env;

const isDryRun = MM_DRY_RUN === "1" || MM_DRY_RUN.toLowerCase() === "true";
const clipShares = Math.max(5, Number(MM_SHARES) || 5);
const margin = Number(MM_MARGIN);
const requoteAt = Number(MM_REQUOTE);
const maxClips = Math.max(1, Number(MM_MAX_CLIPS_PER_SIDE) || 1);
const minPrice = Number(MM_MIN_PRICE);
const maxPrice = Number(MM_MAX_PRICE);
const maxDisagree = Number(MM_MAX_DISAGREE);
const debug = MM_DEBUG === "1" || MM_DEBUG.toLowerCase() === "true";
const loopMs = Math.max(100, Number(MM_LOOP_MS) || 250);
const restLoopMs = Math.max(250, Number(MM_REST_LOOP_MS) || 1000);
const bookStaleMs = Math.max(1000, Number(MM_BOOK_STALE_MS) || 4000);
const skipPreflight = MM_SKIP_PREFLIGHT === "1" || MM_SKIP_PREFLIGHT.toLowerCase() === "true";
const quoteStart = Number(MM_QUOTE_START_SEC);
const quoteEndFrac = Number(MM_QUOTE_END_FRAC);
const cancelBefore = Number(MM_CANCEL_BEFORE_CLOSE_SEC);
const exitFairDrop = Number(MM_EXIT_FAIR_DROP);
const exitFairFloor = Number(MM_EXIT_FAIR_FLOOR);
const exitMaxHold = Number(MM_EXIT_MAX_HOLD_SEC);
const exitMinTau = Number(MM_EXIT_MIN_TAU_SEC);
const maxActiveUsdc = Number(MM_MAX_ACTIVE_USDC);
const volFallback = Number(MM_VOL_FALLBACK);
const CHAIN_ID = 137;

/** "btc-updown-5m" -> { prefix, seconds, symbol } */
function parseSeries(s) {
  const m = /^([a-z0-9]+)-updown-(\d+)m$/i.exec(s.trim());
  if (!m) throw new Error(`bad MM_SERIES entry "${s}" (expect e.g. btc-updown-5m)`);
  return { prefix: s.trim(), seconds: Number(m[2]) * 60, symbol: `${m[1].toUpperCase()}USDT` };
}
const series = MM_SERIES.split(",").filter(Boolean).map(parseSeries);

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
const round2 = (p) => Math.round(p * 100) / 100;

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Binance feed + realized vol (the fair-value inputs)
// ---------------------------------------------------------------------------

const VOL_WINDOW_SEC = 600;
const spot = new Map(); // SYMBOL -> { mid, at, samples:[{t,p}] }
for (const s of series) if (!spot.has(s.symbol)) spot.set(s.symbol, { mid: null, at: 0, samples: [] });

function startBinance() {
  const streams = [...spot.keys()].map((s) => `${s.toLowerCase()}@bookTicker`).join("/");
  const ws = new WebSocket(`${BINANCE_WS_URL}/stream?streams=${streams}`);
  ws.on("open", () => log(`binance ws connected (${[...spot.keys()].join(", ")})`));
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const d = msg.data || msg;
    const st = spot.get(String(d.s || "").toUpperCase());
    if (!st) return;
    const bid = Number(d.b), ask = Number(d.a);
    if (!(bid > 0) || !(ask > 0)) return;
    st.mid = (bid + ask) / 2;
    st.at = Date.now();
    const last = st.samples[st.samples.length - 1];
    if (!last || st.at - last.t >= 1000) {
      st.samples.push({ t: st.at, p: st.mid });
      const cut = st.at - VOL_WINDOW_SEC * 1000;
      while (st.samples.length && st.samples[0].t < cut) st.samples.shift();
    }
  });
  ws.on("error", (e) => log("binance ws error:", e.message));
  ws.on("close", () => {
    log("binance ws closed — reconnecting in 2s");
    setTimeout(startBinance, 2000).unref();
  });
}

function perSecVol(sym) {
  const s = spot.get(sym)?.samples || [];
  if (s.length < 60) return volFallback;
  const r = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i].t - s[i - 1].t) / 1000;
    if (dt > 0) r.push(Math.log(s[i].p / s[i - 1].p) / Math.sqrt(dt));
  }
  if (r.length < 30) return volFallback;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) || volFallback;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26; abs error ~1.5e-7). */
function phi(z) {
  if (z > 8) return 1;
  if (z < -8) return 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

/** P(window closes UP) given spot, strike, seconds left, per-second vol. */
function fairUp(mid, strike, tau, sigma) {
  return phi(Math.log(mid / strike) / (sigma * Math.sqrt(Math.max(tau, 1))));
}

// ---------------------------------------------------------------------------
// CLOB plumbing
// ---------------------------------------------------------------------------

let clob = null;
async function getClob() {
  if (clob) return clob;
  const { ClobClient, Side, OrderType } = await import("@polymarket/clob-client-v2");
  const { Wallet } = require("@ethersproject/wallet");
  const signer = new Wallet(PRIVATE_KEY);
  const boot = new ClobClient({
    host: CLOB_API_HOST, chain: CHAIN_ID, signer,
    signatureType: Number(SIGNATURE_TYPE), funderAddress: FUNDER_ADDRESS,
  });
  const creds = await boot.createOrDeriveApiKey();
  clob = new ClobClient({
    host: CLOB_API_HOST, chain: CHAIN_ID, signer, creds,
    signatureType: Number(SIGNATURE_TYPE), funderAddress: FUNDER_ADDRESS,
  });
  clob._Side = Side;
  clob._OrderType = OrderType;
  return clob;
}

function bookTop(book) {
  const bids = (book?.bids || []).map((l) => Number(l.price)).filter(Number.isFinite);
  const asks = (book?.asks || []).map((l) => Number(l.price)).filter(Number.isFinite);
  return {
    bid: bids.length ? Math.max(...bids) : null,
    ask: asks.length ? Math.min(...asks) : null,
  };
}

async function discoverMarket(slug) {
  const rows = await fetchJson(`${GAMMA_API_HOST}/markets?slug=${slug}`);
  const m = Array.isArray(rows) ? rows[0] : null;
  if (!m) throw new Error(`market not found: ${slug}`);
  const ids = JSON.parse(m.clobTokenIds || "[]");
  const outs = JSON.parse(m.outcomes || "[]");
  if (ids.length !== 2) throw new Error(`unexpected shape: ${slug}`);
  const by = {};
  outs.forEach((o, i) => (by[String(o).toLowerCase()] = ids[i]));
  return {
    slug, title: m.question || slug, conditionId: m.conditionId,
    upToken: by.up ?? ids[0], downToken: by.down ?? ids[1],
  };
}

// ---------------------------------------------------------------------------
// Live book feed (websocket). Primary path on a machine that can reach the
// CLOB socket: books arrive by push, so quoting reacts in ~250ms instead of
// waiting on a 1s REST poll. Falls back to REST polling when the socket is
// unavailable (see preflight — that is a hard error unless explicitly allowed).
// ---------------------------------------------------------------------------

const wsBooks = new Map(); // token -> { bids:Map, asks:Map, at }
let clobWs = null;
let clobWsOk = false;
let subscribedKey = "";

function wsTop(token) {
  const b = wsBooks.get(token);
  if (!b) return null;
  let bid = null, ask = null;
  for (const [p, s] of b.bids) if (s > 0) bid = Math.max(bid ?? -1, Number(p));
  for (const [p, s] of b.asks) if (s > 0) ask = Math.min(ask ?? 2, Number(p));
  return { bid: bid === -1 ? null : bid, ask: ask === 2 ? null : ask, at: b.at };
}

/** (Re)subscribe the socket to exactly the tokens currently being quoted. */
function subscribeBooks(tokens) {
  const key = tokens.slice().sort().join(",");
  if (!tokens.length || key === subscribedKey) return;
  subscribedKey = key;
  for (const t of tokens) if (!wsBooks.has(t)) wsBooks.set(t, { bids: new Map(), asks: new Map(), at: 0 });
  for (const t of [...wsBooks.keys()]) if (!tokens.includes(t)) wsBooks.delete(t);

  try {
    clobWs?.removeAllListeners();
    clobWs?.close();
  } catch {
    /* already gone */
  }
  const ws = new WebSocket(CLOB_WS_URL);
  clobWs = ws;
  ws.on("open", () => {
    clobWsOk = true;
    ws.send(JSON.stringify({ assets_ids: tokens, type: "market" }));
    log(`clob book ws subscribed (${tokens.length} tokens, push mode)`);
  });
  ws.on("message", (buf) => {
    let msgs;
    try {
      msgs = JSON.parse(buf.toString());
    } catch {
      return;
    }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      const b = wsBooks.get(String(m.asset_id || ""));
      if (!b) continue;
      if (m.event_type === "book") {
        b.bids.clear();
        b.asks.clear();
        for (const l of m.bids || m.buys || []) b.bids.set(String(l.price), Number(l.size));
        for (const l of m.asks || m.sells || []) b.asks.set(String(l.price), Number(l.size));
        b.at = Date.now();
      } else if (m.event_type === "price_change") {
        for (const ch of m.changes || [m]) {
          const side = String(ch.side || "").toUpperCase() === "BUY" ? b.bids : b.asks;
          const size = Number(ch.size);
          if (size > 0) side.set(String(ch.price), size);
          else side.delete(String(ch.price));
        }
        b.at = Date.now();
      }
    }
  });
  ws.on("error", (e) => {
    if (clobWsOk) log("clob book ws error:", e.message);
    clobWsOk = false;
  });
  ws.on("close", () => {
    clobWsOk = false;
    if (clobWs === ws) {
      setTimeout(() => {
        subscribedKey = ""; // force a fresh subscribe
        subscribeBooks(tokens);
      }, 2000).unref();
    }
  });
}

// ---------------------------------------------------------------------------
// Preflight: this bot is meant to run where Binance and Polymarket are
// reachable (the Windows trading box). On a network that blocks them it would
// otherwise sit there quoting nothing, or worse, quote off stale data — so
// fail loudly at startup instead.
// ---------------------------------------------------------------------------

function probeWs(url, label, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let ws;
    const done = (ok, why) => {
      clearTimeout(timer);
      try {
        ws?.removeAllListeners();
        ws?.terminate();
      } catch {
        /* ignore */
      }
      resolve({ label, ok, why });
    };
    const timer = setTimeout(() => done(false, "timeout"), timeoutMs);
    try {
      ws = new WebSocket(url);
      ws.on("open", () => done(true));
      ws.on("error", (e) => done(false, e.message));
    } catch (e) {
      done(false, e.message);
    }
  });
}

async function probeHttp(url, label) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return { label, ok: r.ok, why: r.ok ? "" : `HTTP ${r.status}` };
  } catch (e) {
    return { label, ok: false, why: e.message };
  }
}

async function preflight() {
  const now = Math.floor(Date.now() / 1000);
  const probes = await Promise.all([
    probeHttp(`${BINANCE_REST_HOST}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1`, "binance REST"),
    probeHttp(`${GAMMA_API_HOST}/markets?slug=btc-updown-5m-${Math.floor(now / 300) * 300}`, "gamma API"),
    probeHttp(`${CLOB_API_HOST}/`, "clob REST"),
    probeWs(`${BINANCE_WS_URL}/stream?streams=btcusdt@bookTicker`, "binance ws"),
    probeWs(CLOB_WS_URL, "clob book ws"),
  ]);
  for (const p of probes) log(`preflight ${p.ok ? "OK  " : "FAIL"} ${p.label}${p.why ? " — " + p.why : ""}`);

  // ALL of these are required. The book websocket especially: quoting off 1s
  // REST snapshots means resting orders that lag the market, which is exactly
  // how a maker gets picked off. If it is blocked, this is the wrong machine.
  const bad = probes.filter((p) => !p.ok);
  const wsOk = probes.find((p) => p.label === "clob book ws").ok;

  if (bad.length) {
    if (!skipPreflight) {
      console.error(
        `\nmm-bot will not run here — unreachable: ${bad.map((b) => b.label).join(", ")}\n\n` +
          `This bot is built for the Windows trading machine, where Binance and\n` +
          `Polymarket are both reachable. It needs the CLOB book websocket to quote\n` +
          `safely: on REST polling its resting orders lag the market and get picked\n` +
          `off.\n\n` +
          `To test logic only (no trading value), re-run with MM_SKIP_PREFLIGHT=1.\n`,
      );
      process.exit(1);
    }
    log(
      `MM_SKIP_PREFLIGHT set — running DEGRADED with ${bad.map((b) => b.label).join(", ")} ` +
        `unreachable. Logic test only; do not trade on this.`,
    );
  }
  return { wsOk };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

let journal = [];
try {
  journal = JSON.parse(fs.readFileSync(MM_JOURNAL_FILE, "utf8"));
} catch {
  journal = [];
}
function journalWrite(entry) {
  journal.unshift(entry);
  journal = journal.slice(0, 500);
  const tmp = `${MM_JOURNAL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2));
  fs.renameSync(tmp, MM_JOURNAL_FILE);
}

// ---------------------------------------------------------------------------
// State: one window per series; per token a quote + a position
// ---------------------------------------------------------------------------

const windows = new Map(); // prefix -> window state
let stats = { clips: 0, cuts: 0, held: 0, cutPnl: 0 };

function windowStart(sec, now = Date.now()) {
  return Math.floor(now / 1000 / sec) * sec;
}

function freshLeg(token, outcome) {
  return {
    token, outcome,
    order: null,      // { id, price, size, at }
    position: null,   // { shares, cost, at, entryFair }
    warm: undefined,  // { tickSize, negRisk }
    book: { bid: null, ask: null, at: 0 },
    exited: false,
  };
}

async function rollWindow(s) {
  const start = windowStart(s.seconds);
  const prev = windows.get(s.prefix);
  if (prev && prev.start === start) return prev;
  if (prev) await closeWindow(prev);

  const w = {
    prefix: s.prefix, symbol: s.symbol, seconds: s.seconds, start,
    slug: `${s.prefix}-${start}`, market: null, strike: null, legs: new Map(),
  };
  windows.set(s.prefix, w);

  const st = spot.get(s.symbol);
  w.strike = st?.mid ?? null;
  try {
    w.market = await discoverMarket(w.slug);
    w.legs.set(w.market.upToken, freshLeg(w.market.upToken, "Up"));
    w.legs.set(w.market.downToken, freshLeg(w.market.downToken, "Down"));
    if (!isDryRun && PRIVATE_KEY) {
      const c = await getClob();
      for (const leg of w.legs.values()) {
        const [tickSize, negRisk] = await Promise.all([
          c.getTickSize(leg.token), c.getNegRisk(leg.token),
        ]);
        leg.warm = { tickSize, negRisk };
      }
    }
  } catch (e) {
    log(`[${w.prefix}] discovery failed: ${e.message}`);
  }
  if (!w.strike) await backfillStrike(w);
  log(`[${w.prefix}] window ${w.slug} strike ${w.strike ? w.strike.toFixed(2) : "?"}`);
  return w;
}

/** Strike from the kline whose openTime is the window open (process just started). */
async function backfillStrike(w) {
  try {
    const rows = await fetchJson(
      `${BINANCE_REST_HOST}/api/v3/klines?symbol=${w.symbol}&interval=1m` +
        `&startTime=${w.start * 1000}&limit=1`,
    );
    const open = Number(rows?.[0]?.[1]);
    if (open > 0 && !w.strike) {
      w.strike = open;
      log(`[${w.prefix}] strike backfilled: ${open.toFixed(2)}`);
    }
  } catch (e) {
    log(`[${w.prefix}] strike backfill failed: ${e.message}`);
  }
}

async function closeWindow(w) {
  // pull every resting quote; positions are deliberately left to resolve
  const ids = [...w.legs.values()].map((l) => l.order?.id).filter(Boolean);
  for (const leg of w.legs.values()) leg.order = null;
  if (isDryRun || !ids.length) return;
  try {
    const c = await getClob();
    await c.cancelOrders(ids);
    log(`[${w.prefix}] window closed — cancelled ${ids.length} resting quotes`);
  } catch (e) {
    log(`[${w.prefix}] close-cancel failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Quoting — bid below fair on BOTH sides, independently
// ---------------------------------------------------------------------------

function activeUsdc() {
  let s = 0;
  for (const w of windows.values())
    for (const l of w.legs.values()) if (l.position) s += l.position.cost;
  return s;
}

/** Desired bid for a leg, or null when we shouldn't be quoting it.
 * `why` collects the reason when we decline, for MM_DEBUG. */
function desiredBid(leg, fair, top, why = {}) {
  const want = round2(fair - margin);
  if (!(want >= minPrice && want <= maxPrice)) {
    why.reason = `want ${want} outside band ${minPrice}-${maxPrice}`;
    return null;
  }
  if (want * clipShares < 1) {
    why.reason = `want ${want} x ${clipShares} sh under $1 minimum`;
    return null; // exchange $1 marketable minimum
  }

  // Disagreement guard. When the book prices this leg far away from our fair
  // value, the likelier explanation is that OUR MODEL is wrong — the crowd can
  // see momentum the formula can't. Quoting into that is how a market maker
  // ends up systematically buying the losing side. Sit out instead.
  if (top.bid != null && top.ask != null) {
    const mid = (top.bid + top.ask) / 2;
    if (Math.abs(fair - mid) > maxDisagree) {
      why.reason =
        `book disagrees: fair ${fair.toFixed(3)} vs mid ${mid.toFixed(3)} ` +
        `(gap ${Math.abs(fair - mid).toFixed(3)} > ${maxDisagree})`;
      return null;
    }
  }

  // never cross the ask: a crossing "bid" is a taker buy at someone else's price
  const cap = top.ask != null ? round2(top.ask - 0.01) : want;
  const px = Math.min(want, cap);
  if (!(px >= minPrice && px * clipShares >= 1)) {
    why.reason = `capped px ${px} (ask ${top.ask}) below floor/notional minimum`;
    return null;
  }
  return px;
}

async function placeBid(w, leg, price) {
  if (isDryRun) {
    leg.order = { id: `dry-${leg.token.slice(0, 6)}-${Date.now()}`, price, size: clipShares, at: Date.now() };
    log(`[DRY] [${w.prefix}] quote ${leg.outcome} ${clipShares} sh @ ${price}`);
    return;
  }
  const c = await getClob();
  const order = await c.createOrder(
    { tokenID: leg.token, price, side: c._Side.BUY, size: clipShares },
    leg.warm,
  );
  const resp = await c.postOrder(order, c._OrderType.GTC);
  if (!resp || resp.error || resp.success === false)
    throw new Error(resp?.error || resp?.errorMsg || "rejected");
  leg.order = { id: resp.orderID, price, size: clipShares, at: Date.now() };
  log(`[${w.prefix}] quote ${leg.outcome} ${clipShares} sh @ ${price}`);
}

async function cancelBid(leg) {
  const id = leg.order?.id;
  leg.order = null;
  if (!id || isDryRun) return;
  try {
    const c = await getClob();
    await c.cancelOrders([id]);
  } catch {
    /* already filled or gone */
  }
}

async function manageQuote(w, leg, fair) {
  const t = Date.now() / 1000 - w.start;
  const tau = w.seconds - t;
  const quoting =
    t >= quoteStart && t <= w.seconds * quoteEndFrac && tau > cancelBefore;

  if (!quoting) {
    if (leg.order) await cancelBid(leg);
    return;
  }
  // inventory + capital caps
  const clips = leg.position ? leg.position.shares / clipShares : 0;
  if (clips >= maxClips || activeUsdc() >= maxActiveUsdc) {
    if (leg.order) await cancelBid(leg);
    return;
  }
  const why = {};
  const want = desiredBid(leg, fair, leg.book, why);
  if (want == null) {
    if (debug)
      log(
        `[dbg] [${w.prefix}] no quote ${leg.outcome}: ${why.reason} ` +
          `(book ${leg.book.bid}/${leg.book.ask})`,
      );
    if (leg.order) await cancelBid(leg);
    return;
  }
  if (!leg.order) {
    await placeBid(w, leg, want);
    return;
  }
  // re-quote when fair has moved our target away from where we're resting
  if (Math.abs(want - leg.order.price) >= requoteAt) {
    await cancelBid(leg);
    await placeBid(w, leg, want);
  }
}

// ---------------------------------------------------------------------------
// Fills — the CLOB is the source of truth in live mode
// ---------------------------------------------------------------------------

async function pollFills(w) {
  for (const leg of w.legs.values()) {
    if (!leg.order) continue;
    let matched = 0;
    if (isDryRun) {
      // Simulation: a resting bid only fills when a SELLER crosses into it —
      // i.e. the offer comes down to our price. ("best bid <= our price" would
      // fill constantly, since we quote at/near the bid by construction.)
      if (leg.book.ask != null && leg.book.ask <= leg.order.price) matched = leg.order.size;
    } else {
      try {
        const c = await getClob();
        const o = await c.getOrder(leg.order.id);
        matched = Math.min(Number(o?.size_matched) || 0, leg.order.size);
      } catch {
        continue; // transient; try next poll
      }
    }
    if (matched <= 0) continue;
    const px = leg.order.price;
    const fair = currentFair(w, leg);
    leg.position = leg.position || { shares: 0, cost: 0, at: Date.now(), entryFair: fair };
    leg.position.shares += matched;
    leg.position.cost += matched * px;
    leg.position.at = leg.position.at || Date.now();
    leg.exited = false;
    stats.clips++;
    log(
      `[${w.prefix}] FILLED ${leg.outcome} ${matched} sh @ ${px} ` +
        `(fair ${fair.toFixed(3)}, position ${leg.position.shares} sh)`,
    );
    if (matched >= leg.order.size) leg.order = null;
    else leg.order.size -= matched;
  }
}

// ---------------------------------------------------------------------------
// Exits — cut when fair turns, hold otherwise (the wallet's core behaviour)
// ---------------------------------------------------------------------------

function currentFair(w, leg) {
  const st = spot.get(w.symbol);
  const tau = w.start + w.seconds - Date.now() / 1000;
  const up = fairUp(st.mid, w.strike, tau, perSecVol(w.symbol));
  return leg.outcome === "Up" ? up : 1 - up;
}

/** Why we should cut this position now, or null to keep holding. */
function exitReason(w, leg, fair) {
  const p = leg.position;
  if (!p || leg.exited) return null;
  const tau = w.start + w.seconds - Date.now() / 1000;
  if (tau < exitMinTau) return null; // too late to exit cleanly; let it resolve
  const heldSec = (Date.now() - p.at) / 1000;
  if (fair < exitFairFloor) return `fair ${fair.toFixed(3)} under floor ${exitFairFloor}`;
  if (p.entryFair - fair >= exitFairDrop)
    return `fair fell ${(p.entryFair - fair).toFixed(3)} from entry ${p.entryFair.toFixed(3)}`;
  if (heldSec >= exitMaxHold && fair < 0.5)
    return `held ${Math.round(heldSec)}s and still under 0.50`;
  return null;
}

async function maybeExit(w, leg, fair) {
  const why = exitReason(w, leg, fair);
  if (!why) return;
  const p = leg.position;
  const bid = leg.book.bid;
  if (bid == null) return;
  if (bid * p.shares < 1) {
    leg.exited = true; // unsellable under the $1 minimum — ride to resolution
    log(`[${w.prefix}] cut skipped ${leg.outcome}: ${p.shares} sh @ ${bid} under $1 minimum`);
    return;
  }
  const proceeds = bid * p.shares;
  const pnl = proceeds - p.cost;
  leg.exited = true;
  stats.cuts++;
  stats.cutPnl += pnl;
  const line =
    `[${w.prefix}] CUT ${leg.outcome} ${p.shares} sh @ ${bid} — ${why} ` +
    `(cost $${p.cost.toFixed(2)}, got $${proceeds.toFixed(2)}, ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, ` +
    `held ${Math.round((Date.now() - p.at) / 1000)}s)`;

  if (isDryRun) {
    log(`[DRY] ${line}`);
  } else {
    try {
      const c = await getClob();
      const order = await c.createOrder(
        { tokenID: leg.token, price: bid, side: c._Side.SELL, size: p.shares },
        leg.warm,
      );
      const resp = await c.postOrder(order, c._OrderType.FAK);
      if (!resp || resp.error || resp.success === false)
        throw new Error(resp?.error || resp?.errorMsg || "rejected");
      log(line);
    } catch (e) {
      leg.exited = false; // let the next tick retry the cut
      log(`[${w.prefix}] cut FAILED ${leg.outcome}: ${e.message}`);
      return;
    }
  }
  journalWrite({
    at: Date.now(), slug: w.slug, outcome: leg.outcome, action: "cut", why,
    shares: p.shares, cost: round2(p.cost), proceeds: round2(proceeds), pnl: round2(pnl),
    heldSec: Math.round((Date.now() - p.at) / 1000),
    entryFair: round2(p.entryFair), exitFair: round2(fair), mode: isDryRun ? "dry" : "live",
  });
  leg.position = null;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function refreshBooks(w) {
  // push path: the socket already holds a live book for every subscribed token
  if (clobWsOk) {
    let fresh = true;
    for (const leg of w.legs.values()) {
      const top = wsTop(leg.token);
      if (top && top.at) leg.book = top;
      else fresh = false;
    }
    if (fresh) return; // no REST needed
  }
  // fallback / warm-up: REST snapshot
  await Promise.all(
    [...w.legs.values()].map(async (leg) => {
      try {
        const b = await fetchJson(`${CLOB_API_HOST}/book?token_id=${leg.token}`);
        leg.book = { ...bookTop(b), at: Date.now() };
      } catch {
        /* keep the last book; staleness is checked before quoting */
      }
    }),
  );
}

async function tickSeries(s) {
  const w = await rollWindow(s);
  if (!w.market || !w.strike) return;
  const st = spot.get(w.symbol);
  if (!st?.mid || Date.now() - st.at > 5000) return; // never quote off a stale feed

  await refreshBooks(w);
  await pollFills(w);
  for (const leg of w.legs.values()) {
    // a stale book is worse than no book: quoting off it is how a maker gets
    // picked off after the market has already moved
    if (!leg.book.at || Date.now() - leg.book.at > bookStaleMs) {
      if (leg.order) await cancelBid(leg);
      if (debug) log(`[dbg] [${w.prefix}] ${leg.outcome}: book stale — quote pulled`);
      continue;
    }
    const fair = currentFair(w, leg);
    if (leg.position) await maybeExit(w, leg, fair);
    await manageQuote(w, leg, fair);
  }
}

/** Keep the socket subscribed to exactly the tokens in play right now. */
function syncSubscriptions() {
  const tokens = [];
  for (const w of windows.values()) for (const leg of w.legs.values()) tokens.push(leg.token);
  if (tokens.length) subscribeBooks(tokens);
}

async function tick() {
  await Promise.all(series.map((s) => tickSeries(s).catch((e) => log(`[${s.prefix}] tick error: ${e.message}`))));
  syncSubscriptions();
}

function validate() {
  if (!(margin > 0 && margin < 0.5)) {
    console.error(`MM_MARGIN must be between 0 and 0.5 (got ${MM_MARGIN})`);
    process.exit(1);
  }
  if (!isDryRun && !PRIVATE_KEY) {
    console.error("live mode needs PRIVATE_KEY (+ FUNDER_ADDRESS) in .env");
    process.exit(1);
  }
}

async function main() {
  validate();
  const { wsOk } = await preflight();
  const cadence = wsOk ? loopMs : restLoopMs;
  log(
    `mm-bot starting: [${series.map((s) => s.prefix).join(", ")}] ` +
      `${clipShares} sh clips, quote at fair-${margin}, requote ${requoteAt}, ` +
      `max ${maxClips} clips/side, cap $${maxActiveUsdc}, disagree>${maxDisagree} sits out, ` +
      `exit floor ${exitFairFloor} / drop ${exitFairDrop} / hold ${exitMaxHold}s, ` +
      `books ${wsOk ? "WS push" : "REST poll"} @ ${cadence}ms, ` +
      `mode ${isDryRun ? "DRY (simulated fills)" : "LIVE"}`,
  );
  startBinance();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (e) {
      log("tick error:", e.message || e);
    } finally {
      busy = false;
    }
  }, cadence);
  setInterval(() => {
    log(
      `stats: ${stats.clips} clips filled, ${stats.cuts} cuts, ` +
        `cut P&L ${stats.cutPnl >= 0 ? "+" : ""}$${stats.cutPnl.toFixed(2)}, ` +
        `active $${activeUsdc().toFixed(2)}`,
    );
  }, 60000).unref();
}

if (require.main === module) {
  main().catch((e) => {
    console.error("mm-bot failed to start:", e.message || e);
    process.exit(1);
  });
}

module.exports = { phi, fairUp, desiredBid, exitReason, parseSeries, bookTop, wsTop };
