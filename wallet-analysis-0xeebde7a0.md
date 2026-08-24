# Wallet analysis — 0xeebde7a0e019a63e6b476eb425505b7b3e6eba30

Analyzed 2026-08-24. On-chain data via the public Polymarket orderbook subgraph
(Goldsky) + market resolutions via gamma-api. Polygonscan for balances.

## What this wallet is

A **Polymarket proxy wallet** (created by the Polymarket Proxy Wallet Factory,
~152 days ago) running a **high-frequency market-making operation in crypto
up/down short-duration markets** — the same market family as our updown bot,
at roughly four orders of magnitude more volume.

Current holdings (Polygonscan): **~$209,335 Polymarket USD (pUSD)**, plus dust.
Only 1 outbound on-chain tx — everything happens inside Polymarket's exchange
contracts, which is why Polygonscan looks "dormant".

## Data coverage — important caveat

The orderbook subgraph **stopped indexing at 2026-04-28** (Polymarket migrated
to new contracts / pUSD). So on-chain fill history is only available for
**2026-03-25 → 2026-04-28**. Nothing after that is visible from this source.

Deep analysis below is a **3-day sample: 2026-03-25 → 2026-03-28, 397,645 fills**
(the wallet trades ~130k fills/day, so a full 5-week pull was impractical).
All 4,087 tokens in the sample were matched to resolved markets, so the P&L
figure is complete for the window — not an estimate.

## P&L (3-day sample)

| | |
|---|---|
| Net trading cash flow | **−$2,267,370** |
| Resolution payouts | **+$2,374,055** |
| **Net P&L** | **+$106,686** |

Daily: 03-25 **+$37,188** · 03-26 **+$43,815** · 03-27 **+$16,907** · 03-28 **+$8,776** (partial)

- ~**$35k/day** average over the window
- **+$0.27 profit per fill** (397,645 fills)
- ~**2.9%** return on the $3.62M of capital deployed into buys over 3 days
- Per market: 2,050 markets traded, **58% profitable**, median **+$26.52**,
  best **+$2,791**, worst **−$5,608**, average **+$52**

## What it trades

| Series | Fills | P&L |
|---|---|---|
| btc-updown-5m | 144,496 | +$76,241 |
| eth-updown-5m | 107,806 | +$11,849 |
| btc-updown-15m | 81,255 | +$13,105 |
| eth-updown-15m | 56,591 | +$4,498 |
| daily BTC up/down | 6,993 | +$469 |
| btc-updown-4h | 504 | +$523 |

**BTC 5-minute markets alone are 71% of its profit** — the exact market we trade.

## Mechanics — how it actually operates

| Role / side | Fills | Volume | VWAP | P&L |
|---|---|---|---|---|
| maker-buy (passive bids) | 199,209 | $3,480,402 | 0.532 | **+$67,663** |
| taker-sell (hits bids) | 180,900 | $1,354,866 | 0.451 | **+$33,201** |
| taker-buy (lifts asks) | 17,535 | $141,834 | 0.526 | +$5,821 |
| maker-sell | 1 | — | — | — |

Three things stand out:

1. **It buys passively, sells aggressively.** It posts resting limit *buys*
   (199,209 of them) and essentially never posts a resting sell (exactly one in
   3 days). Every exit is an aggressive taker-sell into the standing bid.
   This is our updown bot's shape: quote bids, never quote offers.

2. **It hedges partially, not fully.** In **63% of markets it holds BOTH Up and
   Down**, and **62% of its long shares sit in matched pairs**. The rest is
   deliberate directional exposure — it does not insist on a perfect pair.

3. **Cutting stranded legs is a third of the profit.** Buy VWAP 0.532 vs sell
   VWAP 0.451 — it sells *below* its average buy price, yet those sells earn
   **+$33,201**, i.e. it dumps legs that would have resolved worthless. It buys
   6.81M shares, sells 3.00M at a "loss", and the 3.81M it keeps pays out
   $2.37M. **This is precisely the unwind/sell-back logic we built** — a pro
   operation attributes ~31% of its P&L to it.

