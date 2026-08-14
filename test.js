/** Offline tests for the copy-trader logic (no network needed). */
const assert = require("assert");
const { filterBuys, pickNewTrades, betAmount, tradeKey, normalizeWallets } = require("./copy-trader");

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

// 4. Bet sizing: always the fixed $1, regardless of their trade size
assert.strictEqual(betAmount({ usdcSize: 50 }), 1);
assert.strictEqual(betAmount({ usdcSize: 0.5 }), 1);
assert.strictEqual(betAmount({}), 1);

// 5. Wallet list normalization: trims, lowercases, dedupes by address, defaults category
assert.deepStrictEqual(
  normalizeWallets([
    { address: " 0xABC ", category: "esports" },
    { address: "0xdef" },
    { address: "0xabc", category: "dupe" },
    { address: "" },
  ]),
  [
    { address: "0xabc", category: "esports" },
    { address: "0xdef", category: "uncategorized" },
  ]
);
assert.deepStrictEqual(normalizeWallets(undefined), []);

console.log("all tests passed");
