/**
 * PM2 process definitions for the Hostinger VPS (§2).
 *
 * Four processes, because they fail independently and you want to know which
 * one did:
 *
 *   balast-web      the Next.js front end
 *   balast-api      Fastify: /api/snapshot and the websocket
 *   balast-indexer  the log poller
 *   balast-keeper   pokes and routes the token teams' routers (P4); vaults need none
 *
 * The indexer is the one that matters most when it dies. §7 and the P3
 * criterion both name the same failure: a process that stops quietly while the
 * site keeps showing its last numbers as though they were live. It does not
 * exit on an RPC error — it backs off and retries — so PM2 restarting it is
 * the second line of defence, not the first. The lag figure in the top bar is
 * the first.
 *
 * Secrets are NOT here. `/var/www/balast/.env` holds DATABASE_URL,
 * USDG_ADDRESS and KEEPER_PRIVATE_KEY, and nothing in this repository should
 * ever contain any of them.
 *
 * PM2 does not read a .env file and neither does Node, so each entry point
 * imports server/load-env.ts first and reads it itself. That was missing
 * once: bootstrap.sh wrote the file, nothing opened it, and both of these
 * processes crash-looped on "DATABASE_URL is required" while pointing at a
 * file sitting right there.
 */
module.exports = {
  apps: [
    {
      name: 'balast-web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: '/var/www/balast',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // No DATA_SOURCE here. next.config.mjs inlines it when the site is
        // BUILT, from .env, so a value here changes nothing at runtime and
        // only looks authoritative. deploy/data-source.sh switches it.
      },
      error_file: '/var/log/balast/web.error.log',
      out_file: '/var/log/balast/web.out.log',
      time: true,
    },
    {
      name: 'balast-api',
      script: 'node_modules/.bin/tsx',
      args: 'server/api/main.ts',
      cwd: '/var/www/balast',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      // Same reasoning as the indexer below: a config error should end in a
      // visible `errored` state, not an endless restart loop.
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        API_PORT: 3001,
        API_HOST: '127.0.0.1',
      },
      error_file: '/var/log/balast/api.error.log',
      out_file: '/var/log/balast/api.out.log',
      time: true,
    },
    {
      name: 'balast-indexer',
      script: 'node_modules/.bin/tsx',
      args: 'server/indexer/main.ts',
      cwd: '/var/www/balast',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // A first sync from a low START_BLOCK holds a lot of block timestamps.
      max_memory_restart: '1G',
      // Long enough that a crash loop is visible in `pm2 list` as a climbing
      // restart count rather than hidden behind instant restarts.
      restart_delay: 5_000,
      // Give up after ten failures that happen inside ten seconds.
      //
      // A missing USDG_ADDRESS is a configuration error, not a transient
      // fault, and restarting forever neither fixes it nor surfaces it — this
      // process reached 8,086 restarts on a mistake one line of config would
      // solve. Ten attempts, then `errored` in `pm2 status`, which is a state
      // somebody can actually see. A real crash after ten seconds of uptime
      // does not count against the budget.
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/balast/indexer.error.log',
      out_file: '/var/log/balast/indexer.out.log',
      time: true,
    },
    {
      // The only process that signs. It reads KEEPER_PRIVATE_KEY from .env
      // (server/load-env.ts), removes it from its own environment once the
      // account is derived, and never logs it.
      //
      // ONE instance, always: two keepers would race to poke and route the
      // same router. The contracts make that harmless — a poke inside a
      // minute of the last is a no-op, and a route that is not due reverts in
      // simulation — but it is gas and noise for nothing.
      //
      // With no router factory deployed, or no key, it stays up idle and says
      // why once.
      // It does not exit, so PM2 has nothing to restart; the restart budget
      // below is for a real crash, which then ends in a visible `errored`.
      name: 'balast-keeper',
      script: 'node_modules/.bin/tsx',
      args: 'server/keeper/main.ts',
      cwd: '/var/www/balast',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      restart_delay: 5_000,
      min_uptime: 10_000,
      max_restarts: 10,
      // SIGTERM lets it finish the transaction it is waiting on (up to the
      // two-minute receipt wait) rather than dying between send and record.
      kill_timeout: 130_000,
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/balast/keeper.error.log',
      out_file: '/var/log/balast/keeper.out.log',
      time: true,
    },
  ],
};
