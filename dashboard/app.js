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

/* global Recharts */
const {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine, LabelList,
} = Recharts;

// Hardcoded theme colors for chart internals (SVG attributes can't use CSS vars)
const CH = { grid: "#232a36", ink: "#7d8899", surface: "#161b24", tipBg: "#0a0d12" };
const TIP_STYLE = {
  contentStyle: { background: CH.tipBg, border: `1px solid ${CH.grid}`, borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#dbe2ee" },
  cursor: { fill: "rgba(125,136,153,0.08)" },
};

function WinLossChart({ copied }) {
  const buckets = bucketize(copied);
  if (buckets.length === 0)
    return html`<div className="empty">No resolved copies to chart yet</div>`;

  return html`
    <${ResponsiveContainer} width="100%" height=${200}>
      <${BarChart} data=${buckets} margin=${{ top: 14, right: 8, left: -24, bottom: 0 }} barCategoryGap="35%">
        <${CartesianGrid} vertical=${false} stroke=${CH.grid} />
        <${XAxis} dataKey="label" tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${{ stroke: CH.grid }} tickLine=${false} />
        <${YAxis} allowDecimals=${false} tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${false} tickLine=${false} />
        <${Tooltip} ...${TIP_STYLE} />
        <${Legend} wrapperStyle=${{ fontSize: 12 }} />
        <${Bar} dataKey="win" name="Wins" stackId="a" fill=${C_WIN} stroke=${CH.surface} strokeWidth=${1} />
        <${Bar} dataKey="loss" name="Losses" stackId="a" fill=${C_LOSS} stroke=${CH.surface} strokeWidth=${1} />
        <${Bar} dataKey="pending" name="Pending" stackId="a" fill=${C_PENDING} stroke=${CH.surface} strokeWidth=${1}>
          <${LabelList} dataKey="total" position="top" style=${{ fontSize: 10, fill: CH.ink }} />
        <//>
      <//>
    <//>`;
}

function fmtMoney(v) {
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}

function PnlTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return html`
    <div className="tooltip">
      ${p.label} — ${p.result} ${fmtMoney(p.delta)} → total ${fmtMoney(p.cum)}
    </div>`;
}

/** Cumulative net P/L line over resolved copied trades, in copy order. */
function PnlChart({ copied }) {
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
    return {
      label: new Date(t.copy?.copiedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      result: t.result,
      delta: Number(delta.toFixed(2)),
      cum: Number(cum.toFixed(2)),
    };
  });
  const last = pts[pts.length - 1];

  return html`
    <div>
      <div style=${{ fontSize: 12, color: "var(--dim)", margin: "10px 0 2px" }}>
        Net P/L over time (cumulative, resolved bets) —${" "}
        <b style=${{ color: last.cum >= 0 ? C_WIN : C_LOSS }}>${fmtMoney(last.cum)}</b>
      </div>
      <${ResponsiveContainer} width="100%" height=${180}>
        <${LineChart} data=${pts} margin=${{ top: 10, right: 12, left: -16, bottom: 0 }}>
          <${CartesianGrid} vertical=${false} stroke=${CH.grid} />
          <${XAxis} dataKey="label" tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${{ stroke: CH.grid }} tickLine=${false} interval="preserveStartEnd" minTickGap=${30} />
          <${YAxis} tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${false} tickLine=${false} tickFormatter=${(v) => `$${v}`} domain=${["auto", "auto"]} />
          <${Tooltip} content=${html`<${PnlTooltip} />`} cursor=${{ stroke: CH.ink, strokeDasharray: "3 3" }} />
          <${ReferenceLine} y=${0} stroke=${CH.ink} strokeDasharray="3 3" />
          <${Line} type="monotone" dataKey="cum" name="Net P/L" stroke="#4c9aff" strokeWidth=${2}
            dot=${{ r: 2.5, fill: "#4c9aff", stroke: CH.surface, strokeWidth: 1.5 }}
            activeDot=${{ r: 5 }} isAnimationActive=${false} />
        <//>
      <//>
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

  const [copyFilter, setCopyFilter] = useState("all");

  const copied = trades.filter((t) => t.copy);
  const successes = copied.filter((t) => t.status === "success").length;
  const failures = copied.filter((t) => t.status === "failed").length;
  const copyFilterFn = {
    all: () => true,
    win: (t) => t.result === "win",
    loss: (t) => t.result === "loss",
    pending: (t) => t.status === "success" && t.result === "pending",
    failed: (t) => t.status === "failed",
  };
  const [copySort, setCopySort] = useState("recent"); // recent | bet-desc | bet-asc
  const nextSort = { recent: "bet-desc", "bet-desc": "bet-asc", "bet-asc": "recent" };
  const sortLabel = { recent: "recent", "bet-desc": "bet ↓", "bet-asc": "bet ↑" };

  const shownCopied = copied
    .filter(copyFilterFn[copyFilter] || copyFilterFn.all)
    .sort((a, b) => {
      if (copySort === "bet-desc") return (b.copy?.spentUsdc || 0) - (a.copy?.spentUsdc || 0);
      if (copySort === "bet-asc") return (a.copy?.spentUsdc || 0) - (b.copy?.spentUsdc || 0);
      return (b.copy?.copiedAt || b.observedAt || 0) - (a.copy?.copiedAt || a.observedAt || 0);
    });
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
          <h2>
            Copied trades (${copied.length}) — ✓ ${successes} ✗ ${failures} · W ${wins} / L ${losses}
            <span className="filters">
              ${["all", "win", "loss", "pending", "failed"].map(
                (f) => html`<button
                  key=${f}
                  className=${copyFilter === f ? "on" : ""}
                  onClick=${() => setCopyFilter(f)}
                >${f}</button>`,
              )}
              <button
                className=${copySort === "recent" ? "" : "on"}
                title="Sort: newest first / bet value high-low / bet value low-high"
                onClick=${() => setCopySort(nextSort[copySort])}
              >sort: ${sortLabel[copySort]}</button>
            </span>
          </h2>
          <div className="list">
            ${shownCopied.length === 0 &&
            html`<div className="empty">
              ${copied.length === 0 ? "Nothing copied yet" : `No ${copyFilter} trades`}
            </div>`}
            ${shownCopied.map((t) => html`<${CopiedTradeRow} key=${t.id} t=${t} />`)}
          </div>
        </div>
      </div>
    </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
