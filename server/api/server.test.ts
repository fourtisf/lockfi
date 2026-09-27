/**
 * The API's behaviour at its edges: what it answers when the indexer is
 * stalled, and what it answers when someone loops on the expensive query.
 *
 * Both are things an operator or a monitor acts on, so the status codes
 * matter more than the bodies.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Every import here is dynamic, and that is not stylistic.
 *
 * `server/env.ts` reads `process.env` exactly once, at import — which is the
 * behaviour we want in production, because a typo'd variable then stops the
 * process at boot rather than producing an indexer quietly following the
 * wrong chain. The cost is that a test wanting a different limit has to set
 * it before anything pulls that module in, and a static import would be
 * hoisted above the assignment.
 */
const RATE_LIMIT_MAX = 4;
const USDG_ADDRESS = '0x00000000000000000000000000000000000000d6';

let app: FastifyInstance;
let prisma: PrismaClient;
let chain: Awaited<ReturnType<typeof loadFixture>>;

async function loadFixture() {
  const { buildFixtureChain } = await import('../test/fixture');
  return buildFixtureChain();
}

beforeAll(async () => {
  process.env.USDG_ADDRESS = USDG_ADDRESS;
  process.env.RATE_LIMIT_MAX = String(RATE_LIMIT_MAX);
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.INDEXER_STALL_SECONDS = '300';
  // The suite deliberately makes hundreds of refused requests; logging each
  // one buries the actual test output.
  process.env.LOG_LEVEL = 'silent';

  ({ prisma } = await import('../db'));
  const { isReachable, resetDatabase } = await import('../test/db');
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();

  chain = await loadFixture();
  const { buildServer } = await import('./server');
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('/api/logo/:address', () => {
  const ADDRESS = '0x00000000000000000000000000000000000000c1';
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upstream = (type: string, ok = true) => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return {
        ok,
        status: ok ? 200 : 403,
        headers: { get: (name: string) => (name === 'content-type' ? type : null) },
        arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
      };
    };
    return { fetch, calls: () => calls };
  };

  it('serves the logo on record from here, once per day, and 404 for a token without one', async () => {
    await prisma.token.create({
      data: { address: ADDRESS, symbol: 'C1', name: 'C1', decimals: 18, firstSeen: new Date('2026-07-01'), logoUrl: 'https://cdn.example/c1.png' },
    });
    const source = upstream('image/png');
    const { buildServer } = await import('./server');
    const built = await buildServer({ logoFetch: source.fetch });
    await built.ready();
    try {
      const first = await built.inject({ method: 'GET', url: `/api/logo/${ADDRESS}` });
      expect(first.statusCode).toBe(200);
      expect(first.headers['content-type']).toContain('image/png');
      expect(first.rawPayload.equals(PNG)).toBe(true);
      expect(first.headers['cache-control']).toContain('max-age=86400');
      // Held in memory: a second badge costs the source nothing.
      const second = await built.inject({ method: 'GET', url: `/api/logo/${ADDRESS.toUpperCase().replace('0X', '0x')}` });
      expect(second.statusCode).toBe(200);
      expect(source.calls()).toBe(1);
      // No logo on record: 404, and nothing fetched. Not an address: 400.
      const none = await built.inject({ method: 'GET', url: '/api/logo/0x00000000000000000000000000000000000000c2' });
      expect(none.statusCode).toBe(404);
      expect(source.calls()).toBe(1);
      expect((await built.inject({ method: 'GET', url: '/api/logo/not-an-address' })).statusCode).toBe(400);
    } finally {
      await built.close();
      await prisma.token.delete({ where: { address: ADDRESS } });
    }
  });

  it('answers 404 when the URL on record does not serve an image', async () => {
    await prisma.token.create({
      data: { address: ADDRESS, symbol: 'C1', name: 'C1', decimals: 18, firstSeen: new Date('2026-07-01'), logoUrl: 'https://cdn.example/c1.png' },
    });
    const { buildServer } = await import('./server');
    const html = await buildServer({ logoFetch: upstream('text/html').fetch });
    const refused = await buildServer({ logoFetch: upstream('image/png', false).fetch });
    await html.ready();
    await refused.ready();
    try {
      expect((await html.inject({ method: 'GET', url: `/api/logo/${ADDRESS}` })).statusCode).toBe(404);
      expect((await refused.inject({ method: 'GET', url: `/api/logo/${ADDRESS}` })).statusCode).toBe(404);
    } finally {
      await html.close();
      await refused.close();
      await prisma.token.delete({ where: { address: ADDRESS } });
    }
  });
});

