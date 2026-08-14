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
        <span className="title">
          ${t.slug
            ? html`<a href=${`https://polymarket.com/event/${t.slug}`} target="_blank" rel="noreferrer">${t.title || t.slug}</a>`
            : t.title}
        </span>
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
          <span>trader ${money(t.theirUsdc)} → us ${money(c.spentUsdc)}</span>
        `}
        <span>${timeAgo(c.copiedAt)}</span>
        ${c.orderID && html`<span>order ${c.orderID.slice(0, 10)}…</span>`}
        ${ok && c.txHashes && c.txHashes[0] &&
        html`<a href=${`https://polygonscan.com/tx/${c.txHashes[0]}`} target="_blank" rel="noreferrer">tx ↗</a>`}
      </div>
      ${!ok && c.error && html`<div className="err">${c.error}</div>`}
    </div>`;
}

// Win/loss chart colors — validated for the dark surface (#161b24):
// lightness band, chroma, contrast >=3:1, CVD separation with gaps+legend+labels.
const C_WIN = "#29a75e";
const C_LOSS = "#c04a5c";
const C_PENDING = "#5c6675";

function StatTile({ label, value, tone }) {
  return html`
    <div className="tile">
      <div className="tile-label">${label}</div>
      <div className="tile-value" style=${tone ? { color: tone } : null}>${value}</div>
    </div>`;
}

/** Hourly buckets of copied trades: { label, win, loss, pending }. */
function bucketize(copied) {
  const byHour = new Map();
  for (const t of copied) {
    if (t.status !== "success") continue;
    const ts = t.copy?.copiedAt || t.observedAt;
    if (!ts) continue;
    const d = new Date(ts);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    if (!byHour.has(key)) byHour.set(key, { key, win: 0, loss: 0, pending: 0 });
    const b = byHour.get(key);
    if (t.result === "win") b.win++;
    else if (t.result === "loss") b.loss++;
    else b.pending++;
  }
  return [...byHour.values()]
    .sort((a, b) => a.key - b.key)
    .slice(-24)
    .map((b) => ({
      ...b,
      total: b.win + b.loss + b.pending,
      label: new Date(b.key).toLocaleTimeString([], { hour: "numeric" }),
    }));
}

