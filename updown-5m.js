/**
 * Standalone 5-minute up/down market-making strategy (btc-updown-5m).
 *
 * Idea: in each 5m market, during the entry window (default minute 1..3),
 * place UPDOWN_PAIRS paired bets. One pair = a passive GTC limit BUY of
 * UPDOWN_SHARES shares on Up AND on Down, priced so the two bids sum to
 * UPDOWN_TOTAL_COST (default 0.97). A pair that fully fills pays exactly
 * $1/share at resolution whichever way the market goes, so every filled pair
 * locks in (1 - sum) x shares profit. The risks are (a) only one leg filling
 * — directional exposure — and (b) nothing filling — no profit, no loss.
 * Unfilled orders are cancelled UPDOWN_CANCEL_BEFORE_CLOSE_SEC before close.
 *
 *   npm run updown          (UPDOWN_DRY_RUN=1 by default: log, don't place)
 *
 * Reuses the copy-trader's .env credentials (PRIVATE_KEY, FUNDER_ADDRESS,
 * SIGNATURE_TYPE) when live. Journals to updown-journal.json.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  CLOB_API_HOST = "https://clob.polymarket.com",
  GAMMA_API_HOST = "https://gamma-api.polymarket.com",
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  SIGNATURE_TYPE = "1",
  UPDOWN_DRY_RUN = "1",
  UPDOWN_SLUG_PREFIX = "btc-updown-5m", // comma-separated for multiple markets, e.g. "btc-updown-5m,eth-updown-5m"
  UPDOWN_PAIRS = "5", // paired bets per market
  UPDOWN_SHARES = "5", // shares per order (CLOB limit-order minimum is 5)
  UPDOWN_ENTRY_START_SEC = "20", // entry window inside the 5m market
  UPDOWN_ENTRY_END_SEC = "200",
  UPDOWN_TOTAL_COST = "0.98", // target Up+Down combined bid (must be < 1.00)
  UPDOWN_TAKE_SUM = "0.99", // instant-arb: if askUp+askDown <= this, take both asks immediately (must be < 1.00)
  UPDOWN_CANCEL_BEFORE_CLOSE_SEC = "30",
  // Leg guard: watches whether both legs of a market actually filled and, when
  // only one did, completes it instead of letting the position ride one-sided.
  // 0 = observe and journal only (no rescue is ever sent); 1 = let it act.
  UPDOWN_HEDGE = "0",
  UPDOWN_HEDGE_GRACE_MS = "1500", // how long a still-live leg gets before we cross
  UPDOWN_MAX_COMPLETE_SUM = "1.00", // paid + completion ask ceiling (1.00 = break even)
  UPDOWN_PAIR_POLL_MS = "500", // fill-state refresh cadence per market
  UPDOWN_JOURNAL_FILE = path.join(__dirname, "updown-journal.json"),
  // BOT_SIGNALS (shared with copy-trader.js): 1 = emit trades as signals for
  // the copier to execute; 0 = this bot places its own orders directly.
  BOT_SIGNALS = "1",
} = process.env;

const SIGNAL_FILE = path.join(__dirname, "updown-signals.ndjson");

const CHAIN_ID = 137;
const MARKET_SECONDS = 300;
const MIN_LIMIT_SHARES = 5;

const isDryRun = UPDOWN_DRY_RUN === "1" || UPDOWN_DRY_RUN.toLowerCase() === "true";
const pairsPerMarket = Math.max(1, Number(UPDOWN_PAIRS) || 5);
const sharesPerOrder = Math.max(MIN_LIMIT_SHARES, Number(UPDOWN_SHARES) || 5);
const entryStart = Number(UPDOWN_ENTRY_START_SEC);
const entryEnd = Number(UPDOWN_ENTRY_END_SEC);
const totalCost = Number(UPDOWN_TOTAL_COST);
const cancelBefore = Number(UPDOWN_CANCEL_BEFORE_CLOSE_SEC);
const takeSum = Number(UPDOWN_TAKE_SUM);
const signalMode = BOT_SIGNALS === "1" || BOT_SIGNALS.toLowerCase() === "true";
const hedgeEnabled = UPDOWN_HEDGE === "1" || UPDOWN_HEDGE.toLowerCase() === "true";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`GET ${url} -> ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Best bid/ask (+ size resting at the best ask) from a CLOB /book payload.
 * Levels are unsorted-ish; be safe. */
function bookTop(book) {
  const bids = (book?.bids || []).map((l) => Number(l.price)).filter(Number.isFinite);
  const askLevels = (book?.asks || [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price));
  const ask = askLevels.length ? Math.min(...askLevels.map((l) => l.price)) : null;
  const askSize = askLevels
    .filter((l) => l.price === ask)
    .reduce((s, l) => s + (Number.isFinite(l.size) ? l.size : 0), 0);
  return {
    bid: bids.length ? Math.max(...bids) : null,
    ask,
    askSize: ask != null ? askSize : 0,
  };
}

const round2 = (p) => Math.round(p * 100) / 100;

/**
 * Price the pair for maximum fill probability within the budget: each side
 * bids as aggressively as allowed — one tick ABOVE the current best bid
 * (front of the queue), capped one tick below the ask (stay passive; crossing
 * would buy at a combined ~1.00+, the losing trade). When the target can't
 * afford top-of-book on both sides, both back off equally — an asymmetric
 * backoff would leave one leg deep in the queue, which is exactly how
 * one-legged fills happen.
 * Returns { up, down } or null when the books can't support a sane quote.
 */
function pairPrices(upTop, downTop, target = totalCost) {
  if (!upTop || !downTop) return null;
  if (upTop.bid == null || upTop.ask == null || downTop.bid == null || downTop.ask == null)
    return null;

  // most aggressive passive price each book allows
  const agg = (t) => Math.min(round2(t.ask - 0.01), round2(t.bid + 0.01));
  const aggUp = agg(upTop);
  const aggDown = agg(downTop);
  let up = aggUp;
  let down = aggDown;

  const excess = round2(up + down - target);
  if (excess > 0) {
    // split the backoff evenly, in whole cents
    up = round2(up - Math.ceil(excess * 50) / 100);
    down = round2(target - up);
    // rounding can push one side past its cap; rebalance within the budget
    if (down > aggDown) {
      down = aggDown;
      up = round2(target - down);
    }
    if (up > aggUp) {
      up = aggUp;
      down = round2(target - up);
    }
  }

  if (up < 0.01 || down < 0.01) return null;
  if (up + down > target + 1e-9) return null;
  if (up > aggUp || down > aggDown) return null; // never cross either ask
  return { up, down };
}