describe('/api/health', () => {
  it('answers 503 before the indexer has ever written a block', async () => {
    // A 200 here would tell an uptime monitor everything is fine while the
    // indexer has never started — which is the failure §8's P3 criterion is
    // about, and the reason this endpoint carries a status code at all.
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('never-indexed');
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/USDG_ADDRESS|never written/i);
  });

  it('reads a live poller that is far behind in chain time as "behind", not stalled', async () => {
    // The fixture's chain time is months in the past, so a full sync leaves
    // the indexer enormously behind IN CHAIN TIME while the poller has just
    // written. That is a working indexer with old numbers — the lag is on
    // screen (§7) — and not a stall. Judged on chain lag, it read as one,
    // and a real first sync would have paged the monitor for forty hours.
    const { Poller } = await import('../indexer/poller');
    const { FixtureLogSource, USDG, fixtureTokenReader } = await import('../test/fixture');
    await new Poller({
      source: new FixtureLogSource(chain),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.21' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('behind');
    expect(body.ok).toBe(false);
    expect(body.indexed.lagSeconds).toBeGreaterThan(body.stallThresholdSeconds);
    expect(body.indexed.idleSeconds).toBeLessThan(body.stallThresholdSeconds);
    expect(body.pools).toBe(4);
  });

  it('answers 503 with "stalled" once the poller has stopped writing', async () => {
    // Liveness is the cursor's write time. Push it past the threshold: the
    // same data, but nobody has touched it in ten minutes.
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { updatedAt: new Date(Date.now() - 600_000) },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.22' },
    });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('stalled');
    expect(body.message).toMatch(/not written/i);
  });

  it('reads a stage that is heartbeating as "working", not as a stall', async () => {
    // The cursor is still ten minutes stale from the test above. The full
    // rebuild and the factory's history write no block for hours, and the
    // deploy summary after the v4-sign repair read STALLED over an indexer
    // that was busy the whole time. A fresh heartbeat on a named stage is
    // alive, and health says so with the stage and how long it has run.
    const { WORKING_KEY } = await import('../indexer/working');
    const startedAt = new Date(Date.now() - 3 * 3600_000 - 12 * 60_000).toISOString();
    await prisma.indexerState.upsert({
      where: { key: WORKING_KEY },
      create: {
        key: WORKING_KEY,
        value: JSON.stringify({ stage: 'full rebuild', detail: 'fees', startedAt, heartbeatAt: new Date().toISOString() }),
        updatedAt: new Date(),
      },
      update: {
        value: JSON.stringify({ stage: 'full rebuild', detail: 'fees', startedAt, heartbeatAt: new Date().toISOString() }),
        updatedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.23' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('working');
    expect(body.ok).toBe(false);
    expect(body.working.stage).toBe('full rebuild');
    expect(body.working.detail).toBe('fees');
    expect(body.working.seconds).toBeGreaterThan(3 * 3600);
    expect(body.message).toMatch(/full rebuild — fees, 3h 12m so far/);
    expect(body.message).toMatch(/No block is written/);
  });

  it('ignores a stage whose heartbeat has stopped: that is a stall', async () => {
    // A process killed mid-rebuild leaves its record behind. Its heartbeat
    // is what made it count, and past the threshold it counts for nothing.
    const { WORKING_KEY } = await import('../indexer/working');
    const value = JSON.stringify({
      stage: 'full rebuild',
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 900_000).toISOString(),
    });
    await prisma.indexerState.update({ where: { key: WORKING_KEY }, data: { value } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.24' },
    });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('stalled');
    expect(body.working).toBeNull();
    await prisma.indexerState.delete({ where: { key: WORKING_KEY } });
  });

  it('reads a first sync as "syncing" with a 200, not as a stall', async () => {
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      // Writing now, far from head: the shape of a backfill.
      data: { updatedAt: new Date(), headBlock: cursor.lastIndexedBlock + 60_000_000n },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.23' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('syncing');
    expect(body.indexed.syncing).toBe(true);
    expect(body.message).toMatch(/first sync/i);

    // Put head back for the tests after this one.
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { headBlock: cursor.headBlock },
    });
  });

  it('answers 200 "ok" when the last indexed block is recent and the poller is writing', async () => {
    // Move the cursor's chain time to now: the same data, freshly indexed.
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { lastIndexedAt: new Date(), updatedAt: new Date() },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.24' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});

describe('rate limiting', () => {
  it('answers 429, not 500, once the budget is spent', async () => {
    // 500 would be wrong in a way that matters: it tells a client the server
    // broke and to retry, rather than to back off. The plugin THROWS the
    // object from errorResponseBuilder, so it needs its own statusCode —
    // without one Fastify answers 500. That is what this pins.
    const codes: number[] = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 6; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      codes.push(response.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes).not.toContain(500);

    const refused = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('rate-limited');
    expect(refused.json().message).toMatch(/try again/i);
  });

  it('counts each client separately', async () => {
    // One loop must not lock everyone else out — which a shared bucket would.
    const response = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'x-forwarded-for': '198.51.100.22' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('cannot be escaped by inventing an X-Forwarded-For hop per request', async () => {
    // nginx appends the real peer to whatever the client sent, so the client's
    // own entry is FIRST and nginx's is LAST. Keyed on the first entry, a loop
    // that made up a fresh address per request got a fresh budget per request.
    const codes: number[] = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 6; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: { 'x-forwarded-for': `10.0.${i}.${i}, 203.0.113.99` },
      });
      codes.push(response.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it('prefers X-Real-IP, which only nginx sets', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX + 6; i++) {
      await app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: { 'x-real-ip': '203.0.113.100', 'x-forwarded-for': `10.1.${i}.${i}` },
      });
    }
    const refused = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'x-real-ip': '203.0.113.100', 'x-forwarded-for': '10.9.9.9' },
    });
    expect(refused.statusCode).toBe(429);
  });

  it('never rate-limits the websocket', async () => {
    // After a restart every client reconnects at once. Counting the stream
    // against a per-minute budget would refuse exactly the clients that most
    // need to get back on.
    for (let i = 0; i < 12; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/stream',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      // Not a websocket handshake through inject, so it will not be 101 —
      // what matters is that it is never refused as rate-limited.
      expect(response.statusCode).not.toBe(429);
    }
  });
});

