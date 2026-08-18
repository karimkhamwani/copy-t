/** Offline tests for the copy-trader logic (no network needed). */
const assert = require("assert");
const { filterBuys, pickNewTrades, betAmount, tradeKey, normalizeWallets, splitStale, matchesSubCategory, priceBandReject, hedgeReject, marketCapReject, slippageCents } = require("./copy-trader");

const sample = [
  { type: "TRADE", side: "BUY", transactionHash: "0xaaa", asset: "111", usdcSize: 50, price: 0.42, timestamp: 100, title: "Market A", outcome: "Yes" },
  { type: "TRADE", side: "SELL", transactionHash: "0xbbb", asset: "222", usdcSize: 10, price: 0.6, timestamp: 101, title: "Market B", outcome: "No" },
  { type: "TRADE", side: "BUY", transactionHash: "0xccc", asset: "333", usdcSize: 0.5, price: 0.1, timestamp: 102, title: "Market C", outcome: "Yes" },
  { type: "REDEEM", side: "", transactionHash: "0xddd", asset: "444", timestamp: 103 },
  { type: "TRADE", side: "BUY", transactionHash: "", asset: "555", timestamp: 104 }, // missing hash -> dropped
];

// 1. Only valid BUY trades survive
const buys = filterBuys(sample);
assert.strictEqual(buys.length, 2);
assert.deepStrictEqual(buys.map((t) => t.transactionHash), ["0xaaa", "0xccc"]);

// 2. Dedupe against seen set
const seen = new Set([tradeKey(buys[0])]);
const fresh = pickNewTrades(buys, seen);
assert.strictEqual(fresh.length, 1);
assert.strictEqual(fresh[0].transactionHash, "0xccc");

// 3. Same list again -> nothing new once marked seen
fresh.forEach((t) => seen.add(tradeKey(t)));
assert.strictEqual(pickNewTrades(buys, seen).length, 0);

// 4. Bet sizing
// fixed mode (default): always MAX_BET_USDC, regardless of their trade size
assert.strictEqual(betAmount({ usdcSize: 50 }, { mirror: false, cap: 1 }), 1);
assert.strictEqual(betAmount({ usdcSize: 0.5 }, { mirror: false, cap: 1 }), 1);
assert.strictEqual(betAmount({}, { mirror: false, cap: 1 }), 1);
// mirror mode: match trader's size, capped, floored at $1 minimum
assert.strictEqual(betAmount({ usdcSize: 50 }, { mirror: true, cap: 10 }), 10); // capped
assert.strictEqual(betAmount({ usdcSize: 3.5 }, { mirror: true, cap: 10 }), 3.5); // matched
assert.strictEqual(betAmount({ usdcSize: 0.4 }, { mirror: true, cap: 10 }), 1); // $1 floor
assert.strictEqual(betAmount({}, { mirror: true, cap: 10 }), 10); // no size -> cap

// 5. Wallet list normalization: trims, lowercases, dedupes by address, defaults category
assert.deepStrictEqual(
  normalizeWallets([
    { address: " 0xABC ", category: "esports" },
    { address: "0xdef" },
    { address: "0xabc", category: "dupe" },
    { address: "" },
  ]),
  [
    { address: "0xabc", category: "esports", subCategories: [], maxTradeAgeSec: null },
    { address: "0xdef", category: "uncategorized", subCategories: [], maxTradeAgeSec: null },
  ]
);
assert.deepStrictEqual(normalizeWallets(undefined), []);
// per-wallet stale cutoff; absent or junk = null (no cutoff, copy any age)
assert.strictEqual(
  normalizeWallets([{ address: "0xa", max_trade_age_sec: 7 }])[0].maxTradeAgeSec,
  7
);
assert.strictEqual(
  normalizeWallets([{ address: "0xa", max_trade_age_sec: "nope" }])[0].maxTradeAgeSec,
  null
);

// 6. Staleness split: trades older than maxAge go to stale, missing timestamp = stale
{
  const now = 1000;
  const { copyable, stale } = splitStale(
    [{ transactionHash: "0x1", timestamp: 950 }, { transactionHash: "0x2", timestamp: 700 }, { transactionHash: "0x3" }],
    now,
    120
  );
  assert.deepStrictEqual(copyable.map((t) => t.transactionHash), ["0x1"]);
  assert.deepStrictEqual(stale.map((t) => t.transactionHash), ["0x2", "0x3"]);
}