// ---------------------------------------------------------------------------
// Market discovery (gamma API: slug -> clob token ids)
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
  const up = byOutcome.up ?? tokenIds[0];
  const down = byOutcome.down ?? tokenIds[1];
  return {
    slug,
    // human title like "Bitcoin Up or Down - August 22, 2:45PM ET" for the
    // dashboard; falls back to the slug if gamma has no question text
    title: m.question || m.title || slug,
    conditionId: m.conditionId,
    upToken: up,
    downToken: down,
  };
}

// ---------------------------------------------------------------------------
// CLOB client (same bootstrap as copy-trader.js)
// ---------------------------------------------------------------------------

let clobClient = null;
async function getClobClient() {
  if (clobClient) return clobClient;
  const { ClobClient, Side, OrderType } = await import("@polymarket/clob-client-v2");
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
  clobClient._Side = Side;
  clobClient._OrderType = OrderType;
  return clobClient;
}

async function placeLimitBuy(tokenID, price, size, orderOpts, type = "GTC") {
  const client = await getClobClient();
  // orderOpts carries prewarmed { tickSize, negRisk } — with them supplied,
  // createOrder signs locally with zero network round-trips and postOrder is
  // the only call on the wire.
  const order = await client.createOrder(
    { tokenID, price, side: client._Side.BUY, size },
    orderOpts,
  );
  const resp = await client.postOrder(order, client._OrderType[type]);
  if (!resp || resp.error || resp.success === false)
    throw new Error(`order rejected: ${resp?.error || resp?.errorMsg || "unknown"}`);
  return resp.orderID || null;
}

/** Signal mode: this process never touches the CLOB — it hands trades to
 * copy-trader.js, which executes them under its own wallet, journal, risk
 * gate and dashboard. Delivery is a unix socket (sub-ms push) with the
 * ndjson file as durable fallback — the copier dedupes, so both delivering
 * the same line is harmless. */
const net = require("net");
const SIGNAL_FILE_BASE = SIGNAL_FILE;
// Cross-platform IPC endpoint: a unix socket path on macOS/Linux, a named
// pipe on Windows (unix sockets can't be created there). Derived from the
// project dir so two checkouts never collide.
const SIGNAL_SOCKET =
  process.platform === "win32"
    ? "\\\\.\\pipe\\" + __dirname.replace(/[^a-zA-Z0-9]/g, "-") + "-updown-signals"
    : `${SIGNAL_FILE_BASE}.sock`;
let sigSock = null;
let sigSockOk = false;

function connectSignalSocket() {
  if (!signalMode || sigSock) return;
  const s = net.createConnection(SIGNAL_SOCKET);
  s.on("connect", () => {
    sigSockOk = true;
    log("signal socket connected (sub-ms delivery to copy-trader)");
  });
  // The copier replies down the same socket with what became of each signal —
  // which exchange order it turned into, or why it never got placed. That is
  // the only way this process can tell its own legs from an unrelated copy of
  // somebody else's trade in the very same market.
  let rbuf = "";
  s.on("data", (d) => {
    rbuf += d;
    const lines = rbuf.split("\n");
    rbuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        guardOnReply(JSON.parse(line));
      } catch {
        /* a malformed reply must never take the bot down */
      }
    }
  });
  s.on("error", () => {});
  s.on("close", () => {
    sigSockOk = false;
    sigSock = null;
    setTimeout(connectSignalSocket, 1000).unref(); // retry until the copier is up
  });
  sigSock = s;
}
connectSignalSocket();

function emitSignal(obj) {
  const line = JSON.stringify(obj) + "\n";
  if (sigSockOk) {
    try {
      sigSock.write(line); // fast path
    } catch {
      /* file below still delivers */
    }
  }
  fs.appendFileSync(SIGNAL_FILE, line); // durable record + fallback path
}

function emitPairSignals(st, pair, kind) {
  const base = {
    type: "buy",
    kind, // post -> GTC at this price; take -> FAK at this price
    slug: st.slug,
    conditionId: st.market.conditionId,
    title: st.market.title || st.slug,
    size: pair.shares,
    timestamp: Math.floor(Date.now() / 1000),
  };
  emitSignal({ ...base, id: `${st.slug}-p${pair.n}-up`, asset: st.market.upToken, outcome: "Up", outcomeIndex: 0, price: pair.up });
  emitSignal({ ...base, id: `${st.slug}-p${pair.n}-down`, asset: st.market.downToken, outcome: "Down", outcomeIndex: 1, price: pair.down });
  log(
    `[${st.prefix}] pair ${pair.n} ${kind.toUpperCase()} -> signals emitted: ` +
      `${pair.shares} Up @ ${pair.up} + ${pair.shares} Down @ ${pair.down} (sum ${pair.sum})`,
  );
}

// ---------------------------------------------------------------------------
// Leg guard
//
// Rescues travel the same road as every other trade this bot makes: in signal
// mode they go out over the existing unix socket and copy-trader executes them
// under its own wallet and journal; in direct mode this process places them
// itself. The guard never talks to the exchange to trade — only to read fills.
// ---------------------------------------------------------------------------

const guardCfg = {
  act: hedgeEnabled,
  pollMs: Number(UPDOWN_PAIR_POLL_MS) || 500, // fill-state refresh per market
  graceMs: Number(UPDOWN_HEDGE_GRACE_MS), // grace for a leg that can still fill
  graceSkipTicks: 2, // ask this far past our bid = stranded, don't wait
  maxCompleteSum: Number(UPDOWN_MAX_COMPLETE_SUM),
  minNotional: 1, // exchange minimum on a marketable order
  maxAttempts: 3, // rescues one market may send
  retryMs: 1000, // after a hold, how long before looking again
  cancelSettleMs: 150, // let the cancel land before re-reading fills
};

const guardMarkets = new Map(); // slug -> guarded market
const guardStats = { legged: 0, balanced: 0, rescued: 0, naked: 0 };

/** Deliver one guard action. Signal mode hands it to the copier over the same
 * socket every other trade uses; direct mode places it here. Fire-and-forget:
 * the guard must never block the bot's tick. */
