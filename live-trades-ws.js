/**
 * Real-time trade feed from Polymarket's live-data websocket (the stream that
 * powers polymarket.com's activity feed). Trades arrive here in ~1s, versus
 * 13–25s on the REST activity API — this is the copy-trader's primary signal;
 * the poller stays as fallback + reconciliation (dedupe makes overlap safe).
 *
 * Emits rows normalized to the activity-API shape the engine already speaks:
 *   { type:"TRADE", side, transactionHash, asset, conditionId, price, size,
 *     usdcSize, timestamp(sec), title, slug, eventSlug, outcome, outcomeIndex,
 *     proxyWallet }
 *
 * Defensive by design: the exact envelope ({topic,type,payload} vs {data}) can
 * drift, so anything that quacks like a trade (hash + asset + side + wallet)
 * is accepted, single or in arrays.
 */

const DEFAULT_URL = "wss://ws-live-data.polymarket.com";

/** Normalize one raw ws trade object to the activity-API row shape. */
function normalizeTrade(t) {
  if (!t || typeof t !== "object") return null;
  const hash = t.transactionHash || t.transaction_hash;
  const asset = t.asset || t.asset_id || t.assetId;
  const wallet = t.proxyWallet || t.proxy_wallet || t.user || t.maker;
  const side = String(t.side || "").toUpperCase();
  if (!hash || !asset || !wallet || !side) return null;
  const price = Number(t.price);
  const size = Number(t.size);
  let ts = Number(t.timestamp) || Math.floor(Date.now() / 1000);
  if (ts > 1e12) ts = Math.floor(ts / 1000); // ms -> sec
  return {
    type: "TRADE",
    side,
    transactionHash: hash,
    asset: String(asset),
    conditionId: t.conditionId || t.condition_id || "",
    price,
    size,
    usdcSize: Number(t.usdcSize ?? t.usdc_size ?? price * size),
    timestamp: ts,
    title: t.title || t.name || "",
    slug: t.slug || "",
    eventSlug: t.eventSlug || t.event_slug || "",
    outcome: t.outcome || "",
    outcomeIndex: t.outcomeIndex ?? t.outcome_index ?? null,
    proxyWallet: String(wallet).toLowerCase(),
  };
}

/** Recursively pull trade-shaped objects out of any message envelope. */
function extractTrades(msg, out = [], depth = 0) {
  if (depth > 4 || msg == null) return out;
  if (Array.isArray(msg)) {
    for (const m of msg) extractTrades(m, out, depth + 1);
    return out;
  }
  if (typeof msg !== "object") return out;
  const t = normalizeTrade(msg);
  if (t) {
    out.push(t);
    return out;
  }
  for (const k of ["payload", "data", "trades", "message"]) {
    if (msg[k] != null) extractTrades(msg[k], out, depth + 1);
  }
  return out;
}

/**
 * Start the feed. Returns { close(), isConnected() }.
 *  - onTrade(row): called for every normalized trade row seen on the stream
 *  - onStatus(connected): called on connect/disconnect transitions
 *  - WebSocketImpl: injectable for tests (defaults to require("ws"))
 */
function createLiveTradeFeed({
  url = DEFAULT_URL,
  onTrade,
  onStatus = () => {},
  log = console.log,
  WebSocketImpl,
  pingIntervalMs = 20000,
  idleTimeoutMs = 90000,
  maxBackoffMs = 30000,
} = {}) {
  const WebSocket = WebSocketImpl || require("ws");
  let ws = null;
  let closed = false;
  let connected = false;
  let backoff = 1000;
  let pingTimer = null;
  let idleTimer = null;

  const setConnected = (v) => {
    if (connected !== v) {
      connected = v;
      onStatus(v);
    }
  };

  const resetIdle = () => {
    clearTimeout(idleTimer);
    // a healthy stream always has traffic (trades or pongs); silence means
    // a half-dead connection -> force a reconnect
    idleTimer = setTimeout(() => {
      log("ws: no traffic for", idleTimeoutMs / 1000, "s — reconnecting");
      try { ws?.terminate?.(); ws?.close?.(); } catch { /* already dead */ }
    }, idleTimeoutMs);
  };

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log("ws: connect error:", err.message);
      return scheduleReconnect();
    }

    ws.on("open", () => {
      backoff = 1000;
      setConnected(true);
      log("ws: connected to", url);
      // subscribe to the global trades stream (filtering happens engine-side)
      const sub = {
        action: "subscribe",
        subscriptions: [{ topic: "activity", type: "trades" }],
      };
      try { ws.send(JSON.stringify(sub)); } catch (err) { log("ws: subscribe failed:", err.message); }
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try { ws.ping?.(); } catch { /* reconnect via idle timer */ }
      }, pingIntervalMs);
      resetIdle();
    });

    ws.on("message", (raw) => {
      resetIdle();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // non-JSON keepalives are fine
      }
      for (const row of extractTrades(msg)) {
        try { onTrade(row); } catch (err) { log("ws: onTrade error:", err.message); }
      }
    });

    ws.on("pong", resetIdle);

    ws.on("error", (err) => log("ws: error:", err.message));

    ws.on("close", () => {
      setConnected(false);
      clearInterval(pingTimer);
      clearTimeout(idleTimer);
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    log(`ws: reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  };

  connect();

  return {
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(idleTimer);
      try { ws?.close(); } catch { /* fine */ }
    },
    isConnected: () => connected,
  };
}

module.exports = { createLiveTradeFeed, normalizeTrade, extractTrades };
