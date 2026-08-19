/** Offline tests for the copy-trader logic (no network needed). */
const assert = require("assert");
const { filterBuys, pickNewTrades, betAmount, tradeKey, normalizeWallets, splitStale, matchesSubCategory, bestAsk, driftVerdict, marketOrderArgs, oldestFirst, prunedJournal, resumedSkipCounts } = require("./copy-trader");

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


// 10. Price-deviation guard
{
  // bestAsk: the book's asks run WORST-first / BEST-last, so the last level is
  // the best ask. Taking asks[0] would read the most expensive level instead.
  const book = { asks: [{ price: "0.72", size: "5" }, { price: "0.61", size: "9" }, { price: "0.55", size: "20" }] };
  assert.strictEqual(bestAsk(book), 0.55);
  assert.strictEqual(bestAsk({ asks: [] }), null);
  assert.strictEqual(bestAsk({}), null);
  assert.strictEqual(bestAsk(null), null);
  assert.strictEqual(bestAsk({ asks: [{ price: "not-a-number" }] }), null);

  const band = { adverse: 0.03, overpay: 0.05 };
  // inside the band, either direction -> allowed
  assert.strictEqual(driftVerdict(0.50, 0.50, band).allowed, true);
  assert.strictEqual(driftVerdict(0.48, 0.50, band).allowed, true); // 2c adverse
  assert.strictEqual(driftVerdict(0.54, 0.50, band).allowed, true); // 4c overpay
  // exactly at the limit is allowed, and must not hinge on float representation
  // (0.47 - 0.50 is -0.030000000000000027 in IEEE754)
  assert.strictEqual(driftVerdict(0.47, 0.50, band).allowed, true);
  assert.strictEqual(driftVerdict(0.55, 0.50, band).allowed, true);
  // past the limit -> blocked
  assert.strictEqual(driftVerdict(0.4699, 0.50, band).allowed, false);
  assert.strictEqual(driftVerdict(0.5501, 0.50, band).allowed, false);

  // the real losing case from the Aug 18 session: trader got 0.81, book had
  // fallen to 0.39 by the time the order landed. Must be refused.
  const worst = driftVerdict(0.39, 0.81, band);
  assert.strictEqual(worst.allowed, false);
  assert.match(worst.reason, /moved against us/);
  assert.match(worst.reason, /0\.420/); // reports the actual drift

  // fail closed on unusable inputs
  for (const bad of [null, undefined, NaN, "0.4"]) {
    assert.strictEqual(driftVerdict(bad, 0.5, band).allowed, false, `execPrice ${bad}`);
  }
  for (const bad of [null, undefined, NaN, 0, -1]) {
    assert.strictEqual(driftVerdict(0.5, bad, band).allowed, false, `theirPrice ${bad}`);
  }
  assert.match(driftVerdict(null, 0.5, band).reason, /fail-closed/);

  // a zero band means exact-price-or-nothing, not "disabled"
  assert.strictEqual(driftVerdict(0.49, 0.50, { adverse: 0, overpay: 0 }).allowed, false);
  assert.strictEqual(driftVerdict(0.50, 0.50, { adverse: 0, overpay: 0 }).allowed, true);

  // overpay is checked independently of adverse drift
  assert.strictEqual(driftVerdict(0.90, 0.50, { adverse: 1, overpay: 0.05 }).allowed, false);
  assert.match(driftVerdict(0.90, 0.50, { adverse: 1, overpay: 0.05 }).reason, /overpay/);
}


// 11. The drift guard must not add a network round-trip.
//
// clob-client-v2's createMarketOrder only calls calculateMarketPrice — a /book
// fetch, ~180ms against the live CLOB — when `price` is absent. The guard has
// already paid for that fetch, so its price must be threaded into the order.
// If this regresses, every copy costs a second round-trip and the drift window
// the guard exists to close gets WIDER.
{
  const base = { tokenID: "tok", amount: 10, side: "BUY", orderType: "FAK" };

  // guard produced a price -> it is passed through, so the client will not re-fetch
  const withPrice = marketOrderArgs({ ...base, execPrice: 0.6 });
  assert.strictEqual(withPrice.price, 0.6);
  assert.ok("price" in withPrice, "price must be present or the client re-fetches the book");

  // 0 is a real price and must survive (it is finite, even though it is falsy)
  assert.strictEqual(marketOrderArgs({ ...base, execPrice: 0 }).price, 0);

  // no usable price (guard off / dry-run without a key) -> omit the key entirely
  // rather than sending undefined, so the client prices it as it always did
  for (const bad of [undefined, null, NaN, "0.6"]) {
    const args = marketOrderArgs({ ...base, execPrice: bad });
    assert.strictEqual("price" in args, false, `execPrice ${bad} must not set price`);
  }

  // the rest of the order is unchanged
  assert.deepStrictEqual(marketOrderArgs(base), base);
}