function guardSend(msg) {
  if (signalMode) return emitSignal(msg);
  if (isDryRun) {
    log(
      `[DRY_RUN] guard would ` +
        (msg.type === "cancel" ? `cancel ${msg.slug}` : `take ${msg.size} sh @ ${msg.price}`),
    );
    return;
  }
  (async () => {
    try {
      const st = [...states.values()].find((s) => s.slug === msg.slug);
      if (msg.type === "cancel") {
        if (st?.orderIds?.length) (await getClobClient()).cancelOrders(st.orderIds);
        return;
      }
      const warm = msg.asset === st?.market?.upToken ? st?.warm?.up : st?.warm?.down;
      await placeLimitBuy(msg.asset, msg.price, msg.size, warm, "FAK");
    } catch (err) {
      log(`guard send failed (${msg.type}): ${err.message}`);
    }
  })();
}

// Book reads are cached briefly and de-duplicated: the guard runs on the same
// 150ms scheduler that places pairs, so it must never add latency there.
const guardBooks = new Map(); // tokenID -> { at, top, inflight }
async function guardTop(tokenID, { fresh = false } = {}) {
  const hit = guardBooks.get(tokenID);
  if (!fresh && hit) {
    if (hit.inflight) return hit.inflight;
    if (Date.now() - hit.at < 200) return hit.top;
  }
  const inflight = fetchJson(`${CLOB_API_HOST}/book?token_id=${tokenID}`).then((b) => {
    const top = bookTop(b);
    guardBooks.set(tokenID, { at: Date.now(), top, inflight: null });
    return top;
  });
  guardBooks.set(tokenID, { at: hit?.at || 0, top: hit?.top, inflight });
  try {
    return await inflight;
  } catch (err) {
    guardBooks.set(tokenID, { at: 0, top: hit?.top, inflight: null });
    throw err;
  }
}

/** The copier's answer to one of our signals: the exchange order it became, or
 * why it never got placed. A leg that was skipped can never fill, which leaves
 * the market exactly as one-sided as a leg that simply did not — so both are
 * recorded the same way. */
function guardOnReply(msg) {
  if (msg?.type === "cancelled") {
    for (const m of guardMarkets.values()) {
      for (const leg of m.legs.values()) {
        if (msg.orderIds?.includes(leg.orderID)) leg.cancelled = true;
      }
    }
    return;
  }
  if (msg?.type !== "placed" || !msg.id) return;
  for (const m of guardMarkets.values()) {
    const leg = m.legs.get(msg.id);
    if (!leg) continue;
    if (!msg.placed) {
      leg.placed = false;
      leg.done = true;
      leg.reason = msg.reason || "skipped";
      log(`[guard ${m.slug}] leg ${leg.side.toUpperCase()} was not placed (${leg.reason})`);
      return;
    }
    leg.orderID = msg.orderID || null;
    leg.orderType = msg.orderType || "GTC";
    if (msg.size) leg.size = Number(msg.size); // the copier may have resized it
    // a FAK never rests: whatever it matched at submission is all it will ever
    // match, so that number is final
    if (leg.orderType === "FAK") {
      leg.filled = Number(msg.filled) || 0;
      leg.done = true;
    }
    if (msg.dryRun || !leg.orderID) leg.done = true;
    return;
  }
}

// One batched open-orders call per refresh covers every leg of every market
// being watched, instead of one request per leg. Single-flighted so a slow
// response cannot stack up behind the bot's 150ms tick.
let guardOpenSnap = { at: 0, byId: new Map(), inflight: null };
async function guardOpenOrders({ fresh = false } = {}) {
  if (guardOpenSnap.inflight) return guardOpenSnap.inflight;
  if (!fresh && Date.now() - guardOpenSnap.at < guardCfg.pollMs) return guardOpenSnap.byId;
  const inflight = (async () => {
    // guardCfg.readOrders is an injection point for tests; live it is the CLOB
    const rows = guardCfg.readOrders
      ? await guardCfg.readOrders()
      : await (await getClobClient()).getOpenOrders();
    const byId = new Map((rows || []).map((o) => [String(o.id), o]));
    guardOpenSnap = { at: Date.now(), byId, inflight: null };
    return byId;
  })();
  guardOpenSnap.inflight = inflight;
  try {
    return await inflight;
  } catch {
    guardOpenSnap = { at: Date.now(), byId: guardOpenSnap.byId, inflight: null };
    return guardOpenSnap.byId; // keep the last snapshot rather than stalling
  }
}

/**
 * Refresh how much of each leg has filled, reading the orders this strategy
 * actually owns rather than every trade in the market. That distinction
 * matters: the copier also copies other wallets into these same 5m markets, and
 * those trades are indistinguishable from our legs at the market level.
 */
async function guardReadFills(m, { fresh = false } = {}) {
  if (!fresh && Date.now() - m.lastPoll < guardCfg.pollMs) return;
  m.lastPoll = Date.now();
  if (isDryRun) return guardSimulateFills(m);
  try {
    const open = await guardOpenOrders({ fresh });
    for (const leg of m.legs.values()) {
      if (leg.done || !leg.orderID) continue;
      const row = open.get(String(leg.orderID));
      if (row) {
        const matched = Number(row.size_matched);
        if (Number.isFinite(matched)) leg.filled = matched;
        if (leg.filled >= leg.size - 1e-9) leg.done = true;
        continue;
      }
      // gone from the open set means filled, cancelled or expired — one
      // targeted read settles which, once per order rather than once per tick
      try {
        const o = await (await getClobClient()).getOrder(leg.orderID);
        const matched = Number(o?.size_matched);
        if (Number.isFinite(matched)) leg.filled = matched;
      } catch {
        /* a cancelled order can 404 — keep the last reading */
      }
      leg.done = true;
    }
    guardTotalFills(m);
  } catch (err) {
    log(`[guard ${m.slug}] fill read failed: ${err.message}`);
  }
}

/** Roll the per-leg fills up into the market's two sides. The price used is
 * each leg's limit, which for a buy is the most it could have paid — so the
 * completion budget derived from it is conservative, never optimistic. */
function guardTotalFills(m) {
  for (const side of ["up", "down"]) {
    let shares = 0;
    let cost = 0;
    for (const leg of m.legs.values()) {
      if (leg.side !== side || !(leg.filled > 0)) continue;
      shares += leg.filled;
      cost += leg.filled * leg.price;
    }
    m.filled[side] = round2(shares);
    m.vwap[side] = shares > 0 ? cost / shares : 0;
  }
}