## Size and pace

- Median fill **$5.00**, average **$12.52**, p75 $12.20, p95 $38.01, max $2,467
- ~130,000 fills/day across ~1,350 markets/day
- 15,625 unique counterparties (top one at 33.8% is the exchange operator address)
- Price distribution is broad, centered mid-book: 44% of fills between 0.35–0.65,
  only 2.9% at ≥0.95 and 3.6% under 0.05

## Takeaways for our bot

1. **The strategy family is validated at scale** — passive two-sided bids on
   BTC/ETH 5m and 15m up/down markets is a real, profitable business, and the
   5m BTC market is the most profitable piece of it.
2. **Tiny clips, enormous count.** $5 median fill. The edge per fill is ~$0.27;
   the business is repetition, not size. Our $0.10–0.20/pair target is the same
   order of magnitude — we are short by ~5 orders of magnitude of *count*.
3. **Full hedging is not required.** 38% of its exposure is unpaired. Our
   all-or-nothing pair framing is stricter than what a profitable operator runs.
4. **Exits matter as much as entries.** ~31% of its profit comes from selling
   stranded legs before resolution — validating the watchdog, and arguing for a
   *faster* leash than 50s plus a real position-management pass.
5. **It also takes** (17.5k aggressive buys, +$5,821) — i.e. it lifts asks when
   they are mispriced, which is what the delta bot is meant to do. Small share
   of profit, though: the passive quoting is the core.

## The two numbers that matter most (added pass 2)

### It is NOT running our arb

For the 2,017 markets where it bought both sides, the sum of its average Up
price + average Down price is:

| median | p25 | p75 | share with sum < 1.00 |
|---|---|---|---|
| **1.018** | 0.971 | 1.071 | **39%** |

**The median pair costs MORE than $1.00.** Only 39% of its paired markets are
the riskless `sum < 1` arb our updown bot insists on. So its edge is not locked
arbitrage at all — it is:

1. buying **below fair value** as a passive maker (spread capture), plus
2. **cutting the wrong side fast**, plus
3. holding the right side to $1.

### Per-share economics (the real edge)

- bought 6,809,574 sh @ VWAP **0.5319** = $3.62M
- sold 3,002,555 sh @ VWAP 0.4512 (**44% of all shares bought get cut**)
- kept 3,807,019 sh → payout avg **0.6379**/share (**64% win rate on held**)
- blended revenue 0.5556 vs cost 0.5319

> **Edge = 2.37 cents per share bought.**

### How fast it cuts losers

Share-weighted time from buy to sell:

| p10 | p25 | **median** | p75 | p90 |
|---|---|---|---|---|
| 10s | 24s | **54s** | 108s | 188s |

16% cut within 15s · 32% within 30s · **54% within 60s** · 79% within 120s

Our `UPDOWN_UNWIND_SEC=50` is almost exactly its median. But note the front of
that distribution: a quarter of its cuts happen inside 24 seconds, which a
fixed 50s timer cannot do — that needs fill-triggered exits.

## Method / reproducibility

- Fills: `orderFilledEvents` from
  `api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/prod/gn`,
  filtered on `maker` and `taker`, paginated by timestamp cursor (graph-node
  caps `skip` at 5000).
- Side decoding: maker gives `makerAmountFilled` of `makerAssetId` and receives
  `takerAmountFilled` of `takerAssetId`; taker is the mirror. `assetId == "0"`
  is USDC. All amounts 6-decimal.
- Resolutions: `gamma-api.polymarket.com/markets?clob_token_ids=…&closed=true`
  (repeated params batch; comma-separated is rejected), reading `outcomePrices`
  per token index. 4,087/4,087 tokens resolved.
- P&L per token = net USDC flow + net shares × payout(0 or 1).

Note: `data-api.polymarket.com` and `polymarket.com` were unreachable from this
machine (TLS blocked), so profile-level lifetime P&L could not be cross-checked
against Polymarket's own display.
