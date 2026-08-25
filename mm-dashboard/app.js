/* mm-bot dashboard UI. No build step — React UMD + htm, same as dashboard/. */
/* global React, ReactDOM, htm */

const html = htm.bind(React.createElement);
const { useState, useEffect, useMemo, Fragment } = React;

const POLL_MS = 1000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const fmtUsd = (n) =>
  n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const fmtSigned = (n) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const fmtP = (n, d = 3) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
const pnlClass = (n) => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");
const clock = (s) =>
  s == null ? "—" : `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

function useJson(url, ms) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(url)
        .then((r) => r.json())
        .then((d) => alive && setData(d))
        .catch(() => {});
    load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return data;
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

function Header({ s }) {
  const net = s?.stats?.netPnl;
  const feeds = s?.feeds || {};
  const binanceOk = Number.isFinite(feeds.binanceAgeMs) && feeds.binanceAgeMs < 5000;
  return html`
    <div className="header">
      <h1>mm-bot<small>market maker · ${(s?.config?.series || []).join(", ") || "—"}</small></h1>
      <span className=${`pill ${s?.mode === "live" ? "live" : "dry"}`}>
        ${s?.mode === "live" ? "LIVE" : "DRY RUN"}
      </span>
      <span className=${`pill ${s?.running ? "on" : "off"}`}>${s?.running ? "running" : "not running"}</span>
      <span className=${`pill ${feeds.bookWs ? "on" : "warn"}`}>book ws ${feeds.bookWs ? "push" : "REST"}</span>
      <span className=${`pill ${binanceOk ? "on" : "warn"}`}>binance ${binanceOk ? "live" : "stale"}</span>
      ${s?.mode === "live" &&
      html`<span className=${`pill ${feeds.userWs ? "on" : "warn"}`}>
        fills ${feeds.userWs ? "push" : "REST"}
      </span>`}
      <span className="spacer"></span>
      <span className="stat">
        <span className="stat-label">net p&l</span>
        <span className=${`stat-value ${pnlClass(net)}`}>${fmtSigned(net)}</span>
      </span>
      <span className="stat">
        <span className="stat-label">committed</span>
        <span className="stat-value">
          ${fmtUsd(s?.capital?.committed)}<span className="muted" style=${{ fontSize: 12 }}>
            / ${fmtUsd(s?.capital?.cap)}</span
          >
        </span>
      </span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// live window + legs
// ---------------------------------------------------------------------------

/** Price ladder: where our fair, our target and our resting bid sit relative
 * to the actual book. This is the "am I quoting somewhere sane" glance. */
function Ladder({ leg }) {
  const lo = 0, hi = 1;
  const pct = (p) => `${((p - lo) / (hi - lo)) * 100}%`;
  const { bid, ask, fair, target, quote } = leg;
  return html`
    <div>
      <div className="ladder">
        ${bid != null &&
        ask != null &&
        html`<div
          className="spread"
          style=${{ left: pct(bid), width: `${((ask - bid) / (hi - lo)) * 100}%` }}
        ></div>`}
        ${fair != null && html`<div className="tick fair" style=${{ left: pct(fair) }}></div>`}
        ${target != null && html`<div className="tick target" style=${{ left: pct(target) }}></div>`}
        ${quote && html`<div className="tick ours" style=${{ left: pct(quote.price) }}></div>`}
        <span className="cap" style=${{ left: 4 }}>0</span>
        <span className="cap" style=${{ right: 4 }}>1</span>
      </div>
      <div className="ladder-legend">
        <span><i style=${{ background: "var(--violet)" }}></i>fair ${fmtP(fair)}</span>
        <span><i style=${{ background: "var(--orange)" }}></i>target ${fmtP(target, 2)}</span>
        <span><i style=${{ background: "var(--gray)" }}></i>book ${fmtP(bid, 2)}/${fmtP(ask, 2)}</span>
        ${quote && html`<span><i style=${{ background: "var(--green)" }}></i>ours ${fmtP(quote.price, 2)}</span>`}
      </div>
    </div>
  `;
}

