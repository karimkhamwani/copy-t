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
  "min-skip": "MIN SKIP",
  "risk-skip": "RISK SKIP",
};

function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleString();
}

function uptime(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function money(n) {
  return n == null ? "—" : `$${Number(n).toFixed(2)}`;
}

/** Share counts trimmed to 2 decimals (15.1515 -> 15.15, 20 -> 20). */
function shares(n) {
  return n == null ? "—" : parseFloat(Number(n).toFixed(2));
}

/** Duration in ms -> "0.8s" / "12.4s" / "2m 05s". */
function dur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Clock time with millisecond precision for latency tooltips. */
function clockMs(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/** Trader's trade time vs our bet time for a copied row. */
function LatencyLine({ t }) {
  const c = t.copy || {};
  if (!c.copiedAt) return null;
  const tradeToBet = t.tradedAt ? c.copiedAt - t.tradedAt : null; // total vs trader
  const tone = tradeToBet == null ? undefined
    : tradeToBet <= 3000 ? "var(--green)" : tradeToBet <= 10000 ? "var(--orange)" : "var(--red)";
  const tip =
    `trader traded  ${clockMs(t.tradedAt)}\n` +
    `signal received ${clockMs(t.observedAt)} (${c.source || "?"})\n` +
    `bet placed      ${clockMs(c.copiedAt)}` +
    (tradeToBet == null ? "" : `\ntrade→bet ${dur(tradeToBet)}`);
  return html`<span title=${tip} style=${{ color: tone }}>
    ${c.source === "ws" ? "⚡" : "⟳"} trader→us ${tradeToBet == null ? "—" : dur(tradeToBet)}
  </span>`;
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
      ${ok &&
      html`
        <div className="meta compare">
          <span className="who">trader</span>
          <span>price ${t.theirPrice}</span>
          <span>${money(t.theirUsdc)}</span>
          <span>${shares(t.theirShares)} shares</span>
        </div>
        <div className="meta compare">
          <span className="who">us</span>
          <span>price ${c.price}</span>
          <span>${money(c.spentUsdc)}</span>
          <span>${shares(c.shares)} shares</span>
        </div>
      `}
      <div className="meta">
        <span className="outcome">${t.outcome}</span>
        <span>${timeAgo(c.copiedAt)}</span>
        ${ok && html`<${LatencyLine} t=${t} />`}
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
  CartesianGrid, Tooltip, Legend, ReferenceLine, LabelList, Cell,
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

/** Market close time (ms) parsed from up/down slugs like "btc-updown-5m-1786744800". */
function parseMarketEnd(t) {
  const m = /-(\d+)m-(\d{10})$/.exec(t.slug || "");
  if (!m) return null;
  return (Number(m[2]) + Number(m[1]) * 60) * 1000;
}

/** Step chart of $ actively at risk: +spent at copy time, -spent at market close once resolved. */
function ActiveChart({ copied }) {
  const events = [];
  for (const t of copied) {
    if (t.status !== "success" || !t.copy?.copiedAt) continue;
    const spent = t.copy?.spentUsdc || 0;
    if (!spent) continue;
    events.push({ ts: t.copy.copiedAt, delta: spent });
    if (t.result === "win" || t.result === "loss") {
      // exposure ends when the market closes; fall back to entry time if unparseable
      const end = parseMarketEnd(t);
      events.push({ ts: Math.max(end || 0, t.copy.copiedAt), delta: -spent });
    }
  }
  if (events.length === 0)
    return html`<div className="empty">No copies to chart exposure yet</div>`;

  events.sort((a, b) => a.ts - b.ts);
  let cur = 0;
  const pts = events.map((e) => {
    cur += e.delta;
    return {
      label: new Date(e.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      active: Number(cur.toFixed(2)),
    };
  });
  // extend the line to "now" so current exposure is visible at the right edge
  pts.push({
    label: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    active: Number(cur.toFixed(2)),
  });

  return html`
    <div>
      <div style=${{ fontSize: 12, color: "var(--dim)", margin: "10px 0 2px" }}>
        Active in trading over time ($ at risk) — currently${" "}
        <b style=${{ color: cur > 0 ? "#4c9aff" : "var(--dim)" }}>$${cur.toFixed(2)}</b>
      </div>
      <${ResponsiveContainer} width="100%" height=${160}>
        <${LineChart} data=${pts} margin=${{ top: 10, right: 12, left: -16, bottom: 0 }}>
          <${CartesianGrid} vertical=${false} stroke=${CH.grid} />
          <${XAxis} dataKey="label" tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${{ stroke: CH.grid }} tickLine=${false} interval="preserveStartEnd" minTickGap=${30} />
          <${YAxis} tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${false} tickLine=${false} tickFormatter=${(v) => `$${v}`} allowDecimals=${false} domain=${[0, "auto"]} />
          <${Tooltip} ...${TIP_STYLE} formatter=${(v) => [`$${Number(v).toFixed(2)}`, "At risk"]} />
          <${Line} type="stepAfter" dataKey="active" name="At risk" stroke="#4c9aff" strokeWidth=${2}
            dot=${false} activeDot=${{ r: 4 }} isAnimationActive=${false} />
        <//>
      <//>
    </div>`;
}

/** Stable market identity for grouping/filtering. */
function marketKey(t) {
  return t.conditionId || t.slug || t.title || "";
}

/** Placed bets grouped by market: [{ key, title, win, loss, pending, count }], oldest first. */
function marketBets(copied) {
  const byMarket = new Map();
  for (const t of copied) {
    if (t.status !== "success") continue;
    const key = marketKey(t);
    if (!key) continue;
    if (!byMarket.has(key))
      byMarket.set(key, { key, title: t.title || t.slug, win: 0, loss: 0, pending: 0, firstAt: Infinity });
    const b = byMarket.get(key);
    if (t.result === "win") b.win++;
    else if (t.result === "loss") b.loss++;
    else b.pending++;
    b.firstAt = Math.min(b.firstAt, t.tradedAt || t.copy?.copiedAt || Infinity);
  }
  // chronological: markets we bet in first come first
  return [...byMarket.values()]
    .map((b) => ({ ...b, count: b.win + b.loss + b.pending }))
    .sort((a, b) => a.firstAt - b.firstAt);
}

const MARKET_CHART_MAX = 10;

/** Horizontal bar chart: how many bets we placed in each market. Click a bar to
    filter the copied-trades list to that market (click again to clear). */
function MarketBetsChart({ copied, selectedMarket, onSelectMarket }) {
  const [showAll, setShowAll] = useState(false);
  const all = marketBets(copied);
  if (all.length === 0)
    return html`<div className="empty">No placed bets to chart per market yet</div>`;
  // most recent markets by default, oldest at the top; "show all" expands
  const data = showAll ? all : all.slice(-MARKET_CHART_MAX);

  const toggle = (d) => {
    const key = d?.payload?.key ?? d?.key;
    if (key) onSelectMarket(selectedMarket?.key === key ? null : { key, title: d.payload?.title ?? d.title });
  };
  // dim the bars that are NOT the selected market
  const cells = (bar) =>
    data.map((d) => html`<${Cell}
      key=${`${bar}-${d.key}`}
      fillOpacity=${selectedMarket && d.key !== selectedMarket.key ? 0.3 : 1}
    />`);

  return html`
    <div className="market-chart">
      <div style=${{ fontSize: 12, color: "var(--dim)", margin: "10px 0 2px" }}>
        Bets placed per market, oldest first${!showAll && all.length > data.length ? ` (last ${data.length} of ${all.length})` : showAll ? ` (all ${all.length})` : ""}
        ${all.length > MARKET_CHART_MAX &&
        html` — <a href="#" onClick=${(e) => { e.preventDefault(); setShowAll(!showAll); }}>
          ${showAll ? "show last 10" : "show all"}
        </a>`}
        — ${selectedMarket
          ? html`filtering copied trades, <a href="#" onClick=${(e) => { e.preventDefault(); onSelectMarket(null); }}>clear</a>`
          : "click a bar to filter copied trades"}
      </div>
      <div style=${showAll ? { maxHeight: 360, overflowY: "auto" } : null}>
      <${ResponsiveContainer} width="100%" height=${Math.max(104, data.length * 30 + 64)}>
        <${BarChart} data=${data} layout="vertical" margin=${{ top: 0, right: 28, left: 8, bottom: 0 }} barCategoryGap="30%">
          <${CartesianGrid} horizontal=${false} stroke=${CH.grid} />
          <${XAxis} type="number" allowDecimals=${false} tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${{ stroke: CH.grid }} tickLine=${false} />
          <${YAxis} type="category" dataKey="title" width=${190}
            tick=${{ fontSize: 10, fill: CH.ink }} axisLine=${false} tickLine=${false}
            tickFormatter=${(v) => (String(v).length > 26 ? String(v).slice(0, 25) + "…" : v)} />
          <${Tooltip} ...${TIP_STYLE} />
          <${Legend} wrapperStyle=${{ fontSize: 12 }} />
          <${Bar} dataKey="win" name="Wins" stackId="m" fill=${C_WIN} stroke=${CH.surface} strokeWidth=${1} onClick=${toggle}>
            ${cells("win")}
          <//>
          <${Bar} dataKey="loss" name="Losses" stackId="m" fill=${C_LOSS} stroke=${CH.surface} strokeWidth=${1} onClick=${toggle}>
            ${cells("loss")}
          <//>
          <${Bar} dataKey="pending" name="Pending" stackId="m" fill=${C_PENDING} stroke=${CH.surface} strokeWidth=${1} onClick=${toggle}>
            ${cells("pending")}
            <${LabelList} dataKey="count" position="right" style=${{ fontSize: 10, fill: CH.ink }} />
          <//>
        <//>
      <//>
      </div>
    </div>`;
}

function Analytics({ copied, status, selectedMarket, onSelectMarket }) {
  const ok = copied.filter((t) => t.status === "success");
  const wins = ok.filter((t) => t.result === "win");
  const losses = ok.filter((t) => t.result === "loss");
  const pending = ok.length - wins.length - losses.length;
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

  // risk-gate cap: MAX_ACTIVE_PCT of bankroll (balance + active)
  const balance = status?.mode === "dry" ? status?.paperBalance : status?.balance;
  const cap = status?.maxActivePct && balance != null
    ? (status.maxActivePct / 100) * (balance + active)
    : null;
  const capUsage = cap > 0 ? active / cap : 0;
  const activeTone = cap == null
    ? active > 0 ? "#4c9aff" : null
    : capUsage >= 0.999 ? C_LOSS : capUsage >= 0.9 ? "#f0a13a" : "#4c9aff";

  return html`
    <div className="panel" style=${{ marginBottom: 16 }}>
      <h2>Analytics</h2>
      <div className="tiles">
        <${StatTile} label="Copied trades" value=${ok.length} />
        <${StatTile} label="Wins" value=${wins.length} tone=${C_WIN} />
        <${StatTile} label="Losses" value=${losses.length} tone=${C_LOSS} />
        <${StatTile} label="Pending" value=${pending} tone=${pending > 0 ? C_PENDING : null} />
        <${StatTile} label="Win rate" value=${winRate == null ? "—" : winRate + "%"} />
        <${StatTile} label="Net P/L (resolved)" value=${`${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`} tone=${resolved ? (pnl >= 0 ? C_WIN : C_LOSS) : null} />
        <${StatTile} label="Lifetime profit" value=${`+$${totalProfit.toFixed(2)}`} tone=${totalProfit > 0 ? C_WIN : null} />
        <${StatTile} label="Lifetime loss" value=${`-$${totalLoss.toFixed(2)}`} tone=${totalLoss > 0 ? C_LOSS : null} />
        <${StatTile} label="Total spent" value=${`$${totalSpent.toFixed(2)}`} />
        <${StatTile}
          label=${cap != null ? `Active in trading (${status.maxActivePct}% cap)` : "Active in trading"}
          value=${cap != null ? `$${active.toFixed(2)} / $${cap.toFixed(2)}` : `$${active.toFixed(2)}`}
          tone=${activeTone}
        />
      </div>
      <div style=${{ padding: "0 14px 12px" }}>
        <${WinLossChart} copied=${copied} />
        <${PnlChart} copied=${copied} />
        <${ActiveChart} copied=${copied} />
        <${MarketBetsChart} copied=${copied} selectedMarket=${selectedMarket} onSelectMarket=${onSelectMarket} />
      </div>
    </div>`;
}

const COPIED_FILTERS = {
  all: { label: "All", match: () => true },
  success: { label: "Copied", match: (t) => t.status === "success" },
  failed: { label: "Failed", match: (t) => t.status !== "success" },
  win: { label: "Win", match: (t) => t.result === "win" },
  loss: { label: "Loss", match: (t) => t.result === "loss" },
  pending: {
    label: "Pending",
    match: (t) => t.status === "success" && t.result !== "win" && t.result !== "loss",
  },
};

/** Net $ value of a copied bet: win profit, loss as negative, else 0. */
function betValue(t) {
  if (t.result === "win") return (t.copy?.shares || 0) - (t.copy?.spentUsdc || 0);
  if (t.result === "loss") return -(t.copy?.spentUsdc || 0);
  return 0;
}

function App() {
  const [trades, setTrades] = useState([]);
  const [status, setStatus] = useState(null);
  const [balance, setBalance] = useState(null);
  const [copiedFilter, setCopiedFilter] = useState("all");
  const [copiedSort, setCopiedSort] = useState("none");
  const [selectedMarket, setSelectedMarket] = useState(null); // { key, title } from the per-market chart

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [t, s, b] = await Promise.all([
          fetch("/api/trades").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/balance").then((r) => r.json()),
        ]);
        if (alive) {
          setTrades(Array.isArray(t) ? t : []);
          setStatus(s);
          setBalance(b?.balance ?? null);
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

  // Risk-gate state for the header pill: TRADING while there's room under the
  // cap, GATED when active has reached it (or the live balance is unreadable).
  const gateActive = copied
    .filter((t) => t.status === "success" && t.result !== "win" && t.result !== "loss")
    .reduce((s, t) => s + (t.copy?.spentUsdc || 0), 0);
  const gateBalance = status?.mode === "dry" ? status?.paperBalance : status?.balance;
  const gateCap = status?.maxActivePct && gateBalance != null
    ? (status.maxActivePct / 100) * (gateBalance + gateActive)
    : null;
  const gate = !status?.maxActivePct
    ? null // gate disabled -> no pill
    : gateBalance == null
      ? { label: "GATED", cls: "off", why: "balance unavailable — trading blocked (fail-closed)" }
      : gateActive >= gateCap - 0.005
        ? { label: "GATED", cls: "gated", why: `active $${gateActive.toFixed(2)} has hit the ${status.maxActivePct}% cap $${gateCap.toFixed(2)}` }
        : { label: "TRADING", cls: "on", why: `$${(gateCap - gateActive).toFixed(2)} of headroom under the ${status.maxActivePct}% cap $${gateCap.toFixed(2)}` };

  const successes = copied.filter((t) => t.status === "success").length;
  const failures = copied.filter((t) => t.status === "failed").length;
  const wins = copied.filter((t) => t.result === "win").length;
  const losses = copied.filter((t) => t.result === "loss").length;
  let filteredCopied = copied.filter(COPIED_FILTERS[copiedFilter].match);
  if (selectedMarket) {
    filteredCopied = filteredCopied.filter((t) => marketKey(t) === selectedMarket.key);
  }
  if (copiedFilter !== "all" && copiedSort !== "none") {
    filteredCopied = [...filteredCopied].sort((a, b) =>
      copiedSort === "asc" ? betValue(a) - betValue(b) : betValue(b) - betValue(a)
    );
  }
  // net P/L of exactly the rows shown in the copied list (filters applied)
  const shownPl = filteredCopied.reduce((s, t) => s + betValue(t), 0);

  return html`
    <div>
      <div className="header">
        <h1>Polymarket Copy-Trader</h1>
        ${status?.mode &&
        html`<span className=${`pill ${status.mode}`}>${status.mode === "dry" ? "DRY RUN" : "LIVE"}</span>`}
        <span className=${`pill ${online ? "on" : "off"}`}>${online ? "ENGINE ONLINE" : "ENGINE OFFLINE"}</span>
        ${online && status &&
        html`<span
          className=${`pill ${status.wsConnected ? "on" : "gated"}`}
          title=${status.wsConnected
            ? "real-time websocket feed is the active signal (poller runs as backup)"
            : status.wsEnabled
              ? "websocket feed is DOWN — polling the activity API as fallback"
              : "websocket disabled — polling the activity API"}>
          ${status.wsConnected ? "SIGNAL: WS ⚡" : "SIGNAL: POLLING ⟳"}
        </span>`}
        ${gate && html`<span className=${`pill ${gate.cls}`} title=${gate.why}>${gate.label}</span>`}
        ${online && status?.startedAt && html`<span className="pill">up ${uptime(status.startedAt)}</span>`}
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
        <span className="balance">
          <span className="balance-label">
            Balance${status?.mode === "dry" && status?.paperBalance != null ? " (paper)" : ""}
          </span>
          <span className="balance-value">
            ${status?.mode === "dry" && status?.paperBalance != null
              ? money(status.paperBalance)
              : balance != null ? money(balance) : "—"}
          </span>
        </span>
      </div>

      <${Analytics} copied=${copied} status=${status} selectedMarket=${selectedMarket} onSelectMarket=${setSelectedMarket} />

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
            Copied trades (${filteredCopied.length}${copiedFilter !== "all" || selectedMarket ? `/${copied.length}` : ""}) — ✓ ${successes} ✗ ${failures} · W ${wins} / L ${losses}
          </h2>
          <div className="toolbar">
            <select
              className="filter"
              value=${copiedFilter}
              onChange=${(e) => setCopiedFilter(e.target.value)}
              aria-label="Filter copied trades by status"
            >
              ${Object.entries(COPIED_FILTERS).map(
                ([k, f]) => html`<option key=${k} value=${k}>${f.label}</option>`
              )}
            </select>
            ${copiedFilter !== "all" &&
            html`<select
              className="filter"
              value=${copiedSort}
              onChange=${(e) => setCopiedSort(e.target.value)}
              aria-label="Sort copied trades by bet win value"
            >
              <option value="none">Sort: none</option>
              <option value="asc">Win value ↑</option>
              <option value="desc">Win value ↓</option>
            </select>`}
            ${selectedMarket &&
            html`<span className="market-chip" title=${selectedMarket.title}>
              ${String(selectedMarket.title).length > 32 ? String(selectedMarket.title).slice(0, 31) + "…" : selectedMarket.title}
              <button onClick=${() => setSelectedMarket(null)} aria-label="Clear market filter">✕</button>
            </span>`}
            <span
              className="toolbar-sum"
              title="Net P/L of the entries shown below (wins − losses; pending counts as $0)"
              style=${{ color: shownPl > 0 ? C_WIN : shownPl < 0 ? C_LOSS : "var(--dim)" }}
            >
              Σ ${fmtMoney(shownPl)}
            </span>
          </div>
          <div className="list">
            ${copied.length === 0 && html`<div className="empty">Nothing copied yet</div>`}
            ${copied.length > 0 && filteredCopied.length === 0 &&
            html`<div className="empty">No copied trades match this filter</div>`}
            ${filteredCopied.map((t) => html`<${CopiedTradeRow} key=${t.id} t=${t} />`)}
          </div>
        </div>
      </div>
    </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