// 7. Sub-category filter: slug contains any keyword, empty list = allow all
{
  const btcTrade = { slug: "btc-updown-5m-1786686900", eventSlug: "btc-updown-5m-1786686900" };
  const ethTrade = { slug: "eth-updown-5m-1786686900" };
  const nbaTrade = { slug: "nba-lal-bos-2026-08-14" };
  assert.strictEqual(matchesSubCategory(btcTrade, ["btc"]), true);
  assert.strictEqual(matchesSubCategory(ethTrade, ["btc"]), false);
  assert.strictEqual(matchesSubCategory(ethTrade, ["btc", "eth"]), true);
  assert.strictEqual(matchesSubCategory(nbaTrade, ["btc"]), false);
  assert.strictEqual(matchesSubCategory(nbaTrade, []), true); // empty = all
  assert.strictEqual(matchesSubCategory({ slug: "will-btc-hit-150k-2026" }, ["btc"]), true); // keyword anywhere in slug
  // normalizeWallets carries sub_category through, lowercased
  const [w] = normalizeWallets([{ address: "0xA", category: "crypto", sub_category: [" BTC ", ""] }]);
  assert.deepStrictEqual(w.subCategories, ["btc"]);
}

// 8. Entry-price band: above the cap the upside is smaller than a real fill cost
{
  const band = { max: 0.85, min: 0.05 };
  assert.strictEqual(priceBandReject(0.52, band), null);
  assert.strictEqual(priceBandReject(0.85, band), null); // inclusive
  assert.ok(priceBandReject(0.98, band).includes("above"));
  assert.ok(priceBandReject(0.02, band).includes("below"));
  // disabled (0) and unknown prices never reject
  assert.strictEqual(priceBandReject(0.99, { max: 0, min: 0 }), null);
  assert.strictEqual(priceBandReject(undefined, band), null);
  assert.strictEqual(priceBandReject(0, band), null);
}

// 9. Self-hedge guard: never buy the outcome opposite one we already hold
{
  const copies = [
    { conditionId: "0xmarket", asset: "UP", outcome: "Up", copy: { settled: false } },
  ];
  const down = { conditionId: "0xmarket", asset: "DOWN", outcome: "Down" };
  const upAgain = { conditionId: "0xmarket", asset: "UP", outcome: "Up" };
  const other = { conditionId: "0xother", asset: "DOWN", outcome: "Down" };
  assert.ok(hedgeReject(down, copies).includes("Up"));
  assert.strictEqual(hedgeReject(upAgain, copies), null); // scaling in is fine
  assert.strictEqual(hedgeReject(other, copies), null); // different market
  assert.strictEqual(hedgeReject(down, copies, { enabled: false }), null);
  // a settled market is a clean slate
  const settled = [{ ...copies[0], copy: { settled: true } }];
  assert.strictEqual(hedgeReject(down, settled), null);
}

// 10. Per-market fill cap counts only open copies in that market
{
  const mk = (asset) => ({ conditionId: "0xm", asset, outcome: "Up", copy: { settled: false } });
  const copies = [mk("UP"), mk("UP"), mk("UP")];
  const trade = { conditionId: "0xm", asset: "UP", outcome: "Up" };
  assert.strictEqual(marketCapReject(trade, copies, { max: 0 }), null); // disabled
  assert.strictEqual(marketCapReject(trade, copies, { max: 5 }), null);
  assert.ok(marketCapReject(trade, copies, { max: 3 }).includes("3 copies"));
  assert.strictEqual(marketCapReject({ conditionId: "0xz", asset: "UP" }, copies, { max: 1 }), null);
}

// 11. Slippage in cents, ours vs theirs
{
  assert.strictEqual(slippageCents(0.53, 0.52), 1);
  assert.strictEqual(slippageCents(0.5, 0.52), -2); // we filled better
  assert.strictEqual(slippageCents(0.525, 0.52), 0.5);
  assert.strictEqual(slippageCents(null, 0.52), null);
}

console.log("all tests passed");