function Leg({ leg }) {
  const p = leg.position;
  return html`
    <div className=${`leg ${leg.outcome.toLowerCase()}`}>
      <h3>
        <span className="side">${leg.outcome}</span>
        <span className="fair">${leg.bookAgeMs != null ? `book ${leg.bookAgeMs}ms` : "no book"}</span>
      </h3>
      <${Ladder} leg=${leg} />
      <dl className="kv">
        <dt>resting bid</dt>
        <dd>
          ${leg.quote
            ? `${fmtP(leg.quote.price, 2)} × ${leg.quote.size - leg.quote.matched} sh · ${leg.quote.ageSec}s`
            : "—"}
        </dd>
        <dt>position</dt>
        <dd>${p ? `${p.shares} sh @ ${fmtP(p.avgPrice, 3)}` : "flat"}</dd>
        ${p &&
        html`
          <${Fragment}>
          <dt>cost / mark</dt>
          <dd>${fmtUsd(p.cost)} → ${fmtUsd(p.markValue)}</dd>
          <dt>unrealized</dt>
          <dd className=${pnlClass(p.unrealized)}>${fmtSigned(p.unrealized)}</dd>
          <dt>held</dt>
          <dd>${p.heldSec}s · entry fair ${fmtP(p.entryFair)}</dd>
          <//>
        `}
      </dl>
      ${p?.exitReason && html`<div className="why">cutting: ${p.exitReason}</div>`}
      <div className=${`why ${leg.blockReason ? "" : "quoting"}`}>
        ${leg.blockReason || "quoting"}
      </div>
    </div>
  `;
}

