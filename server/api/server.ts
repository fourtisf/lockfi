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
import { CONTRACTS } from '../../lib/chain';
import type { MarketSnapshot } from '../../lib/data/types';
import { prisma } from '../db';
import { env } from '../env';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';
import { USER_AGENT } from '../indexer/logo-sources';
import { resolveUsdg } from '../indexer/anchor';
import { readWork } from '../indexer/working';
import { busKind, subscribeTicks } from './bus';
import { MarketFeed } from './market';
import { chainPortfolioReader, chainScannerSource } from './chain-portfolio';
import { buildPortfolio, type ChainPortfolioReader } from './portfolio';
import { V4TokenScanner } from './v4-scanner';
import { ExplorerPositions, type ExplorerFetch } from './explorer-positions';
import { rpc } from '../chain/client';
import {
  RouterTokens,
  dexscreenerV4PoolIds,
  explorerCreationTx,
  explorerInitializeTx,
  explorerWalletTokens,
  type ChainRead,
} from './router-tokens';
import { LiveReserves, type ReservesReader } from './live-reserves';
import { recentHead } from './recent';
import { AskError, DailyCounter, answer, parseAskBody, providerName, type AskConfig, type AskFetch } from './ask';
import { buildSnapshot, nextRevision } from './snapshot';
import { type HistoryStore, type SerializedHistory } from './v3-history';
import { agedSnapshot, isServable, loadPersistedSnapshot, persistSnapshot } from './snapshot-store';

const USDG = process.env.USDG_ADDRESS ?? '';



/**
 * Blocks behind head past which the indexer is BACKFILLING rather than
 * following. At ~100ms blocks a lag of a few thousand is seconds of chain, so
 * the threshold is high enough not to call a brief catch-up a first sync.
 */
const SYNCING_BLOCKS = 50_000n;
/** How long the swap count on /api/health is kept before it is counted again. */
const COUNTS_TTL_MS = 30_000;

/**
 * The sentence that tells an operator which of two situations they are in.
 *
 * "No USD anchor yet" is the same message whether the indexer is at block
 * 400k of 62m — where the only correct action is to wait — or has caught up
 * and genuinely found no ETH/USDG pool, where waiting is the one thing that
 * will not help. The page showed the first sentence and not this one, so the
 * dead end was indistinguishable from progress.
 */
/** `4h 12m`, `37m`, `50s` — a duration a person reads at a glance. */
function humanSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function syncingNote(args: {
  syncing: boolean;
  progress: number | null;
  behind: bigint | null;
  pools: number;
}): string {
  const { syncing, progress, behind, pools } = args;
  const found = `${pools.toLocaleString()} pool(s) discovered so far.`;
  if (behind === null) {
    return `${found} The indexer has not reported the chain head yet.`;
  }
  if (syncing) {
    const pct = progress === null ? '' : ` (${progress.toFixed(2)}% of the chain)`;
    return (
      `The first sync is still running${pct}: ${behind.toLocaleString()} blocks behind head, ` +
      `${found} It may simply not have reached the pool yet.`
    );
  }
  return (
    `The indexer is caught up (${behind.toLocaleString()} blocks behind head) and ${found} ` +
    'Being caught up means waiting will not fix this: check that POOL_MANAGER and WETH in ' +
    'lib/chain.ts are the addresses this chain actually uses, or set USDG_ADDRESS.'
  );
}

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
/**
 * The head reader's state (§25): how many swaps it holds and how old the
 * newest is. A board reading `chain` on every row is answered here — either
 * the reader has written nothing, or its newest block is stale, and those
 * need different things done about them.
 */
async function headStatus(): Promise<{ swaps: number; at: string | null; seconds: number | null }> {
  const [count, newest] = await Promise.all([
    prisma.recentSwap.count(),
    recentHead(),
  ]);
  return {
    swaps: count,
    at: newest === null ? null : newest.toISOString(),
    seconds: newest === null ? null : Math.max(0, Math.round((Date.now() - newest.getTime()) / 1000)),
  };
}

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
function serialise(snapshot: MarketSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => {
    if (typeof value === 'bigint') {
      throw new Error('A bigint reached the API boundary; convert it in SQL.');
    }
    return value;
  });
}

/** The subset of `fetch` the logo route uses, so a test can hand in a fake. */
/** The market sources' fetch, so a test can answer them without a network. */
export type MarketFetch = import('../indexer/logo-sources').Fetch;

export type LogoFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A logo the API is holding, or the memory that there is none to hold. */
type CachedLogo = { at: number; type: string; body: Buffer } | { at: number; miss: true };
const LOGO_TTL_MS = 24 * 60 * 60 * 1000;
const LOGO_MISS_TTL_MS = 10 * 60 * 1000;
const LOGO_CACHE_MAX = 2_000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How long to wait before trying the first snapshot again.
 *
 * Only used before the first one succeeds — long enough not to hammer a
 * database that is busy with the indexer's own rebuild, short enough that a
 * box left alone starts quoting within a minute of becoming able to.
 */