function WinLossChart({ copied }) {
  const [tip, setTip] = useState(null);
  const buckets = bucketize(copied);
  if (buckets.length === 0)
    return html`<div className="empty">No resolved copies to chart yet</div>`;

  const W = 640, H = 170, padL = 28, padB = 20, padT = 14;
  const plotW = W - padL - 6, plotH = H - padT - padB;
  const maxY = Math.max(...buckets.map((b) => b.total), 1);
  const yTicks = maxY <= 4 ? maxY : 4;
  const bw = Math.min(28, (plotW / buckets.length) * 0.6);
  const step = plotW / buckets.length;
  const y = (n) => padT + plotH - (n / maxY) * plotH;

  const seg = (b, i, from, count, color, name) => {
    if (!count) return null;
    const x = padL + i * step + (step - bw) / 2;
    const y0 = y(from), y1 = y(from + count);
    return html`<rect
      key=${name + i} x=${x} y=${y1} width=${bw} height=${Math.max(1, y0 - y1)}
      rx="2" fill=${color} stroke="var(--panel)" strokeWidth="2"
      onMouseEnter=${(e) => setTip({ x: e.clientX, y: e.clientY, text: `${b.label} — ${name}: ${count} (total ${b.total})` })}
      onMouseLeave=${() => setTip(null)}
    />`;
  };

  return html`
    <div style=${{ position: "relative" }}>
      <svg viewBox=${`0 0 ${W} ${H}`} style=${{ width: "100%", display: "block" }}>
        ${Array.from({ length: yTicks + 1 }, (_, i) => {
          const v = Math.round((maxY / yTicks) * i);
          return html`<g key=${"t" + i}>
            <line x1=${padL} x2=${W - 6} y1=${y(v)} y2=${y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x=${padL - 6} y=${y(v) + 3} textAnchor="end" fontSize="9" fill="var(--dim)">${v}</text>
          </g>`;
        })}
        ${buckets.map((b, i) => html`<g key=${"b" + i}>
          ${seg(b, i, 0, b.win, C_WIN, "wins")}
          ${seg(b, i, b.win, b.loss, C_LOSS, "losses")}
          ${seg(b, i, b.win + b.loss, b.pending, C_PENDING, "pending")}
          ${b.total > 0 && html`<text x=${padL + i * step + step / 2} y=${y(b.total) - 4}
            textAnchor="middle" fontSize="9" fill="var(--dim)">${b.total}</text>`}
          <text x=${padL + i * step + step / 2} y=${H - 6} textAnchor="middle" fontSize="9" fill="var(--dim)">${b.label}</text>
        </g>`)}
      </svg>
      <div className="legend">
        <span><i style=${{ background: C_WIN }}></i>Wins</span>
        <span><i style=${{ background: C_LOSS }}></i>Losses</span>
        <span><i style=${{ background: C_PENDING }}></i>Pending</span>
      </div>
      ${tip && html`<div className="tooltip" style=${{ left: 0, top: 0, position: "fixed", transform: `translate(${tip.x + 12}px, ${tip.y + 12}px)` }}>${tip.text}</div>`}
    </div>`;
}

/** Cumulative net P/L line over resolved copied trades, in copy order. */
function PnlChart({ copied }) {
  const [tip, setTip] = useState(null);
  const resolved = copied
    .filter((t) => t.status === "success" && (t.result === "win" || t.result === "loss"))
    .sort((a, b) => (a.copy?.copiedAt || 0) - (b.copy?.copiedAt || 0));
  if (resolved.length < 2)
    return html`<div className="empty">Need at least 2 resolved bets to chart P/L</div>`;

  let cum = 0;
  const pts = resolved.map((t) => {
    const delta = t.result === "win"
      ? (t.copy?.shares || 0) - (t.copy?.spentUsdc || 0)
      : -(t.copy?.spentUsdc || 0);
    cum += delta;
    return { t, delta, cum, at: t.copy?.copiedAt };
  });

  const W = 640, H = 150, padL = 40, padR = 10, padT = 12, padB = 18;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const lo = Math.min(0, ...pts.map((p) => p.cum));
  const hi = Math.max(0, ...pts.map((p) => p.cum));
  const span = hi - lo || 1;
  const x = (i) => padL + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - lo) / span) * plotH;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const lineColor = "#4c9aff";
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));

  return html`
    <div style=${{ position: "relative" }}>
      <div style=${{ fontSize: 12, color: "var(--dim)", margin: "10px 0 2px" }}>Net P/L over time (cumulative, resolved bets)</div>
      <svg viewBox=${`0 0 ${W} ${H}`} style=${{ width: "100%", display: "block" }}>
        ${[lo, (lo + hi) / 2, hi].map((v, i) => html`<g key=${"g" + i}>
          <line x1=${padL} x2=${W - padR} y1=${y(v)} y2=${y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x=${padL - 6} y=${y(v) + 3} textAnchor="end" fontSize="9" fill="var(--dim)">$${v.toFixed(v % 1 ? 2 : 0)}</text>
        </g>`)}
        ${lo < 0 && hi > 0 &&
        html`<line x1=${padL} x2=${W - padR} y1=${y(0)} y2=${y(0)} stroke="var(--gray)" strokeWidth="1" strokeDasharray="3 3" />`}
        <path d=${path} fill="none" stroke=${lineColor} strokeWidth="2" strokeLinejoin="round" />
        ${pts.map((p, i) => html`<g key=${"p" + i}>
          <circle cx=${x(i)} cy=${y(p.cum)} r="2.5" fill=${lineColor} stroke="var(--panel)" strokeWidth="1.5" />
          <circle cx=${x(i)} cy=${y(p.cum)} r="9" fill="transparent"
            onMouseEnter=${(e) => setTip({
              x: e.clientX, y: e.clientY,
              text: `${new Date(p.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — ${p.t.result === "win" ? "win" : "loss"} ${p.delta >= 0 ? "+" : "-"}$${Math.abs(p.delta).toFixed(2)} → total ${p.cum >= 0 ? "+" : "-"}$${Math.abs(p.cum).toFixed(2)}`,
            })}
            onMouseLeave=${() => setTip(null)} />
          ${i % labelEvery === 0 &&
          html`<text x=${x(i)} y=${H - 5} textAnchor="middle" fontSize="9" fill="var(--dim)">
            ${new Date(p.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </text>`}
        </g>`)}
        <text x=${x(pts.length - 1)} y=${y(last.cum) - 8} textAnchor="end" fontSize="10" fontWeight="700"
          fill=${last.cum >= 0 ? C_WIN : C_LOSS}>
          ${last.cum >= 0 ? "+" : "-"}$${Math.abs(last.cum).toFixed(2)}
        </text>
      </svg>
      ${tip && html`<div className="tooltip" style=${{ left: 0, top: 0, position: "fixed", transform: `translate(${tip.x + 12}px, ${tip.y + 12}px)` }}>${tip.text}</div>`}
    </div>`;
}

