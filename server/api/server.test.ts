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

  it('reports a moving indexer that is far behind as catching up, not stalled', async () => {
    // The fixture's chain time is months in the past, so a full sync leaves
    // the indexer enormously behind — while it has just written progress.
    // That is a first sync working as designed. It used to read "stalled",
    // on the page every visitor saw first.
    const { Poller } = await import('../indexer/poller');
    const { FixtureLogSource, USDG, fixtureTokenReader } = await import('../test/fixture');
    await new Poller({
      source: new FixtureLogSource(chain),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    // 200: an uptime check must not page anyone for a first sync.
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('catching-up');
    expect(body.indexed.lagSeconds).toBeGreaterThan(body.stallThresholdSeconds);
    expect(body.message).toMatch(/catching up: \d+d behind/);
    expect(body.pools).toBe(4);
  });

  it('reports stalled once no progress has been written for the threshold', async () => {
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    const old = new Date(Date.now() - 2 * 3600_000);
    await prisma.indexerCursor.update({ where: { contract: cursor.contract }, data: { updatedAt: old } });

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('stalled');
    expect(body.message).toMatch(/stopped advancing/);
    expect(body.message).not.toMatch(/\d{5,}s/);
  });

  it('reports stalled when the block number stops moving while behind', async () => {
    // Progress keeps being written — the poller re-scans every pass — but the
    // block never advances: an RPC stuck on an old head looks exactly so.
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    const realNow = Date.now();
    await prisma.indexerCursor.update({ where: { contract: cursor.contract }, data: { updatedAt: new Date(realNow) } });
    await app.inject({ method: 'GET', url: '/api/health' }); // seen at this block

    const later = realNow + 2 * 3600_000;
    await prisma.indexerCursor.update({ where: { contract: cursor.contract }, data: { updatedAt: new Date(later) } });
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.json().status).toBe('stalled');
    } finally {
      spy.mockRestore();
    }
  });

  it('answers 200 when the last indexed block is recent', async () => {
    // Move the cursor's timestamp to now: the same data, freshly indexed.
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { lastIndexedAt: new Date(), updatedAt: new Date() },
    });

    const response = await app.inject({ method: 'GET', url: '/api/health' });
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
      expect(['never-indexed', 'no-anchor', 'ok', 'catching-up', 'stalled']).toContain(body.status);
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
