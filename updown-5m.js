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
  UPDOWN_SLUG_PREFIX = "btc-updown-5m",
  UPDOWN_PAIRS = "5", // paired bets per market
  UPDOWN_SHARES = "5", // shares per order (CLOB limit-order minimum is 5)
  UPDOWN_ENTRY_START_SEC = "60", // entry window inside the 5m market
  UPDOWN_ENTRY_END_SEC = "180",
  UPDOWN_TOTAL_COST = "0.97", // target Up+Down combined bid (must be < 1.00)
  UPDOWN_TAKE_SUM = "0.99", // instant-arb: if askUp+askDown <= this, take both asks immediately (must be < 1.00)
  UPDOWN_CANCEL_BEFORE_CLOSE_SEC = "30",
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
 * Split the combined target between Up and Down proportionally to where the
 * book prices each side, then clamp both bids passive (below the ask — a bid
 * at/above the ask would fill immediately at a combined cost near 1.00, which
 * is exactly the losing trade this strategy exists to avoid).
 * Returns { up, down } or null when the books can't support a sane quote.
 */
function pairPrices(upTop, downTop, target = totalCost) {
  if (!upTop || !downTop) return null;
  const midUp = upTop.bid != null && upTop.ask != null ? (upTop.bid + upTop.ask) / 2 : null;
  const midDown = downTop.bid != null && downTop.ask != null ? (downTop.bid + downTop.ask) / 2 : null;
  if (midUp == null || midDown == null || midUp + midDown <= 0) return null;

  let up = round2((target * midUp) / (midUp + midDown));
  let down = round2(target - up);
  // stay passive: never cross the ask
  if (upTop.ask != null) up = Math.min(up, round2(upTop.ask - 0.01));
  if (downTop.ask != null) down = Math.min(down, round2(downTop.ask - 0.01));
  if (up < 0.01 || down < 0.01) return null;
  if (up + down > target + 1e-9) return null; // clamping can only lower; guard anyway
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

/** Signal mode: this process never touches the CLOB — it appends ndjson rows
 * that copy-trader.js (LOCAL_SIGNALS_FILE) tails and executes under its own
 * wallet, journal, risk gate and dashboard. */
function emitSignal(obj) {
  fs.appendFileSync(SIGNAL_FILE, JSON.stringify(obj) + "\n");
}

function emitPairSignals(pair, kind) {
  const base = {
    type: "buy",
    kind, // post -> GTC at this price; take -> FAK at this price
    slug: state.slug,
    conditionId: state.market.conditionId,
    title: state.market.title || state.slug,
    size: pair.shares,
    timestamp: Math.floor(Date.now() / 1000),
  };
  emitSignal({ ...base, id: `${state.slug}-p${pair.n}-up`, asset: state.market.upToken, outcome: "Up", outcomeIndex: 0, price: pair.up });
  emitSignal({ ...base, id: `${state.slug}-p${pair.n}-down`, asset: state.market.downToken, outcome: "Down", outcomeIndex: 1, price: pair.down });
  log(
    `pair ${pair.n} ${kind.toUpperCase()} -> signals emitted: ` +
      `${pair.shares} Up @ ${pair.up} + ${pair.shares} Down @ ${pair.down} (sum ${pair.sum})`,
  );
}

/** Warm everything slow once, off the hot path: API creds, version cache,
 * per-token tick size + neg-risk, and the HTTP connections themselves. */
async function prewarmMarket(market) {
  const warm = { up: undefined, down: undefined };
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

let state = null; // { start, slug, market, warm, pairs, orderIds, cancelled, bookPrefetch }

function freshState(start) {
  return {
    start,
    slug: `${UPDOWN_SLUG_PREFIX}-${start}`,
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
function prefetchBooks(forPair) {
  const { upToken, downToken } = state.market;
  state.bookPrefetch = {
    forPair,
    promise: Promise.all([
      fetchJson(`${CLOB_API_HOST}/book?token_id=${upToken}`),
      fetchJson(`${CLOB_API_HOST}/book?token_id=${downToken}`),
    ]).catch(() => null),
  };
}

async function placePair(i) {
  // use the prefetched books when they're for this pair; fall back to a live fetch
  const prefetched =
    state.bookPrefetch?.forPair === i ? await state.bookPrefetch.promise : null;
  state.bookPrefetch = null;
  const { upToken, downToken } = state.market;
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
    downTop.askSize >= sharesPerOrder
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
      emitPairSignals(pair, "take");
    } else if (isDryRun) {
      log(
        `[DRY_RUN] pair ${pair.n} TAKE: asks sum ${pair.sum} <= ${takeSum} — would ` +
          `FAK-buy ${sharesPerOrder} Up @ ${pair.up} + ${sharesPerOrder} Down @ ${pair.down} ` +
          `(instant profit $${pair.maxProfit})`,
      );
    } else {
      const [upId, downId] = await Promise.all([
        placeLimitBuy(state.market.upToken, pair.up, sharesPerOrder, state.warm.up, "FAK"),
        placeLimitBuy(state.market.downToken, pair.down, sharesPerOrder, state.warm.down, "FAK"),
      ]);
      pair.orderIds = [upId, downId].filter(Boolean); // FAK never rests; kept for the journal only
      log(`pair ${pair.n} TAKE: bought both asks, sum ${pair.sum} (profit $${pair.maxProfit})`);
    }
    state.pairs.push(pair);
    const snapshot = {
      slug: state.slug,
      start: state.start,
      conditionId: state.market.conditionId,
      mode: isDryRun ? "dry" : "live",
      pairs: [...state.pairs],
    };
    setImmediate(() => journalMarket(snapshot));
    return true;
  }

  const prices = pairPrices(upTop, downTop);
  if (!prices) {
    log(`pair ${i + 1}/${pairsPerMarket}: book too thin/skewed for a ${totalCost} quote — retrying`);
    return false; // slot not consumed; retried next tick until the window closes
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
    emitPairSignals(pair, "post");
  } else if (isDryRun) {
    log(
      `[DRY_RUN] pair ${pair.n}: would bid ${sharesPerOrder} Up @ ${prices.up} + ` +
        `${sharesPerOrder} Down @ ${prices.down} (sum ${pair.sum}, ` +
        `profit if both fill $${pair.maxProfit})`,
    );
  } else {
    const [upId, downId] = await Promise.all([
      placeLimitBuy(state.market.upToken, prices.up, sharesPerOrder, state.warm.up, "GTC"),
      placeLimitBuy(state.market.downToken, prices.down, sharesPerOrder, state.warm.down, "GTC"),
    ]);
    pair.orderIds = [upId, downId].filter(Boolean);
    state.orderIds.push(...pair.orderIds);
    log(
      `pair ${pair.n}: placed ${sharesPerOrder} Up @ ${prices.up} + ` +
        `${sharesPerOrder} Down @ ${prices.down} (sum ${pair.sum})`,
    );
  }

  state.pairs.push(pair);
  // journal off the hot path — the disk write must never delay the next pair
  const snapshot = {
    slug: state.slug,
    start: state.start,
    conditionId: state.market.conditionId,
    mode: isDryRun ? "dry" : "live",
    pairs: [...state.pairs],
  };
  setImmediate(() => journalMarket(snapshot));
  return true;
}

async function cancelOpenOrders() {
  state.cancelled = true;
  if (signalMode) {
    if (state.pairs.some((p) => p.kind === "post")) {
      emitSignal({ type: "cancel", slug: state.slug });
      log(`cancel signal emitted for ${state.slug}`);
    }
    return;
  }
  if (isDryRun || state.orderIds.length === 0) return;
  try {
    const client = await getClobClient();
    await client.cancelOrders(state.orderIds);
    log(`cancelled ${state.orderIds.length} resting orders before close`);
  } catch (err) {
    log("cancel failed (orders may already be filled/expired):", err.message || err);
  }
}

async function tick() {
  const nowSec = Date.now() / 1000;
  const start = currentMarketStart();
  if (!state || state.start !== start) {
    if (state && !state.cancelled) await cancelOpenOrders(); // safety on window roll
    state = freshState(start);
    log(`new market window: ${state.slug} (${new Date(start * 1000).toISOString()})`);
  }
  const t = nowSec - start;

  // discover tokens + prewarm creds/tick-size/connections well before entry
  if (!state.market && t >= Math.max(0, entryStart - 20)) {
    try {
      const market = await discoverMarket(state.slug);
      state.warm = await prewarmMarket(market);
      state.market = market; // set last: pairs only fire once fully warmed
      if (signalMode) {
        // let the copier warm its order path (tick size, neg-risk, client)
        // for these tokens before the first buy signal lands
        emitSignal({ type: "prewarm", slug: state.slug, assets: [market.upToken, market.downToken] });
      }
      log(`market found + prewarmed: ${state.slug} (condition ${market.conditionId.slice(0, 10)}…)`);
    } catch (err) {
      log(`discovery failed for ${state.slug}: ${err.message}`);
      return; // retried next tick
    }
  }

  // place pairs on schedule inside the entry window
  if (state.market && state.pairs.length < pairsPerMarket && t <= entryEnd) {
    const next = state.pairs.length;
    const due = pairTime(next);
    // start the book fetch ~400ms early so placement only waits on postOrder
    if (t >= due - 0.4 && state.bookPrefetch?.forPair !== next) prefetchBooks(next);
    if (t >= due) {
      try {
        await placePair(next);
      } catch (err) {
        log(`pair ${next + 1} failed: ${err.message}`);
      }
    }
  }

  // cancel whatever is still resting shortly before the market closes
  if (!state.cancelled && t >= MARKET_SECONDS - cancelBefore) {
    await cancelOpenOrders();
  }
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
    `updown-5m strategy starting: ${UPDOWN_SLUG_PREFIX}, ${pairsPerMarket} pairs x ` +
      `${sharesPerOrder}+${sharesPerOrder} shares, entry ${entryStart}-${entryEnd}s, ` +
      `target sum ${totalCost}, mode ${signalMode ? "SIGNAL -> copy-trader" : isDryRun ? "DRY" : "LIVE"}`,
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

module.exports = { bookTop, pairPrices, currentMarketStart, pairTime };