describe('USDG_ADDRESS', () => {
  /**
   * Unset is no longer a fault. The anchor is discovered from the chain's own
   * tokens, because an indexer that refuses to start until a human looks up
   * an address leaves the site on a "not configured" page indefinitely — it
   * did, for hours.
   *
   * A MALFORMED override is still a fault, and a different one: somebody
   * meant to pin a specific token and mistyped it, and quietly pricing the
   * whole site off a different token would be far worse than saying so.
   *
   * `vi.resetModules` because server.ts reads the variable at import, which
   * is the behaviour we want in production.
   */
  async function serverWith(value: string | undefined): Promise<FastifyInstance> {
    vi.resetModules();
    const saved = process.env.USDG_ADDRESS;
    if (value === undefined) delete process.env.USDG_ADDRESS;
    else process.env.USDG_ADDRESS = value;
    const { buildServer } = await import('./server');
    const built = await buildServer();
    await built.ready();
    if (saved !== undefined) process.env.USDG_ADDRESS = saved;
    else delete process.env.USDG_ADDRESS;
    return built;
  }

  it('starts with none set, and does not call that a misconfiguration', async () => {
    const bare = await serverWith(undefined);
    try {
      const body = (await bare.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body.status).not.toBe('misconfigured');
      // On an empty database it is "never-indexed" or "no-anchor" — both
      // transient and self-healing, neither of them somebody's mistake.
      expect(['never-indexed', 'no-anchor', 'ok', 'stalled']).toContain(body.status);
    } finally {
      await bare.close();
      vi.resetModules();
    }
  });

  it('reports which token is pricing the site, and how it was chosen', async () => {
    // The single most consequential value in the system: a wrong anchor makes
    // every dollar figure wrong. It has to be auditable from outside.
    const bare = await serverWith(undefined);
    try {
      const body = (await bare.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body).toHaveProperty('usdgSource');
      expect(body).toHaveProperty('usdgNote');
      expect(typeof body.usdgNote).toBe('string');
      expect(body.usdgNote.length).toBeGreaterThan(10);
    } finally {
      await bare.close();
      vi.resetModules();
    }
  });

  it('refuses a malformed override rather than discovering something else', async () => {
    const bad = await serverWith('0xnope');
    try {
      const health = await bad.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(503);
      const body = health.json();
      expect(body.status).toBe('misconfigured');
      expect(body.message).toMatch(/is not an address/i);

      const snapshot = await bad.inject({ method: 'GET', url: '/api/snapshot' });
      expect(snapshot.statusCode).toBe(503);
      expect(snapshot.json().error).toBe('misconfigured');
    } finally {
      await bad.close();
      vi.resetModules();
    }
  });

  it('takes a well-formed override as given', async () => {
    const pinned = await serverWith('0x00000000000000000000000000000000000000d6');
    try {
      const body = (await pinned.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body.status).not.toBe('misconfigured');
      expect(body.usdgSource).toBe('configured');
    } finally {
      await pinned.close();
      vi.resetModules();
    }
  });
});

