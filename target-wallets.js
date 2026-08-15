/**
 * Wallets to copy — edit this list to add/remove users.
 *
 * Each entry:
 *   address            target's proxy wallet (0x…)
 *   category           free-form label shown on the dashboard
 *   sub_category       slug keywords to copy, e.g. ["btc-updown-5m"]. Empty = copy everything.
 *   max_trade_age_sec  skip this wallet's trades older than this many seconds
 *                      (optional — omit to copy regardless of trade age)
 */

module.exports = [
  // {
  //   address: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
  //   category: "crypto",
  //   sub_category: ["btc"],
  // },
  {
    address: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
    category: "crypto",
    sub_category: ["btc-updown-5m"],
    max_trade_age_sec: 30, // 5m markets expire fast — don't chase old entries
  },
];