/** Dry run has no real fills, so treat a quoted bid as filled once the best ask
 * reaches it — exactly when a seller would have crossed into it. Enough to
 * exercise this whole path on paper. */
async function guardSimulateFills(m) {
  for (const leg of m.legs.values()) {
    if (leg.done || !leg.size) continue;
    try {
      const top = await guardTop(leg.side === "up" ? m.upToken : m.downToken);
      if (top.ask != null && top.ask <= leg.price + 1e-9) {
        leg.filled = leg.size;
        leg.done = true;
      }
    } catch {
      /* keep the last reading */
    }
  }
  guardTotalFills(m);
}

/** Record the guard's verdict on the market's existing journal entry. */
function journalGuard(slug, patch) {
  // The bot writes its own market entry via setImmediate, so the guard can
  // reach here first. Start a stub rather than dropping the verdict — a
  // silently lost observation is worse than an entry with no pairs on it yet.
  let e = journal.find((x) => x.slug === slug);
  if (!e) {
    e = { slug, pairs: [] };
    journal.unshift(e);
  }
  e.guard = { ...(e.guard || {}), ...patch, at: Date.now() };
  setImmediate(() => journalMarket(e));
}

/** Start watching a market once a pair is committed to it. Each leg is keyed by
 * the id the signal carried, which is how the copier's reply finds it again. */
function guardTrackPair(st, pair) {
  let m = guardMarkets.get(st.slug);
  if (!m) {
    m = {
      slug: st.slug,
      title: st.market.title || st.slug,
      conditionId: st.market.conditionId,
      upToken: st.market.upToken,
      downToken: st.market.downToken,
      // real tick size where the prewarm resolved it, 1c otherwise — a market
      // on a finer tick would otherwise be misjudged as stranded
      tick: Number(st.warm?.up?.tickSize) || Number(st.warm?.down?.tickSize) || 0.01,
      legs: new Map(), // signal id -> leg
      filled: { up: 0, down: 0 },
      vwap: { up: 0, down: 0 },
      leggedSince: null,
      graceMs: guardCfg.graceMs,
      attempts: 0,
      status: "open",
      busy: false,
      lastPoll: 0,
      trackedAt: Date.now(),
    };
    guardMarkets.set(st.slug, m);
  }
  for (const side of ["up", "down"]) {
    const id = `${st.slug}-p${pair.n}-${side}`;
    m.legs.set(id, {
      id,
      side,
      price: pair[side],
      size: pair.shares,
      // direct mode gets its order ids straight back from the exchange; signal
      // mode fills them in when the copier replies
      orderID: signalMode ? null : pair.orderIds?.[side === "up" ? 0 : 1] || null,
      orderType: pair.kind === "take" ? "FAK" : "GTC",
      filled: 0,
      done: false,
      placed: true,
      cancelled: false,
    });
  }
}

/** The still-resting leg on one side, if any — what a rescue would cancel. */
function guardRestingLegs(m, side) {
  return [...m.legs.values()].filter(
    (l) => l.side === side && l.placed && !l.done && !l.cancelled && l.orderID,
  );
}

/** How long the lagging leg gets before we cross for it. Waiting only helps
 * while the leg is still plausibly fillable; once the market has walked past
 * our bid the order is stranded, and every extra second is the filled side
 * sliding further out of the money. */
async function guardGrace(m, shortSide) {
  const resting = guardRestingLegs(m, shortSide);
  if (!resting.length) return 0; // nothing is on the book — waiting cannot help
  const quoted = Math.max(...resting.map((l) => l.price));
  try {
    const top = await guardTop(shortSide === "up" ? m.upToken : m.downToken);
    if (top.ask != null && top.ask - quoted > guardCfg.graceSkipTicks * m.tick + 1e-9) {
      log(`[guard ${m.slug}] ${shortSide.toUpperCase()} bid ${quoted} is stranded (ask ${top.ask}) — not waiting`);
      return 0;
    }
  } catch {
    /* fall through to the normal grace */
  }
  return guardCfg.graceMs;
}

/** Could not act this round: stay one-sided but keep watching. The resting leg
 * may still fill, or the ask may come back inside budget. Holding costs
 * nothing, so it never burns a rescue attempt. */
function guardHold(m, patch) {
  m.leggedSince = Date.now();
  m.graceMs = guardCfg.retryMs;
  if (patch) journalGuard(m.slug, patch);
}