/**
 * What the waiting page reads while there is no anchor.
 *
 * "Looking for the USD anchor" is the same sentence in two situations that
 * call for opposite responses: a first sync that has not reached the pools
 * yet, where the only correct action is to wait, and a finished sync that
 * found no ETH/USDG pool, where waiting is the one thing that cannot help.
 * The page showed the first sentence and not the fact that separates them,
 * so the dead end was indistinguishable from progress — for hours.
 */
describe('/api/health while there is no anchor', () => {
  /** A cursor with nothing indexed behind it: the shape of a first sync. */
  async function cursorAt(lastBlock: bigint, headBlock: bigint) {
    const { resetDatabase } = await import('../test/db');
    await resetDatabase();
    await prisma.indexerCursor.create({
      data: {
        contract: 'v4:0x8366a39cc670b4001a1121b8f6a443a643e40951',
        lastIndexedBlock: lastBlock,
        lastIndexedAt: new Date(),
        headBlock,
        updatedAt: new Date(),
      },
    });
    const bare = await (await import('./server')).buildServer();
    try {
      const response = await bare.inject({ method: 'GET', url: '/api/health' });
      return { code: response.statusCode, body: response.json() };
    } finally {
      await bare.close();
    }
  }

  it('reports how far through the chain a first sync is', async () => {
    delete process.env.USDG_ADDRESS;
    vi.resetModules();
    const { code, body } = await cursorAt(6_264_470n, 62_644_703n);

    expect(code).toBe(503);
    expect(body.status).toBe('no-anchor');
    expect(body.indexed.headBlock).toBe('62644703');
    expect(body.indexed.blocksBehind).toBe('56380233');
    expect(body.indexed.progressPct).toBeCloseTo(10, 1);
    expect(body.indexed.syncing).toBe(true);
    // The sentence that says waiting is the right thing to do.
    expect(body.message).toMatch(/first sync is still running/i);
  });

  it('says so plainly when it is caught up and has found nothing', async () => {
    vi.resetModules();
    const { body } = await cursorAt(62_644_700n, 62_644_703n);

    expect(body.status).toBe('no-anchor');
    expect(body.indexed.syncing).toBe(false);
    // Caught up: this is a configuration question, not a waiting game.
    expect(body.message).toMatch(/caught up/i);
    expect(body.message).toMatch(/POOL_MANAGER|USDG_ADDRESS/);
  });

  afterAll(() => {
    process.env.USDG_ADDRESS = USDG_ADDRESS;
    vi.resetModules();
  });
});

