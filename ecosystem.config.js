/**
 * pm2 config: runs the trader + dashboard and auto-restarts BOTH when code
 * changes (e.g. after pulling new files onto the machine).
 *
 *   npm run up      -> start both under pm2 with watch
 *   npm run down    -> stop both
 *   pm2 logs        -> tail logs
 *
 * Watch lists are code-only on purpose: the trader rewrites trades-log.json /
 * seen-trades.json / status.json constantly, and watching those would cause
 * an endless restart loop.
 */

module.exports = {
  apps: [
    {
      name: "copy-trader",
      script: "copy-trader.js",
      watch: ["copy-trader.js", ".env"],
      watch_delay: 2000,
      // A clean exit (MAX_TRADES reached) must NOT be auto-restarted,
      // otherwise pm2 would immediately place another batch of trades.
      stop_exit_codes: [0],
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: "dashboard",
      script: "dashboard-server.js",
      watch: ["dashboard-server.js", "dashboard", ".env"],
      watch_delay: 2000,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