function Window({ w }) {
  const elapsed = Math.max(0, Math.min(w.seconds, w.elapsed));
  const pct = (v) => `${(v / w.seconds) * 100}%`;
  return html`
    <div className="panel">
      <h2>
        live window
        <span className="note">${w.slug}</span>
      </h2>
      <div className="body">
        <div className="track">
          <div
            className="quote-zone"
            style=${{
              left: pct(w.quoteWindow.start),
              width: pct(w.quoteWindow.end - w.quoteWindow.start),
            }}
          ></div>
          <div className="played" style=${{ width: pct(elapsed) }}></div>
        </div>
        <div className="track-labels">
          <span>+${elapsed}s elapsed</span>
          <span className="muted">blue band = quote window</span>
          <span>${clock(w.tau)} left</span>
        </div>

        <dl className="kv" style=${{ margin: "12px 0" }}>
          <dt>spot / strike</dt>
          <dd>
            ${w.spot ? w.spot.toFixed(2) : "—"} vs ${w.strike ? w.strike.toFixed(2) : "—"}
            <span className=${pnlClass(w.spot && w.strike ? w.spot - w.strike : null)}>
              (${w.spot && w.strike ? (w.spot - w.strike >= 0 ? "+" : "") + (w.spot - w.strike).toFixed(2) : "—"})
            </span>
          </dd>
          <dt>model P(up)</dt>
          <dd>${fmtP(w.fairUp)}</dd>
          <dt>realized vol</dt>
          <dd>${w.vol ? w.vol.toExponential(2) : "—"} /s</dd>
        </dl>

        <div className="legs">
          ${w.legs.map((l) => html`<${Leg} key=${l.token} leg=${l} />`)}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// model calibration — the panel that matters
// ---------------------------------------------------------------------------

function polyline(pts) {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function FairChart({ rows, maxDisagree }) {
  const W = 620, H = 210, PL = 34, PR = 8, PT = 10, PB = 20;
  if (rows.length < 2) {
    return html`<div className="empty">waiting for samples — start the bot to fill this in</div>`;
  }
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t || t0 + 1;
  const x = (t) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - PR);
  const y = (v) => PT + (1 - v) * (H - PT - PB);

  const fair = rows.filter((r) => r.fairUp != null).map((r) => [x(r.t), y(r.fairUp)]);
  const mid = rows.filter((r) => r.upMid != null).map((r) => [x(r.t), y(r.upMid)]);

  return html`
    <div>
      <svg className="chart" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" height="210">
        ${[0, 0.25, 0.5, 0.75, 1].map(
          (v) => html`
            <g key=${v}>
              <line className="grid" x1=${PL} x2=${W - PR} y1=${y(v)} y2=${y(v)} />
              <text className="axis" x=${4} y=${y(v) + 3}>${v.toFixed(2)}</text>
            </g>
          `,
        )}
        <polyline className="line-mid" points=${polyline(mid)} />
        <polyline className="line-fair" points=${polyline(fair)} />
        <text className="axis" x=${PL} y=${H - 6}>${timeOf(t0)}</text>
        <text className="axis" x=${W - PR} y=${H - 6} textAnchor="end">${timeOf(t1)}</text>
      </svg>
      <div className="chart-legend">
        <span><i style=${{ background: "var(--violet)" }}></i>model P(up)</span>
        <span><i style=${{ background: "var(--blue)" }}></i>market mid (Up)</span>
        <span className="muted">gap > ${maxDisagree} makes the bot sit out</span>
      </div>
    </div>
  `;
}

/** Mean |model − market| bucketed by how far into the window the sample is.
 * A strike or vol error shows up here as a slope: worst near the money (early,
 * high tau), collapsing to nothing once the outcome is decided. */
function ErrorByPhase({ rows, seconds }) {
  const buckets = useMemo(() => {
    const n = 6;
    const out = Array.from({ length: n }, () => ({ sum: 0, count: 0 }));
    for (const r of rows) {
      if (r.gap == null || r.tau == null) continue;
      const elapsed = Math.max(0, Math.min(seconds, seconds - r.tau));
      const i = Math.min(n - 1, Math.floor((elapsed / seconds) * n));
      out[i].sum += Math.abs(r.gap);
      out[i].count++;
    }
    return out.map((b, i) => ({
      label: `${Math.round((i / n) * 100)}–${Math.round(((i + 1) / n) * 100)}%`,
      mean: b.count ? b.sum / b.count : null,
      count: b.count,
    }));
  }, [rows, seconds]);

  const max = Math.max(0.05, ...buckets.map((b) => b.mean || 0));
  const W = 620, H = 130, PL = 34, PR = 8, PT = 8, PB = 24;
  const bw = (W - PL - PR) / buckets.length;

  if (!rows.length) return html`<div className="empty">no samples yet</div>`;

  return html`
    <div>
      <svg className="chart" viewBox=${`0 0 ${W} ${H}`} height="130">
        ${[0, max / 2, max].map(
          (v) => html`
            <g key=${v}>
              <line
                className="grid"
                x1=${PL}
                x2=${W - PR}
                y1=${PT + (1 - v / max) * (H - PT - PB)}
                y2=${PT + (1 - v / max) * (H - PT - PB)}
              />
              <text className="axis" x=${4} y=${PT + (1 - v / max) * (H - PT - PB) + 3}>
                ${v.toFixed(2)}
              </text>
            </g>
          `,
        )}
        ${buckets.map((b, i) => {
          const h = b.mean ? (b.mean / max) * (H - PT - PB) : 0;
          return html`
            <g key=${b.label}>
              <rect
                className="bar"
                x=${PL + i * bw + 3}
                y=${PT + (H - PT - PB) - h}
                width=${bw - 6}
                height=${h}
              />
              <text className="axis" x=${PL + i * bw + bw / 2} y=${H - 8} textAnchor="middle">
                ${b.label}
              </text>
            </g>
          `;
        })}
      </svg>
      <div className="chart-legend">
        <span className="muted">mean |model − market| by position through the window →</span>
      </div>
    </div>
  `;
}

function Calibration({ rows, status }) {
  const maxDisagree = status?.config?.maxDisagree ?? 0.15;
  const margin = status?.config?.margin ?? 0.04;
  const seconds = status?.windows?.[0]?.seconds || 300;

  const m = useMemo(() => {
    const gaps = rows.map((r) => r.gap).filter((g) => g != null);
    if (!gaps.length) return null;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const absMean = gaps.reduce((a, b) => a + Math.abs(b), 0) / gaps.length;
    const over = gaps.filter((g) => Math.abs(g) > maxDisagree).length / gaps.length;
    const oneWay = Math.abs(mean) / (absMean || 1); // 1 = every miss in one direction
    return { n: gaps.length, mean, absMean, over, oneWay, ratio: absMean / (margin || 0.04) };
  }, [rows, maxDisagree, margin]);

  // The grade that matters is absolute error against the margin we are trying
  // to earn. An early version passed the model as "tracking the book" on a near
  // zero mean signed error while it was losing money: unbiased is not the same
  // as accurate, and it is the size of the miss, not its direction, that
  // decides whether a fair-value edge survives the spread.
  let verdict = null;
  if (m && m.n >= 30) {
    if (m.ratio > 1) {
      verdict = {
        cls: "bad",
        title: `Error is ${m.ratio.toFixed(1)}× the edge being quoted`,
        body: `Mean absolute error ${m.absMean.toFixed(3)} against a ${margin} margin. The edge is smaller than the measurement noise, so fills are close to a coin flip on the model's own terms — profitable only by luck. ${
          m.oneWay > 0.6
            ? `The miss is also one-sided (mean ${m.mean > 0 ? "+" : ""}${m.mean.toFixed(3)}), which points at the strike or vol input rather than market noise.`
            : `The miss is symmetric (mean ${m.mean > 0 ? "+" : ""}${m.mean.toFixed(3)}), so this is noise and overconfidence, not a constant offset.`
        }`,
      };
    } else if (m.ratio > 0.5 || m.over > 0.5) {
      verdict = {
        cls: "warn",
        title: "Edge is thin relative to the error",
        body: `Mean absolute error ${m.absMean.toFixed(3)} against a ${margin} margin (${m.ratio.toFixed(
          1,
        )}×), ${Math.round(m.over * 100)}% of samples outside the ${maxDisagree} guard. Tradeable in principle, but the model needs to be roughly twice this accurate before the spread capture is reliable.`,
      };
    } else {
      verdict = {
        cls: "good",
        title: "Model is sharper than the edge it quotes",
        body: `Mean absolute error ${m.absMean.toFixed(3)} against a ${margin} margin (${m.ratio.toFixed(
          1,
        )}×), bias ${m.mean > 0 ? "+" : ""}${m.mean.toFixed(3)}, ${Math.round(
          m.over * 100,
        )}% outside the guard. This is the regime where the spread capture can actually earn.`,
      };
    }
  }

  return html`
    <${Fragment}>
    <div className="panel">
      <h2>
        model vs market
        <span className="note">${m ? `${m.n} samples` : "no samples"}</span>
      </h2>
      <div className="body">
        <${FairChart} rows=${rows} maxDisagree=${maxDisagree} />
        ${m &&
        html`
          <dl className="kv" style=${{ marginTop: 14 }}>
            <dt>mean signed error (model − market)</dt>
            <dd className=${pnlClass(-Math.abs(m.mean))}>${m.mean >= 0 ? "+" : ""}${m.mean.toFixed(3)}</dd>
            <dt>mean absolute error</dt>
            <dd>${m.absMean.toFixed(3)}</dd>
            <dt>error ÷ quoted margin</dt>
            <dd className=${m.ratio > 1 ? "neg" : m.ratio > 0.5 ? "" : "pos"}>
              ${m.ratio.toFixed(1)}×
            </dd>
            <dt>outside the ${maxDisagree} guard</dt>
            <dd>${(m.over * 100).toFixed(0)}%</dd>
          </dl>
        `}
        ${verdict &&
        html`<div className=${`verdict ${verdict.cls}`}>
          <b>${verdict.title}</b>${verdict.body}
        </div>`}
      </div>
    </div>

    <div className="panel">
      <h2>where the error lives<span className="note">by phase of window</span></h2>
      <div className="body"><${ErrorByPhase} rows=${rows} seconds=${seconds} /></div>
    </div>
    <//>
  `;
}

// ---------------------------------------------------------------------------
// why it isn't quoting
// ---------------------------------------------------------------------------

function Blocked({ blocked }) {
  const entries = Object.entries(blocked || {});
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return html`
    <div className="panel">
      <h2>why it isn't quoting<span className="note">leg-ticks since start</span></h2>
      <div className="body">
        ${!entries.length
          ? html`<div className="empty">nothing blocked yet</div>`
          : entries.map(
              ([reason, n]) => html`
                <div className="reason" key=${reason}>
                  <div className="top">
                    <span>${reason}</span>
                    <span className="pct">${((n / total) * 100).toFixed(0)}% · ${n}</span>
                  </div>
                  <div className="bar"><span style=${{ width: `${(n / total) * 100}%` }}></span></div>
                </div>
              `,
            )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

function Journal({ rows }) {
  const totals = useMemo(() => {
    const cuts = rows.filter((r) => r.action === "cut");
    const held = rows.filter((r) => r.action === "held");
    const sum = (a) => a.reduce((x, r) => x + (r.pnl || 0), 0);
    return {
      cuts: cuts.length,
      cutPnl: sum(cuts),
      held: held.length,
      heldPnl: sum(held),
      wins: held.filter((r) => r.won).length,
    };
  }, [rows]);

  return html`
    <div className="panel">
      <h2>
        closed positions
        <span className="note">
          ${totals.cuts} cuts ${fmtSigned(totals.cutPnl)} · ${totals.held} settled
          ${fmtSigned(totals.heldPnl)}${totals.held ? ` (${totals.wins}/${totals.held} won)` : ""}
        </span>
      </h2>
      ${!rows.length
        ? html`<div className="empty">no closed positions yet</div>`
        : html`
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>market</th>
                    <th>side</th>
                    <th></th>
                    <th className="num">shares</th>
                    <th className="num">cost</th>
                    <th className="num">out</th>
                    <th className="num">p&l</th>
                    <th className="num">held</th>
                    <th>why</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(
                    (r, i) => html`
                      <tr key=${`${r.at}-${i}`}>
                        <td className="muted">${timeOf(r.at)}</td>
                        <td className="muted">${String(r.slug || "").replace(/^btc-updown-/, "")}</td>
                        <td>${r.outcome}</td>
                        <td>
                          <span
                            className=${`badge ${
                              r.action === "cut"
                                ? "b-cut"
                                : r.action === "unsettled"
                                  ? "b-unsettled"
                                  : r.won
                                    ? "b-won"
                                    : "b-lost"
                            }`}
                          >
                            ${r.action === "cut" ? "cut" : r.action === "unsettled" ? "unsettled" : r.won ? "won" : "lost"}
                          </span>
                        </td>
                        <td className="num">${r.shares}</td>
                        <td className="num">${fmtUsd(r.cost)}</td>
                        <td className="num">${fmtUsd(r.proceeds ?? r.payout)}</td>
                        <td className=${`num ${pnlClass(r.pnl)}`}>${fmtSigned(r.pnl)}</td>
                        <td className="num muted">${r.heldSec != null ? `${r.heldSec}s` : "—"}</td>
                        <td className="muted">${r.why || (r.entryFair != null ? `entry fair ${fmtP(r.entryFair, 2)}` : "")}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

function App() {
  const status = useJson("/api/mm/status", POLL_MS);
  const signals = useJson("/api/mm/signals?minutes=30", 2000);
  const journal = useJson("/api/mm/journal", 3000);
  const rows = signals || [];

  return html`
    <${Fragment}>
    <${Header} s=${status} />
    ${!status?.running &&
    html`<div className="panel">
      <div className="empty">
        mm-bot is not writing telemetry. Start it with <b>npm run mm</b> (dry by default);
        this page updates itself once it does.
      </div>
    </div>`}
    <div className="cols">
      <div>
        ${(status?.windows || []).map((w) => html`<${Window} key=${w.slug} w=${w} />`)}
        <${Blocked} blocked=${status?.blocked} />
      </div>
      <div>
        <${Calibration} rows=${rows} status=${status} />
      </div>
    </div>
    <${Journal} rows=${journal || []} />
    <//>
  `;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