function Analytics({ copied }) {
  const ok = copied.filter((t) => t.status === "success");
  const wins = ok.filter((t) => t.result === "win");
  const losses = ok.filter((t) => t.result === "loss");
  const resolved = wins.length + losses.length;
  const winRate = resolved ? Math.round((wins.length / resolved) * 100) : null;
  // lifetime totals: copied trades are never evicted from the journal
  const totalProfit = wins.reduce(
    (s, t) => s + ((t.copy?.shares || 0) - (t.copy?.spentUsdc || 0)), 0);
  const totalLoss = losses.reduce((s, t) => s + (t.copy?.spentUsdc || 0), 0);
  const pnl = totalProfit - totalLoss;
  const totalSpent = ok.reduce((s, t) => s + (t.copy?.spentUsdc || 0), 0);
  // money still riding on unresolved markets
  const active = ok
    .filter((t) => t.result !== "win" && t.result !== "loss")
    .reduce((s, t) => s + (t.copy?.spentUsdc || 0), 0);

  return html`
    <div className="panel" style=${{ marginBottom: 16 }}>
      <h2>Analytics</h2>
      <div className="tiles">
        <${StatTile} label="Copied trades" value=${ok.length} />
        <${StatTile} label="Wins" value=${wins.length} tone=${C_WIN} />
        <${StatTile} label="Losses" value=${losses.length} tone=${C_LOSS} />
        <${StatTile} label="Win rate" value=${winRate == null ? "—" : winRate + "%"} />
        <${StatTile} label="Net P/L (resolved)" value=${`${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`} tone=${resolved ? (pnl >= 0 ? C_WIN : C_LOSS) : null} />
        <${StatTile} label="Lifetime profit" value=${`+$${totalProfit.toFixed(2)}`} tone=${totalProfit > 0 ? C_WIN : null} />
        <${StatTile} label="Lifetime loss" value=${`-$${totalLoss.toFixed(2)}`} tone=${totalLoss > 0 ? C_LOSS : null} />
        <${StatTile} label="Total spent" value=${`$${totalSpent.toFixed(2)}`} />
        <${StatTile} label="Active in trading" value=${`$${active.toFixed(2)}`} tone=${active > 0 ? "#4c9aff" : null} />
      </div>
      <div style=${{ padding: "0 14px 12px" }}>
        <${WinLossChart} copied=${copied} />
        <${PnlChart} copied=${copied} />
      </div>
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
            <span>bet ${status.betMode === "mirror" ? `mirror (cap ${money(status.betUsdc)})` : money(status.betUsdc)}</span>
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

      <${Analytics} copied=${copied} />

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
