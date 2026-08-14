/* global React, ReactDOM, htm */
const html = htm.bind(React.createElement);
const { useState, useEffect } = React;

const REFRESH_MS = 3000;

const BADGE_LABEL = {
  success: "COPIED",
  failed: "FAILED",
  pending: "PENDING",
  filtered: "FILTERED",
  stale: "STALE",
  baseline: "BASELINE",
};

function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleString();
}

function money(n) {
  return n == null ? "—" : `$${Number(n).toFixed(2)}`;
}

function Badge({ status }) {
  return html`<span className=${`badge b-${status}`}>${BADGE_LABEL[status] || status}</span>`;
}

function TargetTradeRow({ t }) {
  return html`
    <div className="row">
      <div className="top">
        <span className="title">${t.title || t.slug}</span>
        <${Badge} status=${t.status} />
      </div>
      <div className="meta">
        <span className="outcome">${t.outcome}</span>
        <span>price ${t.theirPrice}</span>
        <span>${money(t.theirUsdc)} (${t.theirShares} sh)</span>
        <span>${t.category}</span>
        <span>${timeAgo(t.tradedAt)}</span>
      </div>
    </div>`;
}

function ResultBadge({ result, copy }) {
  if (!result) return null;
  if (result === "win") {
    const profit = copy?.shares != null && copy?.spentUsdc != null
      ? ` +$${(copy.shares - copy.spentUsdc).toFixed(2)}`
      : "";
    return html`<span className="badge b-success">WIN${profit}</span>`;
  }
  if (result === "loss") {
    const lost = copy?.spentUsdc != null ? ` -$${Number(copy.spentUsdc).toFixed(2)}` : "";
    return html`<span className="badge b-failed">LOSS${lost}</span>`;
  }
  return html`<span className="badge b-filtered">PENDING</span>`;
}

function CopiedTradeRow({ t }) {
  const c = t.copy || {};
  const ok = t.status === "success";
  return html`
    <div className="row">
      <div className="top">
        <span className="title">${t.title || t.slug}</span>
        <span style=${{ display: "inline-flex", gap: 6 }}>
          <span className=${`badge ${c.mode === "live" ? "b-failed" : "b-pending"}`}>
            ${(c.mode || "?").toUpperCase()}
          </span>
          <${Badge} status=${ok ? "success" : "failed"} />
          ${ok && html`<${ResultBadge} result=${t.result} copy=${c} />`}
        </span>
      </div>
      <div className="meta">
        <span className="outcome">${t.outcome}</span>
        ${ok &&
        html`
          <span>price ${c.price}</span>
          <span>${c.shares} shares</span>
          <span>spent ${money(c.spentUsdc)}</span>
        `}
        <span>${timeAgo(c.copiedAt)}</span>
        ${c.orderID && html`<span>order ${c.orderID.slice(0, 10)}…</span>`}
        ${ok && c.txHashes && c.txHashes[0] &&
        html`<a href=${`https://polygonscan.com/tx/${c.txHashes[0]}`} target="_blank" rel="noreferrer">tx ↗</a>`}
      </div>
      ${!ok && c.error && html`<div className="err">${c.error}</div>`}
    </div>`;
}

function App() {
  const [trades, setTrades] = useState([]);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [t, s] = await Promise.all([
          fetch("/api/trades").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
        ]);
        if (alive) {
          setTrades(Array.isArray(t) ? t : []);
          setStatus(s);
        }
      } catch {
        /* server briefly unavailable — keep last data */
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Engine considered online if heartbeat within 3 poll intervals
  const online =
    status?.updatedAt &&
    Date.now() - status.updatedAt < Math.max(15000, (status.pollIntervalMs || 5000) * 3);

  const copied = trades.filter((t) => t.copy);
  const successes = copied.filter((t) => t.status === "success").length;
  const failures = copied.filter((t) => t.status === "failed").length;
  const wins = copied.filter((t) => t.result === "win").length;
  const losses = copied.filter((t) => t.result === "loss").length;

  return html`
    <div>
      <div className="header">
        <h1>Polymarket Copy-Trader</h1>
        ${status?.mode &&
        html`<span className=${`pill ${status.mode}`}>${status.mode === "dry" ? "DRY RUN" : "LIVE"}</span>`}
        <span className=${`pill ${online ? "on" : "off"}`}>${online ? "ENGINE ONLINE" : "ENGINE OFFLINE"}</span>
        ${status && html`
          <span className="stats">
            <span>bet ${money(status.betUsdc)}</span>
            <span>poll ${(status.pollIntervalMs || 0) / 1000}s</span>
            <span>placed ${status.tradesPlaced ?? 0}${status.maxTrades ? `/${status.maxTrades}` : ""}</span>
            <span>
              targets:${" "}
              ${(status.targets || [])
                .map((w) => `${w.category}:${w.address.slice(0, 8)}…${(w.subCategories || []).length ? ` [${w.subCategories.join("|")}]` : ""}`)
                .join(", ")}
            </span>
          </span>`}
      </div>

      <div className="cols">
        <div className="panel">
          <h2>Target trades (${trades.length})</h2>
          <div className="list">
            ${trades.length === 0 && html`<div className="empty">No trades observed yet</div>`}
            ${trades.map((t) => html`<${TargetTradeRow} key=${t.id} t=${t} />`)}
          </div>
        </div>

        <div className="panel">
          <h2>Copied trades (${copied.length}) — ✓ ${successes} ✗ ${failures} · W ${wins} / L ${losses}</h2>
          <div className="list">
            ${copied.length === 0 && html`<div className="empty">Nothing copied yet</div>`}
            ${copied.map((t) => html`<${CopiedTradeRow} key=${t.id} t=${t} />`)}
          </div>
        </div>
      </div>
    </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
