# Polymarket copy-trader (test)

Listens to Polymarket's real-time live-data websocket for one or more target wallets'
**BUY** trades and mirrors each new one as a **FOK market BUY** order via
`@polymarket/clob-client`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in values
npm start
```

## How it works

1. Subscribe to the live-data websocket (`WS_URL`) and watch trades from each
   wallet in target-wallets.js. Each entry is `{ address, category }` — the
   category is just a label used in logs. The feed only delivers live trades,
   so a newly added wallet's old history is never copied. For the first
   `BASELINE_WINDOW_MS` (default 2 minutes) after startup, trades are journaled
   as BASELINE and marked seen but not copied.
2. Keep only BUY trades that have an `asset` (token ID) and `transactionHash`.
3. Dedupe by `transactionHash:asset`, persisted in `seen-trades.json` so restarts
   don't re-place old trades.
4. For each new trade, place a market BUY on the same token spending a fixed
   `MAX_BET_USDC` (env, default $1 — Polymarket's minimum), regardless of the
   target's trade size. The feed never redelivers a trade, so failed orders are
   not retried.

## Dashboard

```bash
npm run dashboard
```

Opens at http://localhost:3210 (React, no build step, works offline). Top: an
analytics panel — stat tiles (copied trades, wins, losses, win rate, net P/L on
resolved bets) and an hourly stacked bar chart of wins vs losses vs pending, with
hover tooltips and per-bar totals. Left panel:
every BUY the target wallets make, with status (COPIED / FAILED / FILTERED / STALE /
BASELINE / PENDING). Right panel: our copied trades — market name, outcome, price
paid, shares received, USDC spent, DRY/LIVE mode, success or failure (with the error),
a WIN/LOSS/PENDING badge once the market resolves (with profit/loss amount),
and a Polygonscan link for live fills. Resolution is looked up from the gamma
markets API by conditionId, cached server-side (resolved markets are never
re-fetched; pending ones re-check every 60s). Header shows engine mode, heartbeat
(online/offline), bet size, ws signal state, and per-wallet sub-category filters.

The trader writes `trades-log.json` (journal, capped at 500 entries) and
`status.json` (heartbeat) next to the script; the dashboard server just reads them,
so it works identically in dry and live mode. Run both processes side by side.

## Env vars

Target wallets live in their own file (target-wallets.js):

```js
module.exports = [
  {
    address: "0x0cb038487586d1119b165466072e9baf666f3a90",
    category: "crypto",
    sub_category: ["btc"], // slug prefixes to copy; empty/omitted = copy everything
  },
];
```

`sub_category` filters by keywords in the market slug: `["btc"]` copies any market
whose slug contains `btc` anywhere (e.g. `btc-updown-5m-...`, `will-btc-hit-150k`)
and ignores everything else that wallet trades. Add more keywords to widen it
(e.g. `["btc", "eth"]`). Empty/omitted = copy everything.

| Var | Meaning |
| --- | --- |
| `TARGET_USERS` | Optional override: comma-separated addresses (mainly for tests) |
| `MAX_BET_USDC` | USDC spent per copied bet (min $1, default 1). With mirror mode on, this is the cap |
| `MIRROR_TRADER_BET` | `1` = bet what the trader bet, capped at `MAX_BET_USDC` (min $1). `0` = fixed bet (default) |
| `MAX_TRADES` | Stop after this many placed trades (0 = unlimited). Use `1` for the first live run |
| `MAX_ACTIVE_PCT` | Cap on open exposure: active bets stay <= this % of (balance + active), default 50. 0 = off |
| `ONE_SIDE_PER_MARKET` | `1` (default) = never buy the outcome opposite one we already hold in that market. Buying both sides is a self-hedge that only pays off if you also copy their exits — and we don't |
| `MAX_ENTRY_PRICE` | Skip entries above this price, default 0.85. At 0.98 the whole upside is 2c, less than a realistic fill cost |
| `MIN_ENTRY_PRICE` | Skip entries below this price (0 = off) |
| `MAX_COPIES_PER_MARKET` | Stop copying a market after N open fills (0 = unlimited) |
| `USE_BOOK_PRICE` | `1` (default) = read our own best ask before copying. Dry-run then fills at that ask instead of the target's price, and every copy records `bookAsk` + `slippageCents` |
| `MAX_SLIPPAGE_CENTS` | Skip when our ask is this many cents worse than their fill, default 1.5. 0 = off |
| `LOG_THEIR_SELLS` | `1` (default) = journal the target's SELLs (observe-only, never copied) so their exits are measurable |
| `WS_URL` | Live-data websocket URL, default `wss://ws-live-data.polymarket.com` |
| `BASELINE_WINDOW_MS` | Observe-only window after startup (journal, don't copy), default 120000 (2m). 0 = off |
| `DASHBOARD_PORT` | Dashboard server port, default 3210 |
| `DRY_RUN` | `1` = log orders instead of placing (default in .env.example) |
| `PRIVATE_KEY` | Your signing key (only needed when `DRY_RUN=0`) |
| `FUNDER_ADDRESS` | Your Polymarket proxy wallet holding USDC |
| `SIGNATURE_TYPE` | `1` = email/Magic login, `2` = browser-wallet proxy |

## Testing without Polymarket access

```bash
npm test
```

Runs offline unit tests for the BUY filter, dedupe, bet-sizing, price band,
self-hedge and per-market caps, and slippage maths.
Run the main script with `DRY_RUN=1` on a machine with API access to watch
it detect trades without spending anything; flip to `DRY_RUN=0` to go live.

Delete `seen-trades.json` to reset the dedupe history from scratch.