async function guardRescue(m) {
  const longSide = m.filled.up > m.filled.down ? "up" : "down";
  const shortSide = longSide === "up" ? "down" : "up";
  const shortToken = shortSide === "up" ? m.upToken : m.downToken;
  let need = round2(Math.abs(m.filled.up - m.filled.down));
  const paid = m.vwap[longSide];
  if (!(paid > 0)) return; // nothing actually filled yet — nothing to rescue
  const exposure = round2(need * paid);

  if (!m.leggedCounted) {
    m.leggedCounted = true;
    guardStats.legged++;
    log(
      `[guard ${m.slug}] LEGGED: ${round2(m.filled[longSide])} sh ${longSide.toUpperCase()} @ ~${round2(paid)}, ` +
        `${shortSide.toUpperCase()} short ${need} sh ($${exposure.toFixed(2)} one-sided)`,
    );
  }

  const budget = round2(guardCfg.maxCompleteSum - paid);
  let top = null;
  try {
    top = await guardTop(shortToken, { fresh: true });
  } catch {
    /* reported below */
  }
  const ask = top?.ask ?? null;
  const pairSum = ask != null ? round2(paid + ask) : null;
  const cost = ask != null ? round2((paid + ask - 1) * need) : null;

  // Observe mode: price the rescue, record it, send nothing. This is how you
  // get legged-rate and rescue-cost numbers before letting it trade.
  if (!guardCfg.act) {
    if (!m.observed) {
      m.observed = true;
      log(
        `[guard ${m.slug}] OBSERVED (UPDOWN_HEDGE=0)` +
          (ask != null
            ? `: completing at ${ask} would make the pair ${pairSum} — ` +
              (cost > 0 ? `cost $${cost.toFixed(2)}` : `still +$${Math.abs(cost).toFixed(2)}`)
            : ": no ask available to price the completion"),
      );
      journalGuard(m.slug, {
        outcome: "legged-observed",
        leggedSide: longSide,
        leggedShares: need,
        exposureUsdc: exposure,
        ask,
        pairSum,
        wouldCostUsdc: cost,
      });
    }
    guardHold(m);
    return;
  }

  // Decide BEFORE touching the resting order. The leg still on the book is the
  // cheapest completion available — it fills at our original price, better than
  // any ask we could cross. Cancelling it and then failing to complete would
  // throw that option away for nothing, so the cancel only happens on the path
  // that actually places the rescue.
  if (ask == null || ask > budget + 1e-9) {
    log(
      `[guard ${m.slug}] CANNOT COMPLETE: ask ${ask ?? "n/a"} is above the ${budget.toFixed(2)} budget ` +
        `(paid ${round2(paid)}, ceiling ${guardCfg.maxCompleteSum}) — holding ${need} sh ` +
        `${longSide.toUpperCase()} ($${exposure.toFixed(2)} at risk), resting leg left in place`,
    );
    guardHold(m, { outcome: "held-expensive", leggedSide: longSide, leggedShares: need, exposureUsdc: exposure, ask });
    return;
  }

  // A rescue under the $1 exchange minimum cannot be sent at all. Buying a few
  // shares more clears it and leaves the surplus on the CHEAP side — worth it
  // whenever that surplus risks less than the naked position it replaces.
  const sizeFor = (shortfall) => {
    if (ask * shortfall >= guardCfg.minNotional) return { size: shortfall };
    const bumped = round2(Math.ceil((guardCfg.minNotional / ask) * 100) / 100);
    const surplusRisk = (bumped - shortfall) * ask;
    if (surplusRisk >= round2(shortfall * paid)) return { size: 0, surplusRisk };
    return { size: bumped, bumpedFrom: shortfall, surplusRisk };
  };

  let sized = sizeFor(need);
  if (!sized.size) {
    log(
      `[guard ${m.slug}] rescue of ${need} sh @ ${ask} is $${(ask * need).toFixed(2)}, under the ` +
        `$${guardCfg.minNotional} minimum and rounding up would risk more than holding`,
    );
    guardHold(m, { outcome: "held-dust", leggedSide: longSide, leggedShares: need, exposureUsdc: exposure });
    return;
  }

  if (m.attempts++ >= guardCfg.maxAttempts) {
    m.status = "naked";
    guardStats.naked++;
    log(`[guard ${m.slug}] giving up after ${guardCfg.maxAttempts} rescue attempts`);
    journalGuard(m.slug, { outcome: "naked", leggedSide: longSide, leggedShares: need, exposureUsdc: exposure });
    return;
  }

  // 1. Cancel what is still resting BEFORE crossing, so the old leg cannot fill
  //    alongside the rescue and leave us long twice on one side. Only the
  //    lagging side's orders are named — other pairs in this market may be
  //    perfectly healthy, and a blanket cancel would take them out too.
  const resting = guardRestingLegs(m, shortSide);
  if (resting.length) {
    guardSend({ type: "cancel", slug: m.slug, orderIds: resting.map((l) => l.orderID) });
    for (const l of resting) l.cancelled = true;
  }

  // 2. re-read fills — the cancel may have raced a fill, and the rescue has to
  //    be sized off what is actually held, not what we believed a moment ago
  await new Promise((r) => setTimeout(r, guardCfg.cancelSettleMs));
  await guardReadFills(m, { fresh: true });
  need = round2(Math.abs(m.filled.up - m.filled.down));
  if (need <= 0) {
    log(`[guard ${m.slug}] filled during the cancel — market is balanced`);
    m.status = "balanced";
    guardStats.balanced++;
    journalGuard(m.slug, { outcome: "balanced" });
    return;
  }
  sized = sizeFor(need); // the shortfall may have shrunk while the cancel landed
  if (!sized.size) {
    log(`[guard ${m.slug}] shortfall shrank to ${need} sh — now under the $${guardCfg.minNotional} minimum, holding`);
    guardHold(m, { outcome: "held-dust", leggedSide: longSide, leggedShares: need });
    return;
  }
  if (sized.bumpedFrom != null) {
    log(
      `[guard ${m.slug}] rescue notional $${(ask * need).toFixed(2)} is under the ` +
        `$${guardCfg.minNotional} minimum — taking ${sized.size} sh instead ` +
        `($${sized.surplusRisk.toFixed(2)} surplus risk vs $${exposure.toFixed(2)} naked)`,
    );
  }

  // 3. complete by taking the other side, never paying past the budget
  const limit = round2(Math.floor(budget * 100) / 100);
  const rescueId = `${m.slug}-rescue${m.attempts}-${shortSide}`;
  // track the rescue as a leg of its own so its fill counts toward the market
  m.legs.set(rescueId, {
    id: rescueId,
    side: shortSide,
    price: limit,
    size: sized.size,
    orderID: null,
    orderType: "FAK",
    filled: 0,
    done: false,
    placed: true,
    cancelled: false,
  });
  guardSend({
    type: "buy",
    kind: "take", // copy-trader turns a take into a FAK
    hedge: true, // exempt from the per-bet cap, risk gate and MAX_TRADES
    id: rescueId,
    slug: m.slug,
    conditionId: m.conditionId,
    title: m.title,
    asset: shortToken,
    outcome: shortSide === "up" ? "Up" : "Down",
    outcomeIndex: shortSide === "up" ? 0 : 1,
    price: limit,
    size: sized.size,
    timestamp: Math.floor(Date.now() / 1000),
  });
  guardStats.rescued++;
  log(
    `[guard ${m.slug}] RESCUE SENT: take ${sized.size} sh ${shortSide.toUpperCase()} up to ${limit} ` +
      `(ask ${ask}, pair sum ~${pairSum}, ` +
      `${cost > 0 ? `locks $${cost.toFixed(2)} loss` : `keeps $${Math.abs(cost).toFixed(2)} profit`})`,
  );
  journalGuard(m.slug, { outcome: "rescue-sent", rescueSide: shortSide, rescueShares: sized.size, ask, pairSum, costUsdc: cost });

  // A FAK is not a promise. It can match nothing at all if the ask moves in the
  // moment between reading the book and the order landing, so the market stays
  // under watch: the next pass confirms it actually balanced, and retries while
  // attempts remain if it did not.
  guardHold(m);
}

/** Driven by the bot's existing 150ms scheduler — no second timer. Reads are
 * throttled and cached, so an idle market costs a map lookup. */
