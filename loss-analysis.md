# Why the live session lost $150

Source: `trades-log (4).json` — 433 journal rows, 134 copy attempts, **111 settled live bets**.
All figures below are live mode only (1 dry row and 22 failed attempts excluded).

## The number

| | |
|---|---|
| Staked | $941.83 |
| Returned | $791.74 |
| **Net** | **-$150.09** |
| Win rate | 40.5% (45W / 66L) |
| Break-even win rate needed | 50.4% |
| Session | 2.9 hours, 111 bets, **28 distinct markets** |

P/L reconciles two independent ways; all 111 rows settled; all 28 markets outcome-coherent.

## Decomposition

Holding your stakes constant and re-pricing every fill at the trader's own entry price:

| Component | Amount | Share |
|---|---|---|
| The strategy itself (copying picks that lost) | -$89.30 | 59% |
| Execution (fills worse than the trader's price) | -$60.80 | 41% |

## Cause 1 — the trader you copied was losing money

On the **identical 111 picks**, priced at the trader's own entries:

- Trader: staked $1,148.47, returned $1,044.07 → **-$104.40 (-9.1% ROI)**
- You: staked $941.83, returned $791.74 → **-$150.09 (-15.9% ROI)**

Same side, same markets, so the same win/loss. Their picks needed a 49.1% win rate to break even and hit 40.5%. There was no edge to copy; copying it faithfully cost you 9.1%, and execution turned that into 15.9%.

## Cause 2 — no price guard, so you buy positions the market has already written off

This is the mechanical flaw and it carries almost the whole loss.

| Fill vs trader's price | n | Win rate | P/L | ROI |
|---|---|---|---|---|
| Market moved **against** the position first (you filled cheaper) | 35 | 23% | **-$141.25** | -56.6% |
| Market moved with it (you filled dearer) | 53 | 53% | -$1.11 | -0.2% |

**32% of the trades produced 94% of the loss.**

The mechanism, from the single worst trade: the trader bought "Up" at **0.81**; 6.8 seconds later ETH ticked down and "Up" was trading at **0.39**; your order filled at 0.39 and lost the full $28.72. A fill far below the trader's price is not a discount — it is the market repricing the bet as already lost, and a market order takes it anyway.

By your actual fill price:

| Fill price | n | Needed | Got | ROI |
|---|---|---|---|---|
| under 0.30 | 16 | 21% | **0%** | -100% |
| 0.30–0.45 | 36 | 39% | 14% | -68.5% |
| 0.45–0.55 | 18 | 50% | 39% | -27.8% |
| 0.55–0.70 | 22 | 62% | 73% | **+25.3%** |
| over 0.70 | 19 | 85% | 89% | **+12.5%** |

`copy-trader.js:455` calls `createMarketOrder` (FAK) with **no price bound**. The only staleness protection is `maxTradeAgeSec`, which is time-based — it cannot see that the price has moved.

## Cause 3 — 111 bets were really only 28 coin flips

- 28 markets in 2.9 hours. One market absorbed **18 bets / $128.55** (4.3x the largest single bet); another 10 bets / $86.45.
- **The worst 5 markets account for -$170.25 — 113% of the total loss.** Everything else netted +$20.
- You bet **both sides** in 14 of 28 markets, 8 of them at price sums above 1.00 (worst: 1.263). The offsetting portion locked in about $5 of guaranteed loss and churned $684 of stake through the spread.

`MAX_ACTIVE_PCT` caps total exposure but nothing caps exposure *per market*, so the engine can pile 18 bets onto one 5-minute candle.

## The statistical caveat — read this before concluding the strategy is broken

Taking all 111 bets as independent gives z = -2.08, p ≈ 0.02, which looks like a real losing edge. **That is the wrong unit.** Bets cluster ~4 per market, and in 14 of 28 markets every bet shared a single outcome. At the real independent unit — 28 markets — z = -1.05, **p ≈ 0.15**.

**The $150 is not statistically distinguishable from bad luck.** A single 2.9-hour session of 28 correlated coin flips cannot establish that this loses money — and equally cannot establish that it works. The loss also accelerated through the session (17:00 UTC +$23.92 → 20:00 UTC -$64.64), which is what a lagging copier looks like when it gets run over by one directional ETH move.

The structural flaws in Causes 2 and 3 are real regardless of the sample size. The verdict on the *trader* is not yet established.

## What I tested that does NOT work

Getting faster is not the fix. Tightening the staleness cutoff on this data makes it steadily worse:

| Cutoff | Kept | ROI |
|---|---|---|
| 15s (actual) | 111 | -15.9% |
| 10s | 96 | -11.3% |
| 6s | 48 | -21.4% |
| 3s | 11 | **-42.8%** |

Your fastest copies were not your better copies. Median latency was 6.5s on 5-minute markets, and poll-sourced copies (median 8.1s) carried $108.60 of the loss versus $41.49 for websocket — but the cutoff sweep shows latency is a symptom, not the lever.

## What the data supports

1. **Add a price-deviation guard before ordering** — read the current ask and skip the trade if it sits below the trader's price by more than 1–3c. Backtested: -$150 becomes **-$8.85 to -$36.59** while still taking 76–86 of the 111 trades. This is a mechanical fix to a genuine missing check, and the most defensible change here.
2. **One position per market, and never both sides.** Cap stake per `conditionId`, and refuse a buy on a side you already hold the opposite of.
3. **Use a bounded order type**, not an unbounded market order, so a moving book cannot fill you at any price.
4. **Treat the min-entry-price filters with suspicion.** Filtering to entries at/above 0.45–0.50 flips this session to +8% to +18% ROI, but I tested roughly 25 filter variants against only 28 independent clusters. That is textbook overfitting and I would not deploy on it.
5. **Re-validate the trader over far more markets** — several hundred independent markets, in dry run — before risking money again. 28 clusters cannot tell you whether they can pick.
