# Polymarket copy-trader (test)

Polls the Polymarket activity API every 30s for one or more target wallets' **BUY** trades
and mirrors each new one as a **FOK market BUY** order via `@polymarket/clob-client`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in values
npm start
```

## How it works

1. Every `POLL_INTERVAL_MS` (default 30s), fetch `/activity` for each wallet in the
   `TARGET_WALLETS` array at the top of copy-trader.js
   (`excludeDepositsWithdrawals=true`, sorted newest first). Each entry is
   `{ address, category }` — the category is just a label used in logs.
2. Keep only BUY trades that have an `asset` (token ID) and `transactionHash`.
3. Dedupe by `transactionHash:asset`, persisted in `seen-trades.json` so restarts
   don't re-place old trades. Each wallet is baselined independently the first time
   it's watched — adding a new wallet later never copies its old history.
4. For each new trade, place a market BUY on the same token spending a fixed
   `MAX_BET_USDC` (env, default $1 — Polymarket's minimum), regardless of the
   target's trade size. Failed orders are retried on the next poll.

## Env vars

Target wallets live in the script itself (`TARGET_WALLETS` in copy-trader.js):

```js
const TARGET_WALLETS = [
  { address: "0x30c7ac0158499ddc6761047f7f69bcf7d036ac3b", category: "esports" },
];
```

| Var | Meaning |
| --- | --- |
| `TARGET_USERS` | Optional override: comma-separated addresses (mainly for tests) |
| `MAX_BET_USDC` | USDC spent per copied bet (min $1, default 1) |
| `MAX_TRADES` | Stop after this many placed trades (0 = unlimited). Use `1` for the first live run |
| `MAX_TRADE_AGE_SEC` | Skip trades older than this (default 120s) — avoids chasing expired fast markets |
| `POLL_INTERVAL_MS` | Poll interval, default 30000 |
| `DRY_RUN` | `1` = log orders instead of placing (default in .env.example) |
| `PRIVATE_KEY` | Your signing key (only needed when `DRY_RUN=0`) |
| `FUNDER_ADDRESS` | Your Polymarket proxy wallet holding USDC |
| `SIGNATURE_TYPE` | `1` = email/Magic login, `2` = browser-wallet proxy |

## Testing without Polymarket access

```bash
npm test
```

Runs offline unit tests for the BUY filter, dedupe, and bet-sizing logic.
Run the main script with `DRY_RUN=1` on a machine with API access to watch
it detect trades without spending anything; flip to `DRY_RUN=0` to go live.

Delete `seen-trades.json` to re-baseline from scratch.