async function guardTick(st) {
  const m = guardMarkets.get(st.slug);
  if (!m || m.status !== "open" || m.busy) return;
  m.busy = true;
  try {
    // Replies only travel the socket. If the copier is delivering via the ndjson
    // fallback instead, no leg ever learns its order id and the guard quietly
    // watches nothing — safe, but not protection. Say so once rather than
    // leaving it silent.
    if (!m.warnedNoIds && Date.now() - m.trackedAt > 5000) {
      m.warnedNoIds = true;
      if (signalMode && ![...m.legs.values()].some((l) => l.orderID || l.placed === false)) {
        log(
          `[guard ${m.slug}] no order ids came back from the copier — the signal socket ` +
            `is probably down, so legs cannot be watched for this market`,
        );
      }
    }
    await guardReadFills(m);
    const imbalance = round2(Math.abs(m.filled.up - m.filled.down));
    const anyFill = m.filled.up > 0 || m.filled.down > 0;

    if (anyFill && imbalance < 1e-9) {
      m.status = "balanced";
      guardStats.balanced++;
      const sum = round2(m.vwap.up + m.vwap.down);
      log(
        `[guard ${m.slug}] BALANCED: ${round2(m.filled.up)} sh each side at a combined ${sum} ` +
          `(locked $${round2((1 - sum) * m.filled.up).toFixed(2)})`,
      );
      journalGuard(m.slug, { outcome: "balanced", pairSum: sum, edgeUsdc: round2((1 - sum) * m.filled.up) });
      return;
    }
    if (!anyFill) return;

    // the clock starts at the FIRST fill, not when the pair was placed — a pair
    // can rest for minutes before anything touches it
    if (m.leggedSince == null) {
      m.leggedSince = Date.now();
      m.graceMs = await guardGrace(m, m.filled.up > m.filled.down ? "down" : "up");
      if (m.graceMs > 0)
        log(`[guard ${m.slug}] one-sided — giving the resting leg ${m.graceMs}ms to fill`);
    }
    if (Date.now() - m.leggedSince < m.graceMs) return;
    await guardRescue(m);
  } catch (err) {
    log(`[guard ${st.slug}] tick error: ${err.message}`);
  } finally {
    m.busy = false;
  }
}

/** Window closing: record how the market actually ended and stop watching. */
function guardCloseMarket(slug) {
  const m = guardMarkets.get(slug);
  if (!m) return;
  if (m.status === "open") {
    const imbalance = round2(Math.abs(m.filled.up - m.filled.down));
    const outcome = imbalance > 0 ? "naked" : m.filled.up > 0 ? "balanced" : "unfilled";
    if (outcome === "naked") guardStats.naked++;
    if (outcome === "balanced") guardStats.balanced++;
    journalGuard(slug, {
      outcome,
      filled: { up: round2(m.filled.up), down: round2(m.filled.down) },
      ...(imbalance > 0 ? { leggedShares: imbalance } : {}),
    });
    log(
      `[guard ${slug}] closed ${outcome} — running tally: ` +
        `${guardStats.balanced} balanced, ${guardStats.legged} legged, ` +
        `${guardStats.rescued} rescued, ${guardStats.naked} left naked`,
    );
  }
  guardMarkets.delete(slug);
}

/** Warm everything slow once, off the hot path: API creds, version cache,
 * per-token tick size + neg-risk, and the HTTP connections themselves. */