const WARM_UP_RETRY_MS = 15_000;

/** Kept v3 position histories, in `indexer_state` beside the kept snapshot. */
const V3_HISTORY_KEY = 'v3_position_histories';
function v3HistoryStore(): HistoryStore {
  return {
    async load() {
      const row = await prisma.indexerState.findUnique({ where: { key: V3_HISTORY_KEY } });
      if (!row) return {};
      const parsed = JSON.parse(row.value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, SerializedHistory>) : {};
    },
    async save(all) {
      const value = JSON.stringify(all);
      await prisma.indexerState.upsert({
        where: { key: V3_HISTORY_KEY },
        create: { key: V3_HISTORY_KEY, value, updatedAt: new Date() },
        update: { value, updatedAt: new Date() },
      });
    },
  };
}

export async function buildServer(
  options: {
    logoFetch?: LogoFetch;
    /** A fake for the market sources, so a test never reaches a real aggregator. */
    marketFetch?: MarketFetch;
    /**
     * What the portfolio reads from the chain: which positions a wallet
     * holds, and where their pools' prices are now. Defaults to the node
     * unless `PORTFOLIO_CHAIN=false`; null turns it off, which is what a test
     * that must not reach a node passes.
     */
    portfolioChain?: ChainPortfolioReader | null;
    /** Finds v4 positions minted after the indexer's last one. Defaults with `portfolioChain`. */
    v4Scanner?: V4TokenScanner | null;
    /**
     * Asks the explorer which v4 position NFTs a wallet holds — candidates the
     * chain then confirms. Defaults with `portfolioChain` unless
     * `PORTFOLIO_EXPLORER=false`; a test passes a fake fetch or null.
     */
    explorerFetch?: ExplorerFetch | null;
    /**
     * Reads listed v3 pools' balances for a current fee yield. Defaults to
     * the chain unless `LIVE_RESERVES=false`; null turns it off (tests).
     */
    reservesReader?: ReservesReader | null;
    /** The assistant's settings and transport; a test passes a fake fetch. Defaults to `env.ai` and `fetch`. */
    ask?: { config?: AskConfig; fetch?: AskFetch };
    /** The router page's token lookups (§49); a test passes its own, or null to turn them off. */
    routerTokens?: RouterTokens | null;
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const chainOff = process.env.PORTFOLIO_CHAIN === 'false' || process.env.PORTFOLIO_V3 === 'false';
  const portfolioChain =
    options.portfolioChain !== undefined
      ? options.portfolioChain
      : chainOff
        ? null
        : chainPortfolioReader({
            // A v3 position's history is located through the explorer and read from receipts (v3-history.ts).
            explorerBase: process.env.PORTFOLIO_EXPLORER === 'false' ? null : env.explorerApiUrl,
            // A history that checked out once is kept across restarts, so a
            // deploy does not put the dash back while the explorer is asked again.
            historyStore: v3HistoryStore(),
          });
  const v4Scanner =
    options.v4Scanner !== undefined
      ? options.v4Scanner
      : portfolioChain && !chainOff
        ? new V4TokenScanner(chainScannerSource(), { log: (line) => app.log.warn(line) })
        : null;
  v4Scanner?.start();
  app.addHook('onClose', async () => v4Scanner?.stop());
  const explorerPositions =
    portfolioChain && options.explorerFetch !== null && process.env.PORTFOLIO_EXPLORER !== 'false'
      ? new ExplorerPositions({ base: env.explorerApiUrl, fetch: options.explorerFetch ?? undefined })
      : null;
  const startedAt = Date.now();
  const askConfig: AskConfig = options.ask?.config ?? env.ai;
  const askFetch: AskFetch = options.ask?.fetch ?? ((url, init) => fetch(url, init));
  const askCounter = new DailyCounter(askConfig.dailyLimit);
  const routerTokens =
    options.routerTokens !== undefined
      ? options.routerTokens
      : new RouterTokens({
          read: ((fn) => rpc(fn as never, 'router lookup')) as ChainRead,
          creationTx: explorerCreationTx(env.explorerApiUrl),
          walletTokens: explorerWalletTokens(env.explorerApiUrl),
          v4PoolIds: dexscreenerV4PoolIds(env.dexscreenerUrl, env.dexscreenerChain),
          initializeTx: explorerInitializeTx(env.explorerApiUrl),
          knownPools: async () => {
            const s = await snapshot().catch(() => null);
            return s ? [...s.pools, ...(s.otherPools ?? [])] : [];
          },
          log: (line) => app.log.warn(line),
        });
  const reserves =
    options.reservesReader === null || (options.reservesReader === undefined && process.env.LIVE_RESERVES === 'false')
      ? null
      : new LiveReserves({
          read: options.reservesReader ?? undefined,
          log: (line) => app.log.warn(line),
          // Rebuilt on the same floor as a market refresh, so the fee yield
          // uses a reading within seconds of it landing.
          onUpdate: () => publishMarket(),
        });
  reserves?.start();
  app.addHook('onClose', async () => reserves?.stop());

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
   * The client's address is what nginx says it is, not what the client
   * says. nginx sets `X-Real-IP` to the peer it accepted and APPENDS that
   * peer to `X-Forwarded-For` (`$proxy_add_x_forwarded_for`), so the header
   * a client sends arrives with nginx's word LAST. The key used to be the
   * FIRST entry — the client's own — so one loop with a made-up header per
   * request got a fresh budget every time, and the limit stopped nothing.
   * Nothing but nginx can reach the port (the API binds 127.0.0.1), which is
   * why the last hop can be trusted and the first never could.
   */
  await app.register(rateLimit, {
    max: env.rateLimitMax,
    timeWindow: env.rateLimitWindowMs,
    // The websocket is one request that then stays open for hours. Counting
    // it against a per-minute budget would drop reconnects after a restart,
    // which is exactly when every client reconnects at once.
    // The logo route is one request per badge on the board, served from
    // memory after the first: a hundred of them on one page load is normal,
    // not a loop.
    allowList: (request) =>
      request.url.startsWith('/api/stream') || request.url.startsWith('/api/logo/'),
    keyGenerator: (request) => {
      const real = request.headers['x-real-ip'];
      if (typeof real === 'string' && real.trim() !== '') return real.trim();
      const forwarded = request.headers['x-forwarded-for'];
      const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
      const hops = chain
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean);
      return hops.length > 0 ? hops[hops.length - 1] : request.ip;
    },
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
   * The snapshot is cached for as long as a tick has not arrived. Every
   * connected client on a quiet chain then costs one query, not one per
   * client per poll.
   */
  let cached: { snapshot: MarketSnapshot | null; at: number } | null = null;
  let building: Promise<MarketSnapshot | null> | null = null;
  /**
   * The last snapshot the previous process built, served from the first
   * request while this one's first build runs (snapshot-store.ts). Aged, so
   * the lag in the top bar says how old it is; its revision is below the
   * first build's, so the page takes the build the moment it lands. `at: 0`
   * makes that first request also start the rebuild.
   */
  const kept = await loadPersistedSnapshot();
  if (kept) {
    cached = { snapshot: agedSnapshot(kept, nextRevision()), at: 0 };
    app.log.info(`  snapshot: serving the one kept from ${kept.builtAt} until the first build here succeeds`);
  }

  /**
   * Live market figures (market.ts): DexScreener, then GeckoTerminal for what
   * it does not list. A refresh that changed a quote rebuilds the snapshot
   * and wakes every socket, so the row moves on the aggregator's cadence even
   * while the indexer is in a long stage and publishes no tick.
   */
  const marketListeners = new Set<() => void>();
  /**
   * Coalesce the feed's updates onto the rebuild floor.
   *
   * The feed publishes as each batch of quotes lands rather than when the
   * whole cycle ends, so the board fills in after a restart instead of
   * reading `chain` for a minute. `rebuild()` only de-duplicates calls that
   * overlap, so a dozen batches would have run the expensive query a dozen
   * times back to back. This runs it at most once per SNAPSHOT_MIN_REBUILD_MS
   * and always runs a last one, so nothing published is left unseen.
   */
  let marketPublish: ReturnType<typeof setTimeout> | null = null;
  const publishMarket = (): void => {
    if (marketPublish) return;
    const since = cached ? Date.now() - cached.at : Infinity;
    marketPublish = setTimeout(
      () => {
        marketPublish = null;
        void rebuild()
          .then(() => {
            for (const wake of marketListeners) wake();
          })
          .catch((error) => app.log.warn({ err: error }, 'snapshot rebuild after a market refresh failed'));
      },
      Math.max(0, env.snapshotMinRebuildMs - since),
    );
    marketPublish.unref?.();
  };
  /**
   * Build one snapshot on start, and keep trying until one succeeds.
   *
   * Everything downstream of the board is demand-started. `follow()` — the
   * only way the market feed learns which tokens the board shows — runs
   * inside a SUCCESSFUL buildSnapshot, and a snapshot is built only when a
   * page asks for one or the indexer publishes a tick. During a long indexer
   * stage (a full rebuild, the v3 factory's history) there are no ticks, so
   * on a box nobody happens to be looking at, the feed never starts at all:
   * `followed: 0`, `lastRefreshAt: null`, no error anywhere, and every row
   * reading `chain` for whoever loads the page next.
   *
   * One success bootstraps the rest — the feed then has its list and its own
   * timer, and its updates keep the snapshot rebuilding — so this stops
   * rather than polling an idle box for ever (§19: the expensive query must
   * not run continuously).
   */
  let warmUp: ReturnType<typeof setTimeout> | null = null;
  const warm = (): void => {
    const again = (): void => {
      warmUp = setTimeout(warm, WARM_UP_RETRY_MS);
      warmUp.unref?.();
    };
    void rebuild()
      .then((built) => {
        if (built) app.log.info('  snapshot: first build done; the market feed has the board');
        else again();
      })
      .catch((error) => {
        app.log.warn({ err: error }, 'first snapshot build failed');
        again();
      });
  };

  const market = new MarketFeed({
    fetch: options.marketFetch,
    base: env.dexscreenerUrl,
    chain: env.dexscreenerChain,
    geckoBase: env.geckoterminalUrl,
    geckoNetwork: env.geckoterminalNetwork,
    refreshMs: env.dexscreenerRefreshMs,
    enabled: env.dexscreenerMarket,
    log: (line) => app.log.info(line.trim()),
    onUpdate: publishMarket,
  });
  market.start();
  warm();
  app.addHook('onClose', async () => {
    market.stop();
    if (marketPublish) clearTimeout(marketPublish);
    if (warmUp) clearTimeout(warmUp);
  });

  /** One query at a time, whoever asks. */
  function rebuild(): Promise<MarketSnapshot | null> {
    if (!building) {
      building = buildSnapshot({ usdgAddress: USDG || null, market, reserves })
        .then((value) => {
          if (value) {
            cached = { snapshot: value, at: Date.now() };
            void persistSnapshot(value).catch((error) => app.log.warn({ err: error }, 'could not keep the snapshot'));
          } else if (cached?.snapshot && isServable(cached.snapshot)) {
            // Nothing could be built — the cursor or the anchor is missing,
            // which after a deploy is usually the indexer mid-repair. The
            // last good board stays up, aged, rather than the page going
            // blank over tables that had one a minute ago; past a day it is
            // let go and the loading panel is the honest state again.
            cached = { snapshot: agedSnapshot(cached.snapshot, cached.snapshot.revision), at: Date.now() };
          } else {
            cached = { snapshot: null, at: Date.now() };
          }
          return cached.snapshot;
        })
        .finally(() => {
          building = null;
        });
    }
    return building;
  }

  /**
   * The snapshot, served stale and refreshed behind the request.
   *
   * It used to be rebuilt for any request older than the stream debounce —
   * one second — and every websocket client forced its own rebuild on every
   * indexer tick, which during a first sync is every second. The expensive
   * query ran continuously, page loads queued behind it, and "loading the
   * snapshot" sat on screen on every refresh.
   *
   * Now the last built snapshot is answered immediately, and a rebuild is
   * started in the background at most once per SNAPSHOT_MIN_REBUILD_MS. The
   * first request after a start is the only one that waits. A few seconds
   * of staleness is invisible next to the lag figure the top bar already
   * shows (§7), and the snapshot carries its own as-of time.
   */
  function snapshot(): Promise<MarketSnapshot | null> {
    // A cached NOTHING is not worth serving. Stale-while-revalidate is a
    // trade of freshness for latency, and there is no freshness to trade when
    // the last build came back empty — while the cheap thing to do is exactly
    // the thing that would fix it, since buildSnapshot returns null at the
    // cursor and anchor checks, before any of the expensive queries.
    //
    // It also decouples the start-up warm-up from this cache: the warm-up
    // caches a null the moment the process starts, and without this every
    // request for the next SNAPSHOT_MIN_REBUILD_MS answered 503 from it, over
    // a database that by then had data.
    if (!cached || !cached.snapshot) return rebuild();
    if (Date.now() - cached.at >= env.snapshotMinRebuildMs) {
      void rebuild().catch((error) => app.log.warn({ err: error }, 'snapshot rebuild failed'));
    }
    return Promise.resolve(cached.snapshot);
  }

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
  // How many pools and swaps the tables hold, for the health body. The
  // pools count is a small table and is exact on every call; a COUNT(*)
  // over swap_events is a sequential scan of millions of rows, and the
  // waiting page polls this route (§22), so that one is kept for half a
  // minute. The figures are context, not a signal anything acts on.
  let swapsCache: { at: number; value: number } | null = null;
  const tableCounts = async (): Promise<{ pools: number; swaps: number }> => {
    const [{ pools }] = await prisma.$queryRaw<{ pools: number }[]>`SELECT COUNT(*)::int AS pools FROM pools`;
    if (!swapsCache || Date.now() - swapsCache.at >= COUNTS_TTL_MS) {
      const [{ swaps }] = await prisma.$queryRaw<{ swaps: number }[]>`SELECT COUNT(*)::int AS swaps FROM swap_events`;
      swapsCache = { at: Date.now(), value: swaps };
    }
    return { pools, swaps: swapsCache.value };
  };

  app.get('/api/health', async (_request, reply) => {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { contract: POOL_MANAGER_CURSOR },
    });
    // The poller's last pass — blocks, events, and seconds per stage — so a
    // slow backfill can be read from outside the box, not only from its log.
    const lastPassRow = await prisma.indexerState.findUnique({ where: { key: 'last_pass' } });
    let lastPass: unknown = null;
    try {
      lastPass = lastPassRow ? JSON.parse(lastPassRow.value) : null;
    } catch {
      lastPass = null;
    }
    // Two different clocks, and they answer two different questions.
    //
    // `lagSeconds` is CHAIN time: how old the newest indexed block is. It is
    // what the top bar shows (§7) and during a first sync it is enormous by
    // definition — seventy days, on this chain — while nothing is wrong.
    //
    // `idleSeconds` is WALL time since the poller last wrote the cursor. That
    // is liveness: a poller that has not written in five minutes is dead or
    // stuck, whatever the chain lag says. "Stalled" used to be judged on the
    // first clock, so a healthy backfill read as a stall for two days and the
    // monitor would have alerted the whole way.
    const lagSeconds = cursor
      ? Math.max(0, (Date.now() - cursor.lastIndexedAt.getTime()) / 1000)
      : null;
    const idleSeconds = cursor
      ? Math.max(0, (Date.now() - cursor.updatedAt.getTime()) / 1000)
      : null;
    // A third clock, for the stages that write no block at all: the full
    // rebuild of every priced table and the factory's history, hours each
    // on the real tables. Both heartbeat while they run (indexer/working.ts).
    // A fresh heartbeat is an indexer that is alive and busy, and says on
    // what and for how long; a stale one is ignored, so a process killed
    // mid-stage reads as stalled once the threshold passes, as before.
    const work = await readWork();
    const heartbeatSeconds = work ? (Date.now() - Date.parse(work.heartbeatAt)) / 1000 : null;
    const working =
      work !== null &&
      heartbeatSeconds !== null &&
      Number.isFinite(heartbeatSeconds) &&
      heartbeatSeconds <= env.stallSeconds;
    const workSeconds = work ? Math.max(0, (Date.now() - Date.parse(work.startedAt)) / 1000) : null;
    const counts = await tableCounts();
    // Which token is pricing the whole site, and how that was decided. This
    // is the single most consequential value in the system — a wrong anchor
    // makes every dollar figure wrong — so it is auditable from outside.
    const anchor = await resolveUsdg(USDG || null);

    // How far through the chain the indexer is.
    //
    // Without this the waiting page could say only "no anchor yet", which is
    // true in two situations that need opposite responses: a first sync still
    // grinding through empty blocks (wait), and a finished sync that found no
    // ETH/USDG pool (look at the addresses). The head is recorded by the
    // poller each pass, so answering costs no RPC call.
    const head = cursor?.headBlock ?? null;
    const behind = head !== null && cursor ? head - cursor.lastIndexedBlock : null;
    const syncing = behind !== null && behind > SYNCING_BLOCKS;
    const progress =
      head !== null && head > 0n && cursor
        ? Math.min(100, Number((cursor.lastIndexedBlock * 10000n) / head) / 100)
        : null;

    // Misconfiguration outranks everything: a never-indexed chain is the
    // SYMPTOM when the indexer cannot start, and reporting the symptom sends
    // whoever is looking to the wrong place.
    const problem = configurationProblem();
    const stalled = idleSeconds !== null && idleSeconds > env.stallSeconds && !working;
    const status = problem
      ? 'misconfigured'
      : working
        ? 'working'
        : cursor === null
          ? 'never-indexed'
          : stalled
            ? 'stalled'
            : !anchor.address
              ? 'no-anchor'
              : syncing
                ? 'syncing'
                : lagSeconds !== null && lagSeconds > env.stallSeconds
                  ? 'behind'
                  : 'ok';
    // 503 is for states a person has to act on. A first sync and a catch-up
    // are the indexer doing its job with the lag on screen; a monitor that
    // pages for forty hours of expected work is a monitor that gets muted.
    const needsSomeone =
      status === 'misconfigured' ||
      status === 'never-indexed' ||
      status === 'stalled' ||
      status === 'no-anchor';

    const body = {
      // Kept for anything already reading it, but `status` is the field to
      // watch: "ok" here has never meant the numbers are current.
      ok: status === 'ok',
      status,
      stallThresholdSeconds: env.stallSeconds,
      indexed: cursor
        ? {
            lastBlock: cursor.lastIndexedBlock.toString(),
            at: cursor.lastIndexedAt,
            lagSeconds,
            /** Wall seconds since the poller last wrote. Liveness, not lag. */
            idleSeconds,
            headBlock: head === null ? null : head.toString(),
            blocksBehind: behind === null ? null : behind.toString(),
            progressPct: progress,
            syncing,
            lastPass,
          }
        : null,
      /**
       * The chain's head, read beside the backfill (§25). `at` is the newest
       * swap it has; `seconds` how old that is in wall time. This is what
       * makes the board's volume current while `indexed` above is weeks
       * behind, so a board reading `chain` everywhere is answered here.
       */
      head: await headStatus(),
      /** The stage in progress that writes no block, with its heartbeat; null between stages. */
      working:
        work && working
          ? {
              stage: work.stage,
              detail: work.detail ?? null,
              startedAt: work.startedAt,
              seconds: workSeconds,
              heartbeatSeconds,
            }
          : null,
      pools: counts?.pools ?? 0,
      swaps: counts?.swaps ?? 0,
      bus: busKind(),
      /** The DexScreener feed: how many of the board's tokens it quotes, and what it last said. */
      market: market.status(),
      // The scan for v4 positions minted since the indexer's last one: a
      // portfolio's completeness depends on it, so it is visible from outside.
      portfolioScan: v4Scanner ? v4Scanner.status() : null,
      portfolioExplorer: explorerPositions ? explorerPositions.status() : null,
      // The listed v3 pools' balances, read for a fee yield whose liquidity is
      // as current as its fees.
      poolReserves: reserves ? reserves.status() : null,
      ai: {
        enabled: askConfig.apiKey !== '',
        provider: providerName(askConfig.baseUrl),
        model: askConfig.model,
        answersToday: askCounter.used,
        dailyLimit: askConfig.dailyLimit,
      },
      // How long this process has been up, and when it last built the board:
      // right after a deploy "no snapshot yet" is the first build running,
      // not a fault, and the doctor says which.
      api: {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        snapshotBuiltAt: cached?.snapshot ? new Date(cached.at).toISOString() : null,
      },
      weth: CONTRACTS.weth,
      usdg: anchor.address,
      usdgSource: anchor.source,
      usdgNote: anchor.note,
      message:
        status === 'misconfigured'
          ? problem!
          : status === 'never-indexed'
            ? 'The indexer has never written a block. Check `pm2 logs lockfi-indexer`.'
            : status === 'no-anchor'
              ? // The anchor's own reason, and then the fact that decides what
                // to do about it: a sync that has not reached the pools yet is
                // not the same problem as one that has and found none.
                `${anchor.note} ${syncingNote({ syncing, progress, behind, pools: counts?.pools ?? 0 })}`
              : status === 'working'
              ? `The indexer is busy: ${work!.stage}` +
                (work!.detail ? ` — ${work!.detail}` : '') +
                `, ${humanSeconds(workSeconds ?? 0)} so far, alive ${Math.round(heartbeatSeconds ?? 0)}s ago. ` +
                'No block is written until this finishes' +
                (lagSeconds === null ? '.' : `; the site is showing numbers ${humanSeconds(lagSeconds)} old.`)
              : status === 'stalled'
              ? `The indexer has not written a block for ${Math.round(idleSeconds ?? 0)}s, past the ` +
                `${env.stallSeconds}s threshold. It is dead or stuck; the site is showing numbers ` +
                `${Math.round(lagSeconds ?? 0)}s old.`
              : status === 'syncing'
                ? `First sync: block ${cursor!.lastIndexedBlock} of ${head}` +
                  (progress === null ? '' : ` (${progress.toFixed(2)}%)`) +
                  `, ${counts?.pools ?? 0} pool(s) so far. Numbers on the site are ` +
                  `${Math.round(lagSeconds ?? 0)}s of chain time behind and say so.`
                : status === 'behind'
                  ? `Indexing, but the newest block is ${Math.round(lagSeconds ?? 0)}s old — catching up.`
                  : undefined,
    };

    return reply.code(needsSomeone ? 503 : 200).send(body);
  });

  /**
   * A token's logo, served from here.
   *
   * The board once showed four empty discs: logo URLs that loaded from the
   * box and not from a browser, or the reverse — a host that answers one
   * client and refuses another. The browser now asks this route, this
   * route fetches the URL on record exactly as the logo process did when it
   * checked that the image loads, and the two tests become one. The bytes
   * are held in memory for a day, so a hundred badges cost the source one
   * request; a URL that stops serving an image is remembered as a miss for
   * ten minutes rather than asked about on every page load.
   *
   * Only URLs on record are fetched — this is not an open proxy — and only
   * an image comes back: anything else is a 404, and the badge falls back
   * to the monogram.
   */
  const logoCache = new Map<string, CachedLogo>();
  const logoFetch = options.logoFetch ?? (globalThis.fetch as unknown as LogoFetch);

  app.get<{ Params: { address: string } }>('/api/logo/:address', async (request, reply) => {
    const address = request.params.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return reply.code(400).send({ statusCode: 400, error: 'bad-address', message: 'Not an address.' });
    }

    const now = Date.now();
    const held = logoCache.get(address);
    if (held && now - held.at < ('miss' in held ? LOGO_MISS_TTL_MS : LOGO_TTL_MS)) {
      if ('miss' in held) return reply.code(404).send();
      return reply
        .type(held.type)
        .header('cache-control', 'public, max-age=86400')
        .send(held.body);
    }

    const remember = (entry: CachedLogo) => {
      if (logoCache.size >= LOGO_CACHE_MAX) {
        const oldest = logoCache.keys().next().value;
        if (oldest !== undefined) logoCache.delete(oldest);
      }
      logoCache.set(address, entry);
    };

    const token = await prisma.token.findUnique({ where: { address }, select: { logoUrl: true } });
    if (!token?.logoUrl) {
      remember({ at: now, miss: true });
      return reply.code(404).send();
    }

    try {
      const upstream = await logoFetch(token.logoUrl, {
        headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      const type = upstream.headers.get('content-type')?.split(';')[0].trim() ?? '';
      const isImage = /^image\//i.test(type) || /octet-stream/i.test(type);
      if (!upstream.ok || !isImage) {
        app.log.warn(`logo for ${address} does not serve an image (${upstream.status} ${type || 'no type'}): ${token.logoUrl}`);
        remember({ at: now, miss: true });
        return reply.code(404).send();
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length === 0 || body.length > LOGO_MAX_BYTES) {
        remember({ at: now, miss: true });
        return reply.code(404).send();
      }
      remember({ at: now, type, body });
      return reply.type(type).header('cache-control', 'public, max-age=86400').send(body);
    } catch (error) {
      app.log.warn({ err: error }, `logo for ${address} could not be fetched: ${token.logoUrl}`);
      remember({ at: now, miss: true });
      return reply.code(404).send();
    }
  });

  /**
   * A wallet's positions (§22): the PositionManager tokens it holds, valued
   * at the last indexed block. Per wallet, so not part of the cached
   * snapshot; the query is a handful of rows and it is rate limited like
   * any other. 503 for the same reasons the snapshot is.
   */
  app.get<{ Params: { wallet: string }; Querystring: { v4?: string | string[]; v3tx?: string | string[]; v3closed?: string | string[] } }>('/api/portfolio/:wallet', async (request, reply) => {
    const wallet = request.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
      return reply.code(400).send({ statusCode: 400, error: 'bad-address', message: 'Not an address.' });
    }
    const problem = configurationProblem();
    if (problem) return reply.code(503).send({ error: 'misconfigured', message: problem });
    // Token ids the browser saw minted to this wallet (lib/tx-history.ts), so
    // a position is on the page the moment its receipt is in. Candidates
    // only: nothing is shown that the chain does not confirm this wallet holds.
    // `?v4=1&v4=2` arrives as an array; either shape is read the same way.
    const hinted = ([] as string[])
      .concat(request.query.v4 ?? [])
      .join(',')
      .split(',')
      .filter((id) => /^\d{1,30}$/.test(id))
      .slice(0, 50)
      .map((id) => BigInt(id));
    // `?v3tx=tokenId:txHash,…`: transactions this browser sent for a v3
    // position (its mint, collects, withdrawals). Candidates for finding its
    // history when the explorer does not answer; every log in them is still
    // filtered to the v3 manager and the token id, and the sum is checked
    // against the chain's liquidity (v3-history.ts), so a wrong hash adds nothing.
    const v3TxHints = new Map<string, `0x${string}`[]>();
    for (const pair of ([] as string[]).concat(request.query.v3tx ?? []).join(',').split(',').slice(0, 40)) {
      const match = /^(\d{1,30}):(0x[0-9a-fA-F]{64})$/.exec(pair.trim());
      if (!match) continue;
      const list = v3TxHints.get(match[1]) ?? [];
      if (list.length < 10) list.push(match[2].toLowerCase() as `0x${string}`);
      v3TxHints.set(match[1], list);
    }
    // `?v3closed=tokenId@poolId,…`: v3 positions this browser withdrew. Listed
    // as closed only when their own logs add up to zero liquidity, minted into
    // that pool, from this wallet (portfolio.ts).
    const v3Closed = new Map<string, string>();
    for (const pair of ([] as string[]).concat(request.query.v3closed ?? []).join(',').split(',').slice(0, 30)) {
      const match = /^(\d{1,30})@(v3:0x[0-9a-fA-F]{40})$/.exec(pair.trim());
      if (match) v3Closed.set(match[1], match[2].toLowerCase());
    }
    const scanned = v4Scanner?.owned(wallet) ?? [];
    // Every v4 NFT the explorer says this wallet holds, however old: the scan
    // covers only the newest ids and the indexer is weeks behind (§30).
    const listed = explorerPositions ? await explorerPositions.owned(wallet) : null;
    const built = await buildPortfolio(wallet, USDG || null, {
      chain: portfolioChain,
      // Today's ether price when the snapshot has one (§24), so positions are
      // valued at today's prices rather than the indexer's.
      ethUsd: cached?.snapshot && cached.snapshot.global.ethPriceBasis !== 'chain' ? cached.snapshot.global.ethPriceUsd : null,
      v4Candidates: [...scanned, ...hinted, ...(listed ?? [])],
      v3TxHints,
      v3Closed,
      // Complete when the explorer answered for this wallet, or the scan
      // covers every id; otherwise the page says the list may be missing some.
      scanPartial: portfolioChain !== null && listed === null && !(v4Scanner?.complete() ?? false),
    });
    if (!built) {
      return reply.code(503).send({ error: 'no-data', message: 'The indexer has not priced a block yet.' });
    }
    return reply.header('cache-control', 'no-store').send(built);
  });

  /**
   * Ask LockFi (ask.ts). GET says whether it is on, so the page can hide the
   * panel rather than offer a box that always fails; POST answers from the
   * snapshot's own figures for the pool named.
   */
  // ── the router page's lookups (§49) ──────────────────────────────────────────
  const isAddr = (a: string | undefined): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  app.get<{ Querystring: { wallet?: string } }>('/api/router/mine', async (request, reply) => {
    if (!routerTokens) return reply.code(503).send({ error: 'off' });
    const wallet = request.query.wallet;
    if (!isAddr(wallet)) return reply.code(400).send({ error: 'bad-address', message: 'Not an address.' });
    const tokens = await routerTokens.createdBy(wallet);
    return reply.header('cache-control', 'no-store').send({ wallet: wallet.toLowerCase(), tokens });
  });
  app.get<{ Params: { address: string } }>('/api/router/token/:address', async (request, reply) => {
    if (!routerTokens) return reply.code(503).send({ error: 'off' });
    const token = request.params.address;
    if (!isAddr(token)) return reply.code(400).send({ error: 'bad-address', message: 'Not an address.' });
    const [meta, creator, pools] = await Promise.all([
      routerTokens.tokenMeta(token),
      routerTokens.creatorOf(token),
      routerTokens.poolsFor(token),
    ]);
    if (!meta) return reply.code(404).send({ error: 'not-a-token', message: 'That address does not answer as a token on this chain.' });
    return reply.header('cache-control', 'no-store').send({ token: meta, creator, pools });
  });
  app.get<{ Querystring: { tokens?: string } }>('/api/router/creators', async (request, reply) => {
    if (!routerTokens) return reply.code(503).send({ error: 'off' });
    const tokens = (request.query.tokens ?? '').split(',').filter(isAddr).slice(0, 100);
    return reply.header('cache-control', 'no-store').send({ creators: await routerTokens.creatorsOf(tokens) });
  });

  app.get('/api/ask', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      enabled: askConfig.apiKey !== '',
      provider: providerName(askConfig.baseUrl),
    }),
  );

  app.post(
    '/api/ask',
    {
      bodyLimit: 32 * 1024,
      config: { rateLimit: { max: env.ai.perMinute, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const parsed = parseAskBody(request.body);
      if ('error' in parsed) return reply.code(400).send({ error: 'bad-request', message: parsed.error });
      try {
        const value = await snapshot().catch(() => null);
        const result = await answer({ cfg: askConfig, fetch: askFetch, counter: askCounter }, value, parsed);
        return reply.header('cache-control', 'no-store').send(result);
      } catch (error) {
        if (error instanceof AskError) {
          // The provider's own words stay in the log: they can name the account.
          if (error.code === 'upstream' || error.code === 'misconfigured') app.log.warn(`ask: ${error.message}`);
          const message =
            error.code === 'upstream' || error.code === 'misconfigured'
              ? 'The assistant could not answer just now. Try again in a moment.'
              : error.message;
          return reply.code(error.status).send({ error: error.code, message });
        }
        throw error;
      }
    },
  );

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

  app.get('/api/stream', { websocket: true }, (connection) => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Push only what changed: the same revision is not sent twice, so a
    // tick that arrives before the next rebuild costs this socket nothing.
    let sentRevision = -1;
    const send = async () => {
      timer = null;
      if (closed) return;
      const value = await snapshot();
      if (closed || !value || value.revision === sentRevision) return;
      try {
        connection.send(serialise(value));
        sentRevision = value.revision;
      } catch {
        /* the socket went away between the query and the send */
      }
    };

    // §4.4: debounce to about a second so a burst of blocks is one push.
    const schedule = () => {
      if (closed || timer) return;
      timer = setTimeout(send, env.streamDebounceMs);
    };

    void send();
    const unsubscribePromise = subscribeTicks(schedule);
    marketListeners.add(schedule);

    connection.on('close', () => {
      closed = true;
      if (timer) clearTimeout(timer);
      marketListeners.delete(schedule);
      void unsubscribePromise.then((unsubscribe) => unsubscribe());
    });
    connection.on('error', () => {
      closed = true;
    });
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  const app = await buildServer();
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
