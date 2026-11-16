/**
 * The API (§2: Fastify).
 *
 *   GET  /api/health    — is the indexer alive, and how far behind is it
 *   GET  /api/snapshot  — the whole MarketSnapshot
 *   GET  /api/stream    — websocket, pushing the snapshot on real events
 *
 * §4.4: in production we push on actual events, debounced to about a second.
 * The indexer publishes a tick when a pass wrote something; this server
 * debounces those, rebuilds the snapshot once, and fans it out. That is the
 * real version of the prototype's 3.2s interval — a quiet chain pushes
 * nothing rather than pushing the same numbers every few seconds.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CHAIN, CONTRACTS } from '../../lib/chain';
import { deploymentFor, type Deployment } from '../../lib/contracts/deployments';
import type { MarketSnapshot } from '../../lib/data/types';
import { prisma } from '../db';
import { env } from '../env';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';
import { cachedUsdgResolver } from '../indexer/anchor';
import { busKind, subscribeTicks } from './bus';
import { buildSnapshot } from './snapshot';
import { lagLabel } from '../../lib/format';
import { keeperHealth, vaultWatchHealth } from '../keeper/health';
import { isWalletAddress, walletHistory } from './wallet-history';

const USDG = process.env.USDG_ADDRESS ?? '';

/**
 * What, if anything, makes this API unable to serve real numbers.
 *
 * The API used to THROW on a missing USDG_ADDRESS and refuse to start, which
 * is backwards: it is the one process that could say what is wrong, and
 * instead it crash-looped — 24 restarts, no explanation anywhere, and a
 * front end that could not even ask. A configuration error should be loudly
 * visible, not fatal.
 *
 * So it starts, answers, and reports this. `/api/health` returns it with a
 * 503 so a monitor still catches it, and `/api/snapshot` refuses with the
 * same reason, which the waiting page then shows the operator.
 */
function configurationProblem(): string | null {
  // An UNSET address is no longer a problem: the anchor is discovered from
  // the chain's own tokens. A malformed one still is — someone meant to pin a
  // specific token and mistyped it, and quietly discovering a different one
  // would be worse than saying so.
  if (USDG && !/^0x[0-9a-fA-F]{40}$/.test(USDG)) {
    return (
      `USDG_ADDRESS is set but is not an address: ${JSON.stringify(USDG)}. ` +
      'Fix or remove it — left unset, the anchor is discovered from the ' +
      'tokens the indexer finds.'
    );
  }
  return null;
}

/**
 * JSON cannot carry a bigint, and every amount that crosses this boundary has
 * already been converted to a number by the SQL. This is the guard for the
 * one that has not: it throws rather than silently emitting `null`.
 */
/** A snapshot older than this is rebuilt even if no tick said so. */
const SNAPSHOT_MAX_AGE_MS = 15_000;

function serialise(snapshot: MarketSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => {
    if (typeof value === 'bigint') {
      throw new Error('A bigint reached the API boundary; convert it in SQL.');
    }
    return value;
  });
}

export interface ServerOptions {
  /** What is deployed: config/deployments.json for this chain unless a test says otherwise. */
  deployment?: Deployment | null;
  /**
   * How long a discovered USD anchor is reused before it is looked for again
   * (indexer/anchor.ts cachedUsdgResolver). 0 — the default, and the tests' —
   * looks every time; the production entry point sets ten minutes.
   */
  anchorCacheMs?: number;
  /** How long /api/health reuses its pool and swap counts. 0 counts every time. */
  countsCacheMs?: number;
}

/** The client a request is from, for rate limiting (see the limiter below). */
export function clientKey(request: { headers: Record<string, string | string[] | undefined>; ip: string }): string {
  const real = request.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim() !== '') return real.trim();
  // Without X-Real-IP, the LAST forwarded entry is the one a proxy added.
  const forwarded = request.headers['x-forwarded-for'];
  const last = typeof forwarded === 'string' ? forwarded.split(',').pop()?.trim() : undefined;
  return last || request.ip;
}

