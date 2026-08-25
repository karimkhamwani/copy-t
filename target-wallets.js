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
  // {
  //   address: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30",
  //   category: "crypto",
  //   sub_category: ["eth-updown-5m"],
  //   max_trade_age_sec: 60, // 5m markets expire fast — don't chase old entries
  // },
  // good
  // {
  //   address: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
  //   category: "crypto",
  //   sub_category: ["eth-updown-5m"],
  //   max_trade_age_sec: 60, // 5m markets expire fast — don't chase old entries
  // },
  // btc good win rate over 11h 60%
  // {
  //   address: "0xdf4c6a942bd95bf903d6066b4ba7051e6f914f22",
  //   category: "crypto",
  //   sub_category: ["btc-updown-5m"],
  //   max_trade_age_sec: 60, // 5m markets expire fast — don't chase old entries
  // },
  // this wallet does bet both sides with less than 10$
  // {
  //   address: "0x0484e64092ba4108c2786b61e6fc052d3bf41b1a",
  //   category: "crypto",
  //   sub_category: ["btc-updown-5m"],
  //   max_trade_age_sec: 60, // 5m markets expire fast — don't chase old entries
  // },
  // {
  //   address: "0xc2ad03f79ca3f3c17d8c7de2612ce0c89b7d40ed",
  //   category: "crypto",
  //   sub_category: ["eth-updown-5m"],
  //   max_trade_age_sec: 5, // 5m markets expire fast — don't chase old entries
  // },
];

// 0xdf4c6a942bd95bf903d6066b4ba7051e6f914f22
