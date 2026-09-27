/**
 * PM2 process definitions for the Hostinger VPS (§2).
 *
 * Three processes, because they fail independently and you want to know which
 * one did:
 *
 *   lockfi-web      the Next.js front end
 *   lockfi-api      Fastify: /api/snapshot and the websocket
 *   lockfi-indexer  the log poller
 *   lockfi-logos    token logos, one lookup at a time — its own process, so
 *                   a decoration never waits on the sync
 *   lockfi-keeper   routes the LockFi Routers when they are due (§48); it
 *                   waits quietly until the factory and its key are set
 *
 * The indexer is the one that matters most when it dies. §7 and the P3
 * criterion both name the same failure: a process that stops quietly while the
 * site keeps showing its last numbers as though they were live. It does not
 * exit on an RPC error — it backs off and retries — so PM2 restarting it is
 * the second line of defence, not the first. The lag figure in the top bar is
 * the first.
 *
 * Secrets are NOT here. `/var/www/balast/.env` holds DATABASE_URL and
 * USDG_ADDRESS, and nothing in this repository should ever contain either.
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
      name: 'lockfi-web',
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
        // P1: the front end reads the indexer through the API.
        DATA_SOURCE: 'live',
      },
      error_file: '/var/log/balast/web.error.log',
      out_file: '/var/log/balast/web.out.log',
      time: true,
    },
    {
      name: 'lockfi-api',
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
        // Start on the second free endpoint: the indexer's backfill starts
        // on the first and spends its per-IP allowance (endpoints.ts).
        RPC_START: 1,
      },
      error_file: '/var/log/balast/api.error.log',
      out_file: '/var/log/balast/api.out.log',
      time: true,
    },
    {
      name: 'lockfi-indexer',
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
      name: 'lockfi-logos',
      script: 'node_modules/.bin/tsx',
      args: 'server/logos/main.ts',
      cwd: '/var/www/balast',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      restart_delay: 5_000,
      min_uptime: 10_000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        // Its own endpoint, clear of the backfill and the API (endpoints.ts).
        RPC_START: 2,
      },
      error_file: '/var/log/balast/logos.error.log',
      out_file: '/var/log/balast/logos.out.log',
      time: true,
    },
    {
      name: 'lockfi-keeper',
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
      env: {
        NODE_ENV: 'production',
        // Its own endpoint, clear of the backfill, the API and the logos.
        RPC_START: 3,
      },
      error_file: '/var/log/balast/keeper.error.log',
      out_file: '/var/log/balast/keeper.out.log',
      time: true,
    },
  ],
};
