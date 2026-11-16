/**
 * The token page's price chart (§32): hourly closes from the indexer's own
 * swaps, priced through the one allowed path, ending at the last swap read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { Poller } from '../indexer/poller';
import { isReachable, resetDatabase } from '../test/db';
import { FIXTURE_POOLS, FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { priceFromSqrtX96 } from '../chain/price';
import { queryPoolChart } from './chart';
import { buildServer } from './server';
import { buildSnapshot } from './snapshot';

const chain = buildFixtureChain();
const TOKEN_POOL = `v4:${FIXTURE_POOLS[1].id}`; // token 0x…01 against WETH, priced at $187.2
let app: FastifyInstance;

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  await resetDatabase();
  await new Poller({
    source: new FixtureLogSource(chain),
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  }).syncToHead();
  process.env.USDG_ADDRESS = USDG;
  app = await buildServer({ deployment: null, tokenCurve: null });
});

afterAll(async () => {
  await app?.close();
  delete process.env.USDG_ADDRESS;
  await prisma.$disconnect();
});

describe('queryPoolChart', () => {
  it('gives one close an hour over the week, each the hour’s last swap, in dollars', async () => {
    const c = await queryPoolChart(TOKEN_POOL, USDG, 168);
    expect(c.points.length).toBeGreaterThan(100);
    expect(c.points.length).toBeLessThanOrEqual(169);
    const hours = c.points.map((p) => p.t);
    expect(new Set(hours).size).toBe(hours.length); // one point an hour
    expect([...hours].sort()).toEqual(hours); // oldest first

    // Worked out again here, from the raw rows and in TypeScript: the hour's
    // last swap, the token's price in WETH (token0, 18 decimals both sides),
    // times WETH in dollars at that hour from the anchor series.
    const swaps = await prisma.swapEvent.findMany({ where: { poolId: TOKEN_POOL }, orderBy: [{ blockNum: 'asc' }, { logIndex: 'asc' }] });
    const close = new Map<string, bigint>();
    for (const s of swaps) {
      const h = new Date(s.blockTime);
      h.setUTCMinutes(0, 0, 0);
      close.set(h.toISOString(), BigInt(s.sqrtPrice.toFixed()));
    }
    const anchors = await prisma.wethUsdHourly.findMany({ orderBy: { hour: 'asc' } });
    const wethAt = (t: string) => Number([...anchors].reverse().find((a) => a.hour.toISOString() <= t)?.wethUsd ?? 0);
    for (const p of c.points) {
      expect(new Date(p.t).getUTCMinutes()).toBe(0);
      const expected = priceFromSqrtX96(close.get(p.t)!, 18, 18) * wethAt(p.t);
      expect(p.p / expected).toBeCloseTo(1, 6);
    }
  });

  it('ends at the last swap read, and its last close is the pool’s price', async () => {
    const c = await queryPoolChart(TOKEN_POOL, USDG, 168);
    const snap = await buildSnapshot({ usdgAddress: USDG });
    const pool = snap!.pools.find((p) => p.id === TOKEN_POOL)!;
    const [last] = await prisma.$queryRaw<{ block_time: Date }[]>`SELECT block_time FROM swap_events ORDER BY block_num DESC LIMIT 1`;
    expect(c.asOf).toBe(last.block_time.toISOString());
    expect(new Date(c.points[c.points.length - 1].t).getTime()).toBeLessThanOrEqual(last.block_time.getTime());
    expect(c.points[c.points.length - 1].p / pool.priceUsd).toBeCloseTo(1, 2);
  });

  it('a day is a day: no point older than 24h before the mark', async () => {
    const c = await queryPoolChart(TOKEN_POOL, USDG, 24);
    const mark = new Date(c.asOf!).getTime();
    expect(c.points.length).toBeGreaterThan(10);
    expect(c.points.length).toBeLessThanOrEqual(25);
    for (const p of c.points) expect(mark - new Date(p.t).getTime()).toBeLessThanOrEqual(25 * 3600_000);
  });

  it('an unknown pool is an empty chart, not an error', async () => {
    const c = await queryPoolChart(`v4:0x${'ab'.repeat(32)}`, USDG, 168);
    expect(c.points).toEqual([]);
    expect(c.asOf).not.toBeNull();
  });
});

describe('GET /api/chart/:poolId', () => {
  it('serves the chart, cacheable', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/chart/${TOKEN_POOL}?hours=24` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toMatch(/max-age=60/);
    expect(r.json().points.length).toBeGreaterThan(10);
  });

  it('refuses what is not a pool id or a window it offers', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/chart/robert;drop' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/chart/${TOKEN_POOL}?hours=5` })).statusCode).toBe(400);
  });
});