/** A request from this machine that came through no proxy: the site's own server render. */
export function isLocalRender(request: { headers: Record<string, string | string[] | undefined>; ip: string }): boolean {
  const loopback = request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';
  return loopback && request.headers['x-real-ip'] === undefined && request.headers['x-forwarded-for'] === undefined;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const resolveAnchor = cachedUsdgResolver(options.anchorCacheMs ?? 0);
  let countsAt = 0;
  let countsMemo: { pools: number; swaps: number } | undefined;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const deployment = options.deployment !== undefined ? options.deployment : deploymentFor(CHAIN.id);

  await app.register(cors, {
    // The browser reaches the API through nginx on the same origin, so CORS
    // is only for local development against `next dev`.
    origin: process.env.CORS_ORIGIN ?? true,
  });

  /**
   * Rate limit, because `/api/snapshot` is the expensive query and this is a
   * public endpoint in front of one Postgres. Without it, one person with a
   * loop takes the site down for everyone.
   *
   * The allowance is deliberately generous: the front end polls every 20s as
   * a safety net behind the websocket, and a page open in a dozen tabs behind
   * one NAT must not get throttled. This is here to stop a loop, not to
   * ration users.
   *
   * Who a request is from: `X-Real-IP`, which nginx sets to the connecting
   * address and overwrites whatever a client sent. Not the FIRST entry of
   * `X-Forwarded-For`, which this used to read: nginx appends to that header
   * (`$proxy_add_x_forwarded_for`), so its first entry is whatever the client
   * chose, and a loop sending a fresh one per request was never limited —
   * against /api/health, which counts every pool and swap on each call.
   *
   * The site's own server renders (lib/data/initial-snapshot.ts) reach the
   * API directly on loopback with no proxy header. They are one process
   * rendering for every visitor, and sharing one visitor's budget sent the
   * site to a ten-minute-old remembered snapshot past 120 renders a minute;
   * they are not limited. Nothing outside the box can look like them: the API
   * binds 127.0.0.1 and nginx always sets X-Real-IP.
   */
  await app.register(rateLimit, {
    max: env.rateLimitMax,
    timeWindow: env.rateLimitWindowMs,
    // The websocket is one request that then stays open for hours. Counting
    // it against a per-minute budget would drop reconnects after a restart,
    // which is exactly when every client reconnects at once.
    // The stream, and logos: a board is dozens of badges in one page view,
    // each a small cached read, and must not spend the snapshot's budget.
    allowList: (request) =>
      request.url.startsWith('/api/stream') || request.url.startsWith('/api/logo/') || isLocalRender(request),
    keyGenerator: clientKey,
    // The object returned here is THROWN by the plugin, so it needs a
    // statusCode of its own — without one Fastify's error handler treats it
    // as an unhandled error and answers 500, which tells a client to retry
    // instead of to back off. Caught by the test below.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate-limited',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
    }),
  });

  await app.register(websocket);

  /**
   * The snapshot, served stale-while-revalidate.
   *
   * It used to be cached for one second and rebuilt on demand, with every
   * websocket forcing its own rebuild on every indexer tick. With a few
   * hundred pools a rebuild takes seconds, and during a first sync a tick
   * lands on nearly every pass — so the database rebuilt without pause, and
   * whoever asked for the page waited for it. The web server's render gave up
   * after 3s and every visitor opened on a loading card.
   *
   * Now: the last finished snapshot is answered at once, always. A tick marks
   * it stale; ONE rebuild runs, and its result is pushed to every socket.
   * Rebuilds are spaced by at least the debounce and at least as long as the
   * last one took, so a slow build cannot keep the database busy end to end.
   * Only the very first request after start waits, and start warms it.
   */
  let cached: { snapshot: MarketSnapshot | null; at: number } | null = null;
  let building: Promise<MarketSnapshot | null> | null = null;
  let stale = true;
  let lastBuildMs = 0;
  let nextBuildAt = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(value: MarketSnapshot) => void>();

  function build(): Promise<MarketSnapshot | null> {
    if (building) return building;
    stale = false;
    const started = Date.now();
    building = buildSnapshot({ usdgAddress: USDG || null, resolveAnchor })
      .then((value) => {
        cached = { snapshot: value, at: Date.now() };
        if (value) listeners.forEach((push) => push(value));
        return value;
      })
      .catch((error) => {
        app.log.error(`snapshot build failed: ${(error as Error).message}`);
        stale = true;
        return cached?.snapshot ?? null;
      })
      .finally(() => {
        lastBuildMs = Date.now() - started;
        nextBuildAt = Date.now() + Math.max(env.streamDebounceMs, lastBuildMs);
        building = null;
        // A tick that arrived mid-build is not lost: it left us stale.
        if (stale) scheduleRebuild();
      });
    return building;
  }

  function scheduleRebuild(): void {
    if (rebuildTimer || building) return;
    const wait = Math.max(0, nextBuildAt - Date.now());
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void build();
    }, wait);
  }

  async function snapshot(): Promise<MarketSnapshot | null> {
    if (cached?.snapshot) {
      // No tick for a while still means a refresh: ticks can be lost (a
      // Redis blip, a second API instance), and the lag figure is computed
      // when the snapshot is built, so it must not freeze.
      if (Date.now() - cached.at > SNAPSHOT_MAX_AGE_MS) stale = true;
      if (stale) scheduleRebuild();
      return cached.snapshot;
    }
    // Nothing yet, or nothing indexed when last asked: ask again. Cheap while
    // the database is empty, and the honest answer the moment it is not.
    return build();
  }

  // One subscription for the whole process, not one per socket.
  const unsubscribeTicks = subscribeTicks(() => {
    stale = true;
    scheduleRebuild();
  });
  app.addHook('onClose', async () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    (await unsubscribeTicks)();
  });
  // Warm it, so the first visitor after a restart does not pay for the build.
  if (!configurationProblem()) void build();

  /**
   * Health, and the one thing an uptime monitor can act on.
   *
   * A 200 here used to mean only "the API answered", which is useless as an
   * alert: the indexer can be dead for a day while this endpoint cheerfully
   * returns ok. §8's P3 criterion names that exact failure — a process that
   * dies quietly while the site shows its last numbers as though they were
   * live — and it applies to the indexer now, a phase early.
   *
   * So a stalled or never-started indexer returns **503**. Any uptime check
   * that watches a status code catches it with no extra plumbing, and the
   * body says which of the two it is.
   */
  /**
   * The indexed block, and when this process last saw it change.
   *
   * "Behind" and "stalled" are different things, and the first sync made the
   * difference matter: an indexer reading months-old blocks as fast as the RPC
   * allows is months behind and working perfectly. It was reported "stalled",
   * in red, on the page every visitor saw first. Stalled now means NOT MOVING
   * — no progress written for the threshold, or a block number that has not
   * changed in it while behind (an RPC stuck on an old head looks like that).
   */
  let progress: { block: bigint; seenAt: number } | null = null;

  app.get('/api/health', async (_request, reply) => {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { contract: POOL_MANAGER_CURSOR },
    });
    const now = Date.now();
    const lagSeconds = cursor
      ? Math.max(0, (now - cursor.lastIndexedAt.getTime()) / 1000)
      : null;
    if (cursor && (!progress || progress.block !== cursor.lastIndexedBlock)) {
      progress = { block: cursor.lastIndexedBlock, seenAt: now };
    }
    const writtenAgo = cursor ? (now - cursor.updatedAt.getTime()) / 1000 : null;
    const movedAgo = progress ? (now - progress.seenAt) / 1000 : 0;
    const behind = lagSeconds !== null && lagSeconds > env.stallSeconds;
    const stuck =
      writtenAgo !== null &&
      (writtenAgo > env.stallSeconds || (behind && movedAgo > env.stallSeconds));
    const fresh = (options.countsCacheMs ?? 0) > 0 && countsMemo && Date.now() - countsAt < (options.countsCacheMs ?? 0);
    const [counts] = fresh ? [countsMemo] : await prisma.$queryRaw<{ pools: number; swaps: number }[]>`
      SELECT (SELECT COUNT(*) FROM pools)::int AS pools,
             (SELECT COUNT(*) FROM swap_events)::int AS swaps
    `;
    if (!fresh && counts) {
      countsMemo = counts;
      countsAt = Date.now();
    }
    // Which token is pricing the whole site, and how that was decided. This
    // is the single most consequential value in the system — a wrong anchor
    // makes every dollar figure wrong — so it is auditable from outside.
    const anchor = await resolveAnchor(USDG || null);
    // The keeper (P3/P4): read from what the chain recorded — each router's
    // last Observed event — not from the keeper process, which can be
    // "online" and landing nothing. Vaults need no keeper and are not checked.
    const keeper = await keeperHealth({ deployment });
    // Each vault's pool, read live by the vault watcher: how old that read is.
    const vaultWatch = await vaultWatchHealth();

    // Misconfiguration outranks everything: a never-indexed chain is the
    // SYMPTOM when the indexer cannot start, and reporting the symptom sends
    // whoever is looking to the wrong place.
    //
    // A router left unobserved by the keeper ranks below a stalled indexer —
    // when the indexer has stopped, every figure including a router's last
    // observation is stale, and the indexer is what to fix first — and above
    // catching-up, which is the system working while the keeper is not.
    const problem = configurationProblem();
    const status = problem
      ? 'misconfigured'
      : cursor === null
        ? 'never-indexed'
        : !anchor.address
          ? 'no-anchor'
          : stuck
            ? 'stalled'
            : keeper.status === 'overdue'
              ? 'keeper-overdue'
              : behind
                ? 'catching-up'
                : 'ok';
    // Catching up is the system working as designed — an uptime check must
    // not page anyone for a first sync — so it answers 200 like ok. Every
    // state where something is wrong, or nothing is known yet, answers 503.
    //
    // keeper-overdue is a 503 for the same reason stalled is: a process has
    // died quietly while the site looks fine — here, a router whose keeper
    // stopped poking it, so its TWAP has lapsed and a token team's fees sit
    // unrouted — and only a person can fix it. It fires after an hour without
    // an observation (twice the TWAP window; pokes are every four minutes), so
    // a single failed poke the keeper retries on its own never pages anyone.
    // Vaults cannot cause it: they need no keeper. Nothing to keep is
    // "not-needed" inside the keeper section and changes nothing here.

    const body = {
      // Kept for anything already reading it, but `status` is the field to
      // watch: "ok" here has never meant the numbers are current.
      ok: status === 'ok',
      status,
      stallThresholdSeconds: env.stallSeconds,
      indexed: cursor
        ? { lastBlock: cursor.lastIndexedBlock.toString(), at: cursor.lastIndexedAt, lagSeconds }
        : null,
      pools: counts?.pools ?? 0,
      swaps: counts?.swaps ?? 0,
      bus: busKind(),
      weth: CONTRACTS.weth,
      usdg: anchor.address,
      usdgSource: anchor.source,
      usdgNote: anchor.note,
      message:
        status === 'misconfigured'
          ? problem!
          : status === 'never-indexed'
            ? 'The indexer has never written a block. Check `pm2 logs balast-indexer`.'
            : status === 'no-anchor'
              ? anchor.note
              : status === 'stalled'
                ? `The indexer has stopped advancing and is ${lagLabel(lagSeconds ?? 0)} behind ` +
                  'the chain. The site is showing numbers that old.'
                : status === 'keeper-overdue'
                  ? keeper.message
                  : status === 'catching-up'
                    ? `The indexer is catching up: ${lagLabel(lagSeconds ?? 0)} behind the chain ` +
                      'and advancing. Figures on the site are as of the last block indexed.'
                    : undefined,
      // Last, after the top-level status: per router, the last route and
      // observation, and the last attempt's reason; vaults are counted and
      // said to need no keeper.
      keeper,
      vaultWatch,
    };

    return reply.code(status === 'ok' || status === 'catching-up' ? 200 : 503).send(body);
  });

  app.get('/api/snapshot', async (_request, reply) => {
    const problem = configurationProblem();
    if (problem) {
      // Not "no data yet": a reason. The waiting page shows this verbatim, so
      // whoever opens the site sees what to fix instead of a blank panel.
      return reply.code(503).send({ error: 'misconfigured', message: problem });
    }
    const value = await snapshot();
    if (!value) {
      // Nothing indexed yet. 503 rather than an empty snapshot: the client
      // must show "waiting for the indexer", not zeros that look like data.
      return reply.code(503).send({
        error: 'no-data',
        message: 'The indexer has not written a block yet.',
      });
    }
    return reply.type('application/json').send(serialise(value));
  });

  /**
   * One wallet's deposits, withdrawals and claims in Tidewell's vaults, from
   * the vaults' own events (wallet-history.ts) — what the portfolio needs to
   * show fees earned and price impact. Per wallet, so never in the snapshot,
   * and never cached for another visitor.
   */
  app.get<{ Params: { address: string } }>('/api/wallet/:address', async (request, reply) => {
    const { address } = request.params;
    if (!isWalletAddress(address)) return reply.code(400).send({ error: 'not-an-address' });
    const history = await walletHistory(address, deployment?.vaults ?? []);
    return reply.header('cache-control', 'private, no-store').send(history);
  });

  /**
   * A logo we stored (server/indexer/launchpad-logos.ts): launchpad images
   * fetched once from IPFS and shrunk to a badge, served from our origin so
   * no visitor is sent to a rate-limited gateway or a stranger's host.
   *
   * Only ever an image: the bytes were checked and re-encoded as WebP when
   * stored, and the headers forbid sniffing and anything active, so the URL
   * opened on its own cannot do more than show a picture.
   */
  app.get<{ Params: { address: string } }>('/api/logo/:address', async (request, reply) => {
    const address = request.params.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return reply.code(404).send();
    const logo = await prisma.tokenLogo.findUnique({ where: { address } });
    if (!logo) return reply.code(404).send();
    return reply
      .header('content-type', logo.contentType)
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(Buffer.from(logo.bytes));
  });

  app.get('/api/stream', { websocket: true }, (connection) => {
    let closed = false;
    const push = (value: MarketSnapshot) => {
      if (closed) return;
      try {
        connection.send(serialise(value));
      } catch {
        /* the socket went away between the build and the send */
      }
    };

    // What we have now, then every rebuild as it finishes. §4.4's debounce
    // lives in the rebuild spacing, so a burst of blocks is one push.
    void snapshot().then((value) => value && push(value));
    listeners.add(push);

    connection.on('close', () => {
      closed = true;
      listeners.delete(push);
    });
    connection.on('error', () => {
      closed = true;
      listeners.delete(push);
    });
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  // Discovery and the health counts are full scans of tables the indexer is
  // writing millions of rows into; reused for minutes, not run per request.
  const app = await buildServer({ anchorCacheMs: 10 * 60_000, countsCacheMs: 60_000 });
  await app.listen({ port: env.apiPort, host: env.apiHost });

  // Loud, and still serving. The old behaviour was to throw here, which took
  // the process down and left nothing able to report the cause.
  const problem = configurationProblem();
  if (problem) app.log.error(`NOT SERVING REAL DATA: ${problem}`);

  if (busKind() === 'in-process') {
    app.log.warn(
      'No REDIS_URL: the tick bus is in-process. Fine for one API instance; ' +
        'a second one would not see the indexer\'s ticks and would only ever ' +
        'push on its own poll.',
    );
  }
  return app;
}
