/**
 * Replay a trades-log through the price-deviation guard.
 *
 * Answers "what would DRIFT_GUARD have done to this session?" offline — no key,
 * no network, no orders. Uses the engine's own exported driftVerdict, so what it
 * reports is what the running guard decides, not a second implementation of it.
 *
 *   node drift-backtest.js                       # ./trades-log.json, default band
 *   node drift-backtest.js path/to/log.json      # a specific journal
 *   node drift-backtest.js log.json --sweep      # compare candidate bands
 *
 * CAVEAT, and it matters: the journal records the price we *realised*, while the
 * live guard reads the executable price a moment *earlier*. Those are close but
 * not identical, so treat the dollar figures as indicative of direction and
 * magnitude, not as an exact forecast.
 */
const fs = require("fs");
const path = require("path");
const { driftVerdict } = require("./copy-trader.js");

const args = process.argv.slice(2);
const sweep = args.includes("--sweep");
const file = args.find((a) => !a.startsWith("--")) || path.join(__dirname, "trades-log.json");

let journal;
try {
  journal = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(1);
}

// Only settled live copies can be scored: we need both a fill and an outcome.
const rows = journal.filter(
  (e) => e.copy && e.status === "success" && e.copy.mode === "live" && e.copy.settled,
);
if (rows.length === 0) {
  console.error(
    `no settled live copies in ${file} — nothing to score.\n` +
      `(dry-run rows have copy.mode "dry"; unsettled rows have no win/loss yet)`,
  );
  process.exit(1);
}

/** Realised fill price, used as a stand-in for the pre-trade executable price. */
const fillPrice = (e) => e.copy.spentUsdc / e.copy.shares;
const pnl = (e) => (e.copy.won ? e.copy.shares : 0) - e.copy.spentUsdc;

function score(band) {
  let kept = [], skipped = [];
  for (const e of rows) {
    const v = driftVerdict(fillPrice(e), e.theirPrice, band);
    (v.allowed ? kept : skipped).push({ e, reason: v.reason });
  }
  const sum = (list, f) => list.reduce((s, x) => s + f(x.e), 0);
  const staked = sum(kept, (e) => e.copy.spentUsdc);
  const p = sum(kept, pnl);
  return {
    kept, skipped, staked, p,
    roi: staked ? (100 * p) / staked : 0,
    wr: kept.length ? (100 * kept.filter((x) => x.e.copy.won).length) / kept.length : 0,
    avoided: sum(skipped, pnl),
  };
}

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const baseStaked = rows.reduce((s, e) => s + e.copy.spentUsdc, 0);
const baseP = rows.reduce((s, e) => s + pnl(e), 0);

console.log(`\n${path.basename(file)} — ${rows.length} settled live copies`);
console.log(`unguarded: staked ${money(baseStaked)}  P/L ${money(baseP)}  ` +
  `ROI ${((100 * baseP) / baseStaked).toFixed(1)}%  ` +
  `win rate ${((100 * rows.filter((e) => e.copy.won).length) / rows.length).toFixed(1)}%\n`);

if (sweep) {
  const bands = [
    { adverse: 1, overpay: 1, label: "guard off (control)" },
    { adverse: 0.1, overpay: 0.1 }, { adverse: 0.05, overpay: 0.05 },
    { adverse: 0.03, overpay: 0.05 }, { adverse: 0.03, overpay: 0.03 },
    { adverse: 0.02, overpay: 0.05 }, { adverse: 0.01, overpay: 0.05 },
  ];
  console.log("band (adverse/overpay)   kept  skipped   staked      P/L      ROI   win%");
  for (const b of bands) {
    const r = score(b);
    const name = b.label || `-${b.adverse} / +${b.overpay}`;
    console.log(
      `${name.padEnd(22)} ${String(r.kept.length).padStart(5)} ${String(r.skipped.length).padStart(8)}` +
      ` ${money(r.staked).padStart(9)} ${money(r.p).padStart(9)} ${r.roi.toFixed(1).padStart(7)}% ${r.wr.toFixed(0).padStart(5)}%`,
    );
  }
  console.log("\n'guard off' should reproduce the unguarded line above — if it does not, the replay is wrong.");
} else {
  const band = {
    adverse: Number(process.env.MAX_ADVERSE_DRIFT ?? 0.03),
    overpay: Number(process.env.MAX_OVERPAY ?? 0.05),
  };
  const r = score(band);
  console.log(`band -${band.adverse} / +${band.overpay} (from env, or defaults)`);
  console.log(`  would take    ${r.kept.length} of ${rows.length} trades`);
  console.log(`  would skip    ${r.skipped.length}`);
  console.log(`  staked        ${money(r.staked)}  (was ${money(baseStaked)})`);
  console.log(`  P/L           ${money(r.p)}  (was ${money(baseP)})`);
  console.log(`  ROI           ${r.roi.toFixed(1)}%  win rate ${r.wr.toFixed(1)}%`);
  console.log(`  loss avoided  ${money(-r.avoided)} on the skipped trades\n`);
  const worst = r.skipped.sort((a, b) => pnl(a.e) - pnl(b.e)).slice(0, 5);
  if (worst.length) {
    console.log("biggest skips it would have made:");
    for (const { e, reason } of worst) {
      console.log(`  ${money(pnl(e)).padStart(9)}  ${String(e.title || e.slug).slice(0, 44).padEnd(44)} ${reason}`);
    }
  }
}
console.log();