// 12. Retention keeps the newest `cap` rows whatever their status.
//
// The previous rule was "no copy -> evictable", which rotated skip decisions
// (min/risk/drift carry no `copy`) out of the journal: the dashboard showed a
// rising drift-skipped counter with no rows explaining it. The window the panel
// lists must be untouchable, so status plays no part in eviction.
{
  const rows = [];
  const statuses = ["baseline", "filtered", "stale", "pending", "min-skip", "risk-skip", "drift-skip"];
  // 350 rows, newest first, cycling through every status
  for (let i = 0; i < 350; i++) {
    rows.push({ id: `t${i}`, tradedAt: 1_000_000 - i * 1000, status: statuses[i % statuses.length], copy: null });
  }
  const kept = prunedJournal(rows, 300);
  assert.strictEqual(kept.length, 300);
  // every one of the newest 300 survives, no matter what status it carries
  for (let i = 0; i < 300; i++) {
    assert.ok(kept.some((e) => e.id === `t${i}`), `t${i} (${rows[i].status}) must be kept`);
  }
  for (let i = 300; i < 350; i++) {
    assert.ok(!kept.some((e) => e.id === `t${i}`), `t${i} is past the window`);
  }
  // display order is preserved — pruning must not reshuffle the journal
  assert.deepStrictEqual(kept.map((e) => e.id), rows.slice(0, 300).map((e) => e.id));
}

// A copy attempt outlives the window: it is the lifetime P/L record.
{
  const rows = [];
  for (let i = 0; i < 320; i++) rows.push({ id: `n${i}`, tradedAt: 900_000 - i, status: "filtered", copy: null });
  rows.push({ id: "old-copy", tradedAt: 1, status: "success", copy: { spentUsdc: 5 } });
  const kept = prunedJournal(rows, 300);
  assert.ok(kept.some((e) => e.id === "old-copy"), "copied rows are never evicted");
}

// Rows ranked by time, not position: an out-of-order journal still keeps its newest.
{
  const rows = [
    { id: "old", tradedAt: 100, status: "stale", copy: null },
    { id: "new", tradedAt: 900, status: "stale", copy: null },
    { id: "mid", observedAt: 500, status: "stale", copy: null }, // no tradedAt -> observedAt
  ];
  assert.deepStrictEqual(prunedJournal(rows, 2).map((e) => e.id), ["new", "mid"]);
}

// 13. Journal writes go in oldest-first so unshift lands newest-at-top.
assert.deepStrictEqual(
  oldestFirst([{ timestamp: 300 }, { timestamp: 100 }, { timestamp: 200 }]).map((t) => t.timestamp),
  [100, 200, 300],
);

// 14. Skip counters resume from the previous status file across restarts.
assert.deepStrictEqual(
  resumedSkipCounts({ riskSkipped: 7, driftSkipped: 12 }),
  { riskSkipped: 7, driftSkipped: 12 },
);
// no status file (fresh start / yarn reset) -> zeroed, not NaN
assert.deepStrictEqual(resumedSkipCounts(null), { riskSkipped: 0, driftSkipped: 0 });
// a status file written before the counters existed reads as 0
assert.deepStrictEqual(resumedSkipCounts({ mode: "dry" }), { riskSkipped: 0, driftSkipped: 0 });
// junk never poisons the running total
for (const bad of [NaN, -3, "5", null, undefined, Infinity]) {
  assert.deepStrictEqual(
    resumedSkipCounts({ riskSkipped: bad, driftSkipped: bad }),
    { riskSkipped: 0, driftSkipped: 0 },
    `bad skip count ${String(bad)} should read as 0`,
  );
}

console.log("all tests passed");