describe('the kept snapshot', () => {
  it('is served by a new process from its first request, aged, even while nothing can be built', async () => {
    // A deploy restarts the API, and the page that loads next used to wait on
    // the new process's first build — which, with the indexer mid-repair
    // after the same deploy, can come back empty for a long time. The last
    // build is kept in indexer_state and served until a build here succeeds.
    const { resetDatabase } = await import('../test/db');
    await resetDatabase();
    const { Poller, POOL_MANAGER_CURSOR } = await import('../indexer/poller');
    const { FixtureLogSource, USDG, fixtureTokenReader } = await import('../test/fixture');
    await new Poller({ source: new FixtureLogSource(chain), usdgAddress: USDG, startBlock: 0n, blockRange: chain.headBlock + 1, tokenReader: fixtureTokenReader }).syncToHead();
    const { SNAPSHOT_STATE_KEY, resetPersistClock } = await import('./snapshot-store');
    const { buildServer } = await import('./server');
    resetPersistClock();

    // The process that builds it writes it down.
    const before = await buildServer();
    await before.ready();
    try {
      const first = await before.inject({ method: 'GET', url: '/api/snapshot', headers: { 'x-real-ip': 'kept-a' } });
      expect(first.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await before.close();
    }
    const row = await prisma.indexerState.findUnique({ where: { key: SNAPSHOT_STATE_KEY } });
    expect(row).not.toBeNull();
    const kept = JSON.parse(row!.value);
    expect(typeof kept.builtAt).toBe('string');
    expect(kept.pools.length).toBeGreaterThan(0);

    // Every fresh build now comes back empty: there is no cursor.
    await prisma.indexerCursor.delete({ where: { contract: POOL_MANAGER_CURSOR } });
    const fresh = await buildServer();
    await fresh.ready();
    try {
      const served = await fresh.inject({ method: 'GET', url: '/api/snapshot', headers: { 'x-real-ip': 'kept-b' } });
      expect(served.statusCode).toBe(200);
      const body = served.json();
      expect(body.builtAt).toBe(kept.builtAt);
      expect(body.pools.length).toBe(kept.pools.length);
      // Aged: the lag has the time since the build added to it.
      expect(body.indexerLagSeconds).toBeGreaterThanOrEqual(kept.indexerLagSeconds);
      // The page accepts only a higher revision, and the first real build's is above this one's.
      expect(body.revision).toBeGreaterThan(kept.revision);
      // The rebuild that request started found nothing; the board stays up.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const again = await fresh.inject({ method: 'GET', url: '/api/snapshot', headers: { 'x-real-ip': 'kept-c' } });
      expect(again.statusCode).toBe(200);
      expect(again.json().builtAt).toBe(kept.builtAt);
    } finally {
      await fresh.close();
    }
  });
});

describe('/api/ask', () => {
  const config = {
    apiKey: 'dly_live_test',
    baseUrl: 'https://api.dualyne.com/v1',
    model: 'claude-swift',
    maxTokens: 450,
    dailyLimit: 100,
  };
  const provider = () => {
    const bodies: string[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'An answer.' } }] }), { status: 200 });
    };
    return { fetch, bodies };
  };

  it('says it is off without a key, and refuses to answer', async () => {
    const off = await buildServerWith({ ask: { config: { ...config, apiKey: '' }, fetch: provider().fetch } });
    const status = await off.inject({ method: 'GET', url: '/api/ask' });
    expect(status.json()).toEqual({ enabled: false, provider: 'Dualyne' });
    const res = await off.inject({
      method: 'POST',
      url: '/api/ask',
      headers: { 'x-real-ip': '10.9.0.1' },
      payload: { question: 'hi' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('off');
    await off.close();
  });

  it('answers through the provider, and refuses a bad body with a reason', async () => {
    const upstream = provider();
    const on = await buildServerWith({ ask: { config, fetch: upstream.fetch } });
    expect((await on.inject({ method: 'GET', url: '/api/ask' })).json()).toEqual({ enabled: true, provider: 'Dualyne' });
    const ok = await on.inject({
      method: 'POST',
      url: '/api/ask',
      headers: { 'x-real-ip': '10.9.0.2' },
      payload: { question: 'What is a fee tier?', poolId: 'no-such-pool' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ answer: 'An answer.', poolFound: false });
    expect(upstream.bodies[0]).toContain('What is a fee tier?');
    const bad = await on.inject({
      method: 'POST',
      url: '/api/ask',
      headers: { 'x-real-ip': '10.9.0.2' },
      payload: { question: '' },
    });
    expect(bad.statusCode).toBe(400);
    await on.close();
  });

  it('limits questions per client per minute', async () => {
    const on = await buildServerWith({ ask: { config, fetch: provider().fetch } });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await on.inject({
        method: 'POST',
        url: '/api/ask',
        headers: { 'x-real-ip': '10.9.0.3' },
        payload: { question: `q${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
    await on.close();
  });

  async function buildServerWith(options: Parameters<typeof import('./server')['buildServer']>[0]) {
    const built = await (await import('./server')).buildServer({ portfolioChain: null, reservesReader: null, ...options });
    await built.ready();
    return built;
  }
});

describe('/api/router', () => {
  const creator = { address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', tx: `0x${'ab'.repeat(32)}`, via: '0x5fbdb2315678afecb367f032d93f642f64180aa3' };
  const fake = {
    createdBy: async (w: string) =>
      w.toLowerCase() === creator.address ? [{ address: '0x1111111111111111111111111111111111111111', symbol: 'DEV', name: 'Dev Coin', decimals: 18, creator }] : [],
    tokenMeta: async (t: string) => (t.startsWith('0x11') ? { address: t, symbol: 'DEV', name: 'Dev Coin', decimals: 18 } : null),
    creatorOf: async () => creator,
    poolsFor: async () => [],
    creatorsOf: async (ts: string[]) => Object.fromEntries(ts.map((t) => [t.toLowerCase(), creator])),
  };
  async function build(routerTokens: unknown) {
    const built = await (await import('./server')).buildServer({ portfolioChain: null, reservesReader: null, routerTokens: routerTokens as never });
    await built.ready();
    return built;
  }

  it('lists the tokens a wallet created, and refuses what is not an address', async () => {
    const app = await build(fake);
    const mine = await app.inject({ method: 'GET', url: `/api/router/mine?wallet=${creator.address}` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().tokens.map((t: { symbol: string }) => t.symbol)).toEqual(['DEV']);
    expect((await app.inject({ method: 'GET', url: '/api/router/mine?wallet=nope' })).statusCode).toBe(400);
    await app.close();
  });

  it('answers a token with its creator and pools, and 404s an address that is not a token', async () => {
    const app = await build(fake);
    const ok = await app.inject({ method: 'GET', url: '/api/router/token/0x1111111111111111111111111111111111111111' });
    expect(ok.json()).toMatchObject({ token: { symbol: 'DEV' }, creator: { address: creator.address }, pools: [] });
    const miss = await app.inject({ method: 'GET', url: '/api/router/token/0x2222222222222222222222222222222222222222' });
    expect(miss.statusCode).toBe(404);
    const many = await app.inject({ method: 'GET', url: '/api/router/creators?tokens=0x1111111111111111111111111111111111111111,junk' });
    expect(Object.keys(many.json().creators)).toEqual(['0x1111111111111111111111111111111111111111']);
    await app.close();
  });

  it('says it is off when the lookups are', async () => {
    const app = await build(null);
    expect((await app.inject({ method: 'GET', url: `/api/router/mine?wallet=${creator.address}` })).statusCode).toBe(503);
    await app.close();
  });
});
