/**
 * Latency regression guard: does the market-info prefetch actually spare
 * createMarketOrder its metadata lookups?
 *
 * For an unseen token createMarketOrder makes two SEQUENTIAL requests
 * (/markets-by-token/ then /clob-markets/, ~227ms + ~238ms live). Every 5-minute
 * market is an unseen token, so that landed on nearly every copy. warmMarketInfo()
 * fetches /clob-markets/ for the condition id we already have, in parallel with
 * the drift guard's /book read, which leaves the order path with none.
 *
 * Runs a local HTTP server against the REAL ClobClient, so it tests the library's
 * caching rather than our belief about it. No network, no account, no orders.
 *
 *   npm run test:prefetch
 */
// Uses the REAL ClobClient against a counting fake, so this tests the library's
// own _ensureMarketInfoCached / _resolveTickSize / getNegRisk logic.
const assert = require("assert");
const http = require("http");
const path = require("path");
const ROOT = path.join(__dirname, "node_modules/@polymarket/clob-client-v2/dist");
const CID = "0xcond-test";
const TOKEN = "77777";

const hits = {};
const bump = (k) => (hits[k] = (hits[k] || 0) + 1);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(o)); };
  if (u.pathname.startsWith("/markets-by-token/")) { bump("markets-by-token"); return json({ condition_id: CID }); }
  if (u.pathname.startsWith("/clob-markets/"))     { bump("clob-markets"); return json({
      t: [{ t: TOKEN }, { t: "88888" }], mts: "0.01", nr: false, fd: { r: 0, e: 1, to: true } }); }
  if (u.pathname === "/tick-size") { bump("tick-size"); return json({ minimum_tick_size: "0.01" }); }
  if (u.pathname === "/neg-risk")  { bump("neg-risk");  return json({ neg_risk: false }); }
  if (u.pathname === "/auth/api-key" || u.pathname === "/auth/derive-api-key")
    return json({ key: "k", secret: "c2VjcmV0", passphrase: "p" });
  json({});
});

(async () => {
  await new Promise((r) => server.listen(4399, r));
  const { ClobClient } = await import(`file://${ROOT}/index.js`);
  const { Wallet } = require("@ethersproject/wallet");
  const mk = () => new ClobClient({
    host: "http://localhost:4399", chain: 137,
    // Hardhat's public test key: local signing only, no funds, no real account.
    signer: new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
    signatureType: 1, funderAddress: "0x000000000000000000000000000000000000beef",
  });

  // --- WITHOUT the prefetch: what the order path used to pay ---
  for (const k in hits) delete hits[k];
  let c = mk();
  await c._ensureMarketInfoCached(TOKEN);
  await c._resolveTickSize(TOKEN, undefined);
  await c.getNegRisk(TOKEN);
  const before = { ...hits };

  // --- WITH the prefetch (one getClobMarketInfo on the condition id) ---
  for (const k in hits) delete hits[k];
  c = mk();
  await c.getClobMarketInfo(CID);            // what warmMarketInfo() does
  const afterPrefetch = { ...hits };
  for (const k in hits) delete hits[k];
  await c._ensureMarketInfoCached(TOKEN);    // what createMarketOrder then does
  await c._resolveTickSize(TOKEN, undefined);
  await c.getNegRisk(TOKEN);
  const onOrderPath = { ...hits };

  const n = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  console.log("order path WITHOUT prefetch :", JSON.stringify(before), `= ${n(before)} calls`);
  console.log("the prefetch itself         :", JSON.stringify(afterPrefetch), `= ${n(afterPrefetch)} call`);
  console.log("order path WITH prefetch    :", JSON.stringify(onOrderPath), `= ${n(onOrderPath)} calls`);

  assert.strictEqual(n(before), 2, "expected the 2-call sequential lookup");
  assert.strictEqual(n(afterPrefetch), 1, "prefetch should be a single request");
  assert.strictEqual(n(onOrderPath), 0, "order path must make NO metadata calls after the prefetch");
  console.log("\nPASS: 2 sequential calls on the order path -> 0. The 1 prefetch call runs in parallel with /book.");
  server.close();
})().catch((e) => { console.error("FAIL:", e.message); server.close(); process.exit(1); });