async function prewarmMarket(market) {
  const warm = { up: undefined, down: undefined };
  // In signal mode the copier does the trading, but the guard still has to read
  // this account's fills — derive the API creds now (~1s) rather than on the
  // first fill check, which happens while a position is already one-sided.
  if (signalMode && !isDryRun && PRIVATE_KEY) {
    try {
      await getClobClient();
    } catch (err) {
      log(`guard: could not derive read creds (${err.message}) — fill tracking is off`);
    }
  }
  if (!signalMode && !isDryRun && PRIVATE_KEY) {
    const client = await getClobClient(); // creds derivation (~1s) happens here, not on order 1
    try {
      await client.resolveVersion?.();
    } catch {
      /* cached on first order instead */
    }
    const [upTick, upNeg, downTick, downNeg] = await Promise.all([
      client.getTickSize(market.upToken),
      client.getNegRisk(market.upToken),
      client.getTickSize(market.downToken),
      client.getNegRisk(market.downToken),
    ]);
    warm.up = { tickSize: upTick, negRisk: upNeg };
    warm.down = { tickSize: downTick, negRisk: downNeg };
  }
  // touch both books once so the keep-alive connection is open before pair 1
  await Promise.all([
    fetchJson(`${CLOB_API_HOST}/book?token_id=${market.upToken}`).catch(() => {}),
    fetchJson(`${CLOB_API_HOST}/book?token_id=${market.downToken}`).catch(() => {}),
  ]);
  return warm;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const MAX_JOURNAL_MARKETS = 200;
let journal = [];
try {
  journal = JSON.parse(fs.readFileSync(UPDOWN_JOURNAL_FILE, "utf8"));
} catch {
  journal = [];
}
function journalMarket(entry) {
  const i = journal.findIndex((e) => e.slug === entry.slug);
  if (i >= 0) journal[i] = entry;
  else journal.unshift(entry);
  journal = journal.slice(0, MAX_JOURNAL_MARKETS);
  const tmp = `${UPDOWN_JOURNAL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2));
  fs.renameSync(tmp, UPDOWN_JOURNAL_FILE);
}

// ---------------------------------------------------------------------------
// Per-market state machine
// ---------------------------------------------------------------------------

// One independent state machine per market prefix (btc, eth, ...).
const prefixes = UPDOWN_SLUG_PREFIX.split(",").map((s) => s.trim()).filter(Boolean);
const states = new Map(); // prefix -> { start, slug, market, warm, pairs, orderIds, cancelled, bookPrefetch }

function freshState(prefix, start) {
  return {
    prefix,
    start,
    slug: `${prefix}-${start}`,
    market: null,
    warm: { up: undefined, down: undefined }, // prewarmed {tickSize, negRisk} per side
    pairs: [],
    orderIds: [],
    cancelled: false,
    bookPrefetch: null, // { forPair, promise } — books fetched ahead of the pair time
  };
}

/** Second offset inside the market at which pair i (0-based) should be placed. */
function pairTime(i) {
  if (pairsPerMarket === 1) return entryStart;
  return entryStart + (i * (entryEnd - entryStart)) / pairsPerMarket;
}

/** Start fetching both books; done ahead of the pair time so the quote
 * computation has fresh data with zero wait on the placement path. */
function prefetchBooks(st, forPair) {
  const { upToken, downToken } = st.market;
  st.bookPrefetch = {
    forPair,
    promise: Promise.all([
      fetchJson(`${CLOB_API_HOST}/book?token_id=${upToken}`),
      fetchJson(`${CLOB_API_HOST}/book?token_id=${downToken}`),
    ]).catch(() => null),
  };
}

async function placePair(st, i) {
  // use the prefetched books when they're for this pair; fall back to a live fetch
  const prefetched =
    st.bookPrefetch?.forPair === i ? await st.bookPrefetch.promise : null;
  st.bookPrefetch = null;
  const { upToken, downToken } = st.market;
  const [upBook, downBook] =
    prefetched ||
    (await Promise.all([
      fetchJson(`${CLOB_API_HOST}/book?token_id=${upToken}`),
      fetchJson(`${CLOB_API_HOST}/book?token_id=${downToken}`),
    ]));
  const upTop = bookTop(upBook);
  const downTop = bookTop(downBook);

  // Instant arb: when the asks themselves sum under UPDOWN_TAKE_SUM and both
  // have enough depth for a full pair, take them immediately (FAK) — same
  // profit math as a posted pair, but both legs execute in the same moment:
  // zero fill-uncertainty, zero legging risk.
  if (
    upTop.ask != null &&
    downTop.ask != null &&
    upTop.ask + downTop.ask <= takeSum + 1e-9 &&
    upTop.askSize >= sharesPerOrder &&
    downTop.askSize >= sharesPerOrder &&
    // the exchange rejects marketable BUYs under $1 notional — and a leg that
    // cheap means the market is basically decided anyway
    Math.min(upTop.ask, downTop.ask) * sharesPerOrder >= 1
  ) {
    const pair = {
      n: i + 1,
      at: Date.now(),
      kind: "take",
      up: upTop.ask,
      down: downTop.ask,
      sum: round2(upTop.ask + downTop.ask),
      shares: sharesPerOrder,
      maxProfit: round2((1 - upTop.ask - downTop.ask) * sharesPerOrder),
      mode: isDryRun ? "dry" : "live",
      orderIds: [],
    };
    if (signalMode) {
      pair.mode = "signal";
      emitPairSignals(st, pair, "take");
    } else if (isDryRun) {
      log(
        `[DRY_RUN] pair ${pair.n} TAKE: asks sum ${pair.sum} <= ${takeSum} — would ` +
          `FAK-buy ${sharesPerOrder} Up @ ${pair.up} + ${sharesPerOrder} Down @ ${pair.down} ` +
          `(instant profit $${pair.maxProfit})`,
      );
    } else {
      const [upId, downId] = await Promise.all([
        placeLimitBuy(st.market.upToken, pair.up, sharesPerOrder, st.warm.up, "FAK"),
        placeLimitBuy(st.market.downToken, pair.down, sharesPerOrder, st.warm.down, "FAK"),
      ]);
      pair.orderIds = [upId, downId].filter(Boolean); // FAK never rests; kept for the journal only
      log(`[${st.prefix}] pair ${pair.n} TAKE: bought both asks, sum ${pair.sum} (profit $${pair.maxProfit})`);
    }
    st.pairs.push(pair);
    guardTrackPair(st, pair);
    const snapshot = {
      slug: st.slug,
      start: st.start,
      conditionId: st.market.conditionId,
      mode: isDryRun ? "dry" : "live",
      pairs: [...st.pairs],
    };
    setImmediate(() => journalMarket(snapshot));
    return true;
  }

  const prices = pairPrices(upTop, downTop);
  if (!prices) {
    log(`[${st.prefix}] pair ${i + 1}/${pairsPerMarket}: book too thin/skewed for a ${totalCost} quote — retrying`);
    return false; // slot not consumed; retried next tick until the window closes
  }
  // Cheap-leg floor: if a bid crosses the book by the time it lands, the CLOB
  // treats it as marketable and enforces a $1 minimum — a sub-$1 leg can be
  // rejected. A leg that cheap also means the market is nearly decided:
  // worst completion odds, worst legging risk. Skip and retry; if the skew
  // persists, this market simply gets no pair.
  if (Math.min(prices.up, prices.down) * sharesPerOrder < 1) {
    log(
      `[${st.prefix}] pair ${i + 1}/${pairsPerMarket}: cheap leg ` +
        `$${(Math.min(prices.up, prices.down) * sharesPerOrder).toFixed(2)} is under the ` +
        `$1 exchange minimum (market too decided) — retrying`,
    );
    return false;
  }

  const pair = {
    n: i + 1,
    at: Date.now(),
    kind: "post",
    up: prices.up,
    down: prices.down,
    sum: round2(prices.up + prices.down),
    shares: sharesPerOrder,
    maxProfit: round2((1 - prices.up - prices.down) * sharesPerOrder),
    mode: isDryRun ? "dry" : "live",
    orderIds: [],
  };

  if (signalMode) {
    pair.mode = "signal";
    emitPairSignals(st, pair, "post");
  } else if (isDryRun) {
    log(
      `[DRY_RUN] pair ${pair.n}: would bid ${sharesPerOrder} Up @ ${prices.up} + ` +
        `${sharesPerOrder} Down @ ${prices.down} (sum ${pair.sum}, ` +
        `profit if both fill $${pair.maxProfit})`,
    );
  } else {
    const [upId, downId] = await Promise.all([
      placeLimitBuy(st.market.upToken, prices.up, sharesPerOrder, st.warm.up, "GTC"),
      placeLimitBuy(st.market.downToken, prices.down, sharesPerOrder, st.warm.down, "GTC"),
    ]);
    pair.orderIds = [upId, downId].filter(Boolean);
    st.orderIds.push(...pair.orderIds);
    log(
      `[${st.prefix}] pair ${pair.n}: placed ${sharesPerOrder} Up @ ${prices.up} + ` +
        `${sharesPerOrder} Down @ ${prices.down} (sum ${pair.sum})`,
    );
  }

  st.pairs.push(pair);
  guardTrackPair(st, pair);
  // journal off the hot path — the disk write must never delay the next pair
  const snapshot = {
    slug: st.slug,
    start: st.start,
    conditionId: st.market.conditionId,
    mode: isDryRun ? "dry" : "live",
    pairs: [...st.pairs],
  };
  setImmediate(() => journalMarket(snapshot));
  return true;
}

async function cancelOpenOrders(st) {
  st.cancelled = true;
  guardCloseMarket(st.slug); // settle the market's leg record before it rolls
  if (signalMode) {
    if (st.pairs.some((p) => p.kind === "post")) {
      emitSignal({ type: "cancel", slug: st.slug });
      log(`[${st.prefix}] cancel signal emitted for ${st.slug}`);
    }
    return;
  }
  if (isDryRun || st.orderIds.length === 0) return;
  try {
    const client = await getClobClient();
    await client.cancelOrders(st.orderIds);
    log(`[${st.prefix}] cancelled ${st.orderIds.length} resting orders before close`);
  } catch (err) {
    log("cancel failed (orders may already be filled/expired):", err.message || err);
  }
}

async function tickMarket(prefix) {
  const nowSec = Date.now() / 1000;
  const start = currentMarketStart();
  let st = states.get(prefix);
  if (!st || st.start !== start) {
    if (st && !st.cancelled) await cancelOpenOrders(st); // safety on window roll
    st = freshState(prefix, start);
    states.set(prefix, st);
    log(`[${prefix}] new market window: ${st.slug} (${new Date(start * 1000).toISOString()})`);
  }
  const t = nowSec - start;

  // discover tokens + prewarm creds/tick-size/connections well before entry
  if (!st.market && t >= Math.max(0, entryStart - 20)) {
    try {
      const market = await discoverMarket(st.slug);
      st.warm = await prewarmMarket(market);
      st.market = market; // set last: pairs only fire once fully warmed
      if (signalMode) {
        // let the copier warm its order path (tick size, neg-risk, client)
        // for these tokens before the first buy signal lands
        emitSignal({ type: "prewarm", slug: st.slug, assets: [market.upToken, market.downToken] });
      }
      log(`[${prefix}] market found + prewarmed: ${st.slug} (condition ${market.conditionId.slice(0, 10)}…)`);
    } catch (err) {
      log(`[${prefix}] discovery failed for ${st.slug}: ${err.message}`);
      return; // retried next tick
    }
  }

  // place pairs on schedule inside the entry window
  if (st.market && st.pairs.length < pairsPerMarket && t <= entryEnd) {
    const next = st.pairs.length;
    const due = pairTime(next);
    // start the book fetch ~400ms early so placement only waits on postOrder
    if (t >= due - 0.4 && st.bookPrefetch?.forPair !== next) prefetchBooks(st, next);
    if (t >= due) {
      try {
        await placePair(st, next);
      } catch (err) {
        log(`[${prefix}] pair ${next + 1} failed: ${err.message}`);
      }
    }
  }

  // Watch the fills. Runs on this same 150ms scheduler rather than a timer of
  // its own: the reads inside are throttled and cached, and an idle market
  // costs nothing but a map lookup.
  if (st.market && st.pairs.length) guardTick(st);

  // cancel whatever is still resting shortly before the market closes
  if (!st.cancelled && t >= MARKET_SECONDS - cancelBefore) {
    await cancelOpenOrders(st);
  }
}

async function tick() {
  // markets are independent; run their machines concurrently each tick
  await Promise.all(prefixes.map((p) => tickMarket(p)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function validate() {
  if (!(totalCost > 0 && totalCost < 1)) {
    console.error(`UPDOWN_TOTAL_COST must be between 0 and 1 (got ${UPDOWN_TOTAL_COST})`);
    process.exit(1);
  }
  if (!(takeSum > 0 && takeSum < 1)) {
    console.error(`UPDOWN_TAKE_SUM must be between 0 and 1 (got ${UPDOWN_TAKE_SUM})`);
    process.exit(1);
  }
  const completeSum = Number(UPDOWN_MAX_COMPLETE_SUM);
  if (!(completeSum >= totalCost && completeSum <= 1.2)) {
    console.error(
      `UPDOWN_MAX_COMPLETE_SUM must be between the target sum (${totalCost}) and 1.2 ` +
        `(got ${UPDOWN_MAX_COMPLETE_SUM}) — below the target it can never complete, ` +
        `above 1.2 a "rescue" costs more than the leg it saves`,
    );
    process.exit(1);
  }
  if (!(entryStart >= 0 && entryEnd > entryStart && entryEnd < MARKET_SECONDS)) {
    console.error("entry window must satisfy 0 <= START < END < 300 seconds");
    process.exit(1);
  }
  if (!signalMode && !isDryRun && !PRIVATE_KEY) {
    console.error("live mode needs PRIVATE_KEY (+ FUNDER_ADDRESS) in .env");
    process.exit(1);
  }
}

if (require.main === module) {
  validate();
  log(
    `updown-5m strategy starting: [${prefixes.join(", ")}], ${pairsPerMarket} pairs x ` +
      `${sharesPerOrder}+${sharesPerOrder} shares, entry ${entryStart}-${entryEnd}s, ` +
      `target sum ${totalCost}, mode ${signalMode ? "SIGNAL -> copy-trader" : isDryRun ? "DRY" : "LIVE"}`,
  );
  log(
    hedgeEnabled
      ? `leg guard ACTIVE: completes a one-sided market up to a combined ` +
          `${Number(UPDOWN_MAX_COMPLETE_SUM).toFixed(2)}, after ${UPDOWN_HEDGE_GRACE_MS}ms of grace ` +
          `(rescues go out over the signal path)`
      : `leg guard OBSERVING (UPDOWN_HEDGE=0): measures legging and what a rescue ` +
          `would cost, sends nothing — see updown-pairs.json`,
  );
  let busy = false;
  // 150ms scheduler: a pair fires within ~150ms of its slot instead of up to
  // 1s late. Idle ticks are pure clock math — no network, no disk.
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (err) {
      log("tick error:", err.message || err);
    } finally {
      busy = false;
    }
  }, 150);
}

module.exports = {
  bookTop,
  pairPrices,
  currentMarketStart,
  pairTime,
  // leg guard internals, exported for tests
  guardCfg,
  guardStats,
  guardMarkets,
  guardTrackPair,
  guardOnReply,
  guardTick,
  guardCloseMarket,
};
