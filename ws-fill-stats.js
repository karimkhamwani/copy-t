/**
 * Standalone websocket observer — measures multi-fill duplicates WITHOUT
 * touching the bot. Connects to the same live-trade feed, watches for N
 * minutes, and reports how often one transaction arrives as multiple fill
 * events (same txHash:asset), and how much dollar size mirror-sizing would
 * miss by sizing off the FIRST fill only.
 *
 *   node ws-fill-stats.js [minutes] [walletAddress]
 *
 * minutes: watch duration (default 5). Ctrl-C also prints the report.
 * wallet:  optional extra breakdown for one wallet (defaults to the first
 *          entry in target-wallets.js).
 */

require("dotenv").config();
const { createLiveTradeFeed } = require("./live-trades-ws.js");

const minutes = Number(process.argv[2]) || 5;
let targetWallet = (process.argv[3] || "").toLowerCase();
if (!targetWallet) {
  try {
    targetWallet = String(require("./target-wallets.js")[0]?.address || "").toLowerCase();
  } catch {
    /* no wallet file — global stats only */
  }
}

const WS_URL = process.env.WS_URL || "wss://ws-live-data.polymarket.com";

// key = txHash:asset -> { fills: [{usdc, ts}], wallet, title, side, outcome, slug }
const keys = new Map();
let events = 0;

/** The markets this bot actually trades: crypto up/down (btc/eth/sol/xrp…). */
const isCrypto = (k) => /-updown-/.test(k.slug || "");

const feed = createLiveTradeFeed({
  url: WS_URL,
  log: (...a) => console.error(new Date().toISOString(), ...a),
  onTrade: (r) => {
    events++;
    const k = `${r.transactionHash}:${r.asset}`;
    if (!keys.has(k)) {
      keys.set(k, { fills: [], wallet: r.proxyWallet, title: r.title, side: r.side, outcome: r.outcome, slug: r.slug });
    }
    keys.get(k).fills.push({ usdc: r.usdcSize || 0, ts: Date.now() });
  },
});

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const $ = (n) => "$" + n.toFixed(2);

function report() {
  feed.close();
  const all = [...keys.values()];
  const multi = all.filter((k) => k.fills.length > 1);

  console.log(`\n=== WS FILL-DUPLICATE REPORT (${minutes}m watch, ${WS_URL}) ===\n`);
  console.log(`events received:        ${events}`);
  console.log(`unique orders (tx:asset): ${all.length}`);
  console.log(`multi-fill orders:      ${multi.length} (${all.length ? ((100 * multi.length) / all.length).toFixed(1) : 0}%)\n`);

  // distribution table
  const dist = new Map();
  for (const k of all) dist.set(k.fills.length, (dist.get(k.fills.length) || 0) + 1);
  console.log("fills/order | orders");
  console.log("----------- | ------");
  for (const [n, c] of [...dist].sort((a, b) => a[0] - b[0])) {
    console.log(`${rpad(n, 11)} | ${c}`);
  }

  if (multi.length) {
    // how much money first-fill sizing would miss
    let first = 0, total = 0, maxGapMs = 0;
    for (const k of multi) {
      first += k.fills[0].usdc;
      total += k.fills.reduce((s, f) => s + f.usdc, 0);
      maxGapMs = Math.max(maxGapMs, k.fills[k.fills.length - 1].ts - k.fills[0].ts);
    }
    console.log(`\nmulti-fill orders: first-fill $ ${$(first)} vs true total ${$(total)}`);
    console.log(`=> mirror sizing off fill #1 would see ${((100 * first) / total).toFixed(0)}% of the real size`);
    console.log(`largest gap between first and last fill: ${maxGapMs}ms\n`);

    console.log("worst examples (by missed $):");
    console.log(`${pad("tx", 12)} | fills | ${pad("first", 8)} | ${pad("total", 8)} | ${pad("wallet", 10)} | title`);
    const worst = [...keys.entries()]
      .filter(([, v]) => v.fills.length > 1)
      .map(([key, k]) => ({ ...k, key, t: k.fills.reduce((s, f) => s + f.usdc, 0), f1: k.fills[0].usdc }))
      .sort((a, b) => (b.t - b.f1) - (a.t - a.f1))
      .slice(0, 10);
    for (const k of worst) {
      const tx = k.key;
      console.log(
        `${pad(tx.slice(0, 10) + "…", 12)} | ${rpad(k.fills.length, 5)} | ${pad($(k.f1), 8)} | ${pad($(k.t), 8)} | ${pad(k.wallet.slice(0, 8) + "…", 10)} | ${(k.title || "").slice(0, 40)}`,
      );
    }
  }

  // --- crypto up/down markets only (what the bot actually trades) ---
  const crypto = all.filter(isCrypto);
  const cryptoMulti = crypto.filter((k) => k.fills.length > 1);
  console.log(`\n--- crypto up/down markets only ---`);
  console.log(`orders: ${crypto.length} | multi-fill: ${cryptoMulti.length} (${crypto.length ? ((100 * cryptoMulti.length) / crypto.length).toFixed(1) : 0}%)`);
  if (crypto.length) {
    const f1 = crypto.reduce((s, k) => s + k.fills[0].usdc, 0);
    const tt = crypto.reduce((s, k) => s + k.fills.reduce((x, f) => x + f.usdc, 0), 0);
    let gap = 0;
    for (const k of cryptoMulti) gap = Math.max(gap, k.fills[k.fills.length - 1].ts - k.fills[0].ts);
    console.log(`first-fill sizing captures ${$(f1)} of ${$(tt)} (${tt ? ((100 * f1) / tt).toFixed(0) : 100}%)`);
    console.log(`largest first→last fill gap in crypto: ${gap}ms`);
  }

  if (targetWallet) {
    const mine = all.filter((k) => k.wallet === targetWallet);
    const mineMulti = mine.filter((k) => k.fills.length > 1);
    console.log(`\n--- target wallet ${targetWallet.slice(0, 10)}… ---`);
    console.log(`orders: ${mine.length} | multi-fill: ${mineMulti.length}`);
    if (mine.length) {
      const f1 = mine.reduce((s, k) => s + k.fills[0].usdc, 0);
      const tt = mine.reduce((s, k) => s + k.fills.reduce((x, f) => x + f.usdc, 0), 0);
      console.log(`first-fill sizing would capture ${$(f1)} of ${$(tt)} (${tt ? ((100 * f1) / tt).toFixed(0) : 100}%)`);
    }
  }
  process.exit(0);
}

console.error(`watching ${WS_URL} for ${minutes} minute(s)… (Ctrl-C for early report)`);
setTimeout(report, minutes * 60 * 1000);
process.on("SIGINT", report);
