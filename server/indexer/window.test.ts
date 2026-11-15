/**
 * The swap window: ranges older than it are read for pool structure only.
 *
 * On the real chain every swap from the start is some two hundred million
 * logs — days through public endpoints before the site showed today. Every
 * figure on the site looks back at most seven days, and depth needs only the
 * liquidity history (TVL is valued from positions). So the window may skip
 * old swaps — and must change nothing the site shows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STRUCTURE_TOPICS } from '../chain/abi';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FIXTURE_BLOCK_SECONDS, FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { PENDING_DECIMALS, ensureTokens, hydrateTokens } from './discovery';
import { Poller } from './poller';

const chain = buildFixtureChain();
const WINDOW_S = 2 * 86_400; // two days of a ~7.6-day fixture chain
const RANGE = 500;

async function snapshotOf() {
  const pools = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM pools ORDER BY id`;
  const state = await prisma.$queryRaw<Record<string, string>[]>`
    SELECT pool_id, tvl_usd::text AS tvl, price_usd::text AS price FROM pool_state ORDER BY pool_id
  `;
  const liquidity = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM liquidity_events`;
  return { pools: pools.map((p) => p.id), state, liquidity: liquidity[0].n };
}

async function feeHoursFrom(since: Date) {
  return prisma.$queryRaw<Record<string, string>[]>`
    SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour, fees_token0::text AS f0,
           fees_token1::text AS f1, fees_usd::text AS usd, volume_usd::text AS vol, swaps::text AS n
    FROM pool_fee_hourly WHERE hour >= ${since} ORDER BY pool_id, hour
  `;
}

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL.');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the swap window', () => {
  it('skips old swaps, keeps every pool and every liquidity event, and changes nothing shown', async () => {
    const head = chain.blockTime(chain.headBlock);
    const windowStart = new Date(head.getTime() - WINDOW_S * 1000);
    // A pass straddling the edge reads all of itself, so the window's real
    // edge is up to one range earlier. Compare from a range after it.
    const settled = new Date(windowStart.getTime() + RANGE * FIXTURE_BLOCK_SECONDS * 1000);

    await resetDatabase();
    const full = new Poller({ source: new FixtureLogSource(chain), usdgAddress: USDG, startBlock: 0n,
      blockRange: RANGE, maxBlockRange: RANGE, tokenReader: fixtureTokenReader });
    await full.syncToHead();
    const fullShape = await snapshotOf();
    const fullFees = await feeHoursFrom(settled);
    const fullSwaps = await prisma.swapEvent.count();

    await resetDatabase();
    const source = new FixtureLogSource(chain);
    const windowed = new Poller({ source, usdgAddress: USDG, startBlock: 0n, blockRange: RANGE,
      maxBlockRange: RANGE, tokenReader: fixtureTokenReader, swapWindowSeconds: WINDOW_S });
    const passes = await windowed.syncToHead();

    expect(passes.some((p) => p.structureOnly)).toBe(true);
    expect(passes[passes.length - 1].caughtUp).toBe(true);

    // Old swaps were not read...
    const oldest = await prisma.swapEvent.aggregate({ _min: { blockTime: true } });
    const margin = RANGE * FIXTURE_BLOCK_SECONDS * 1000;
    expect(oldest._min.blockTime!.getTime()).toBeGreaterThanOrEqual(windowStart.getTime() - margin);
    expect(await prisma.swapEvent.count()).toBeLessThan(fullSwaps);

    // ...but every pool and every liquidity event was, so depth is the same,
    const shape = await snapshotOf();
    expect(shape.pools).toEqual(fullShape.pools);
    expect(shape.liquidity).toBe(fullShape.liquidity);
    expect(shape.state).toEqual(fullShape.state);
    expect(shape.state.some((r) => Number(r.tvl) > 0)).toBe(true);

    // ...and the fee hours inside the window are byte-identical to a full read.
    const fees = await feeHoursFrom(settled);
    expect(fees.length).toBeGreaterThan(20);
    expect(fees).toEqual(fullFees);
  });

  it('records an old pool\'s tokens without reading them, and reads them on first swap', async () => {
    // Hundreds of thousands of launches on this chain never traded again;
    // four contract reads each was most of a structure pass.
    await resetDatabase();
    const address = '0x00000000000000000000000000000000000000cd';
    const calls: string[] = [];
    const reader = async (a: string) => {
      calls.push(a);
      return { address: a, symbol: 'LATE', name: 'Late Token', decimals: 9, totalSupply: 10n ** 18n };
    };
    await ensureTokens([address], new Date(), reader, { lazy: true });
    expect(calls).toEqual([]);
    const lazy = await prisma.token.findUniqueOrThrow({ where: { address } });
    expect(lazy.decimals).toBe(PENDING_DECIMALS);

    expect(await hydrateTokens([address], reader)).toBe(1);
    const read = await prisma.token.findUniqueOrThrow({ where: { address } });
    expect([read.symbol, read.decimals]).toEqual(['LATE', 9]);
    // Once read, never again.
    expect(await hydrateTokens([address], reader)).toBe(0);
    expect(calls).toEqual([address]);
  });

  it('values positions at the moment of the last swap read, not past it', async () => {
    // While the indexer crosses history for structure only, liquidity runs
    // months ahead of the last price it knows. Positions opened after that
    // price, valued at it, read as $1.76 trillion on the live site.
    await resetDatabase();
    await new Poller({ source: new FixtureLogSource(chain), usdgAddress: USDG, startBlock: 0n,
      blockRange: RANGE, maxBlockRange: RANGE, tokenReader: fixtureTokenReader }).syncToHead();
    const before = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, tvl_usd::text AS tvl FROM pool_state ORDER BY pool_id
    `;
    const pool = await prisma.pool.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const lastSwap = await prisma.swapEvent.aggregate({ _max: { blockNum: true } });
    // A huge position opened after the last swap the indexer has read.
    await prisma.liquidityEvent.create({
      data: {
        txHash: '0x' + 'f'.repeat(64), logIndex: 0, poolId: pool.id,
        blockNum: lastSwap._max.blockNum! + 1000n, blockTime: new Date(),
        tickLower: -887220, tickUpper: 887220, liquidityDelta: '1000000000000000000000000000000',
        amount0: 0, amount1: 0, owner: '0x0',
      },
    });
    const { rebuildPoolState } = await import('./aggregate');
    const { findAnchorPool } = await import('./discovery');
    const { CONTRACTS } = await import('../../lib/chain');
    await rebuildPoolState({
      weth: CONTRACTS.weth.toLowerCase(), usdg: USDG.toLowerCase(), wethDecimals: 18, usdgDecimals: 6,
      anchorPoolId: await findAnchorPool(USDG),
    });
    const after = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, tvl_usd::text AS tvl FROM pool_state ORDER BY pool_id
    `;
    expect(after).toEqual(before);
  });

  it('treats a token side the quote side cannot back as unknown depth', async () => {
    // A pool's token side is valued at a price its quote side set. Single-
    // sided positions worth ten thousand times the WETH beside them are a
    // figure about the last trade, not about the pool.
    await resetDatabase();
    await new Poller({ source: new FixtureLogSource(chain), usdgAddress: USDG, startBlock: 0n,
      blockRange: RANGE, maxBlockRange: RANGE, tokenReader: fixtureTokenReader }).syncToHead();
    const { rebuildPoolState } = await import('./aggregate');
    const { findAnchorPool } = await import('./discovery');
    const { CONTRACTS } = await import('../../lib/chain');
    const weth = CONTRACTS.weth.toLowerCase();
    const rebuild = async () => rebuildPoolState({
      weth, usdg: USDG.toLowerCase(), wethDecimals: 18, usdgDecimals: 6,
      anchorPoolId: await findAnchorPool(USDG),
    });
    const tvls = async () => Object.fromEntries((await prisma.$queryRaw<{ pool_id: string; tvl: number }[]>`
      SELECT pool_id, tvl_usd::float8 AS tvl FROM pool_state
    `).map((r) => [r.pool_id, r.tvl]));

    const target = (await prisma.$queryRaw<{ id: string; token0: string; token1: string; spacing: number;
      tick: number; liquidity: string }[]>`
      SELECT p.id, lower(p.token0) AS token0, lower(p.token1) AS token1, p.tick_spacing AS spacing,
             ps.tick, ps.liquidity::text AS liquidity
      FROM pools p JOIN pool_state ps ON ps.pool_id = p.id
      WHERE ps.tvl_usd > 0 AND ps.liquidity > 0
        AND (lower(p.token1) = ${weth}) <> (lower(p.token0) = ${weth})
        AND lower(p.token0) <> ${USDG.toLowerCase()} AND lower(p.token1) <> ${USDG.toLowerCase()}
      ORDER BY p.id LIMIT 1
    `)[0];
    expect(target).toBeDefined();
    // No supply, so the supply guard cannot be what catches it.
    const token = target.token1 === weth ? target.token0 : target.token1;
    await prisma.$executeRaw`UPDATE tokens SET total_supply = NULL WHERE lower(address) = ${token}`;
    await rebuild();
    const before = await tvls();

    // Not to be confused with a pool whose price traded out of its range:
    // it holds only the token, rightly, and is still counted — its LPs put
    // in both sides once. The fixture has one: its price is in no open range.
    const outOfRange = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM pool_state ps JOIN pools p ON p.id = ps.pool_id
      WHERE ps.tvl_usd > 0
        AND lower(p.token0) <> ${USDG.toLowerCase()} AND lower(p.token1) <> ${USDG.toLowerCase()}
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT tick_lower, tick_upper FROM liquidity_events le
            WHERE le.pool_id = ps.pool_id GROUP BY 1, 2 HAVING SUM(liquidity_delta) > 0
          ) r
          WHERE ps.tick >= r.tick_lower AND ps.tick < r.tick_upper
        )
    `;
    expect(outOfRange[0].n).toBeGreaterThan(0);

    // A range holding only the token side: above the price when the token is
    // token0, below it when it is token1.
    const s = target.spacing;
    const edge = Math.floor(887272 / s) * s;
    const [tickLower, tickUpper] = target.token1 === weth
      ? [(Math.floor(target.tick / s) + 1) * s, edge]
      : [-edge, Math.floor(target.tick / s) * s];
    const lastSwap = (await prisma.swapEvent.aggregate({ _max: { blockNum: true } }))._max.blockNum!;
    let n = 0;
    const addPosition = (liquidity: bigint) => prisma.liquidityEvent.create({
      data: {
        txHash: '0x' + 'e'.repeat(63) + String(n), logIndex: n++, poolId: target.id,
        blockNum: lastSwap, blockTime: new Date(), tickLower, tickUpper,
        liquidityDelta: liquidity.toString(), amount0: 0, amount1: 0, owner: '0x0',
      },
    });

    // As much again as the pool's active liquidity: counted, the pool deepens.
    const active = BigInt(target.liquidity);
    await addPosition(active);
    await rebuild();
    const counted = await tvls();
    expect(counted[target.id]).toBeGreaterThan(before[target.id]);

    // A hundred thousand times it — about a trillion dollars, far past the
    // quote behind it and still under the $1 quadrillion sanity bound, so
    // nothing but this rule can catch it: unknown, an em dash.
    await addPosition(active * 100_000n);
    await rebuild();
    const after = await tvls();
    expect(after[target.id]).toBe(0);
    // Nothing else moved.
    for (const id of Object.keys(before)) if (id !== target.id) expect(after[id]).toBe(before[id]);
  });

  it('asks for structure by topic, not for every log', () => {
    expect(new Set(STRUCTURE_TOPICS).size).toBe(5);
    // v4 Initialize and ModifyLiquidity, by their real selectors.
    expect(STRUCTURE_TOPICS).toContain('0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438');
    expect(STRUCTURE_TOPICS).toContain('0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec');
    // Never a Swap.
    expect(STRUCTURE_TOPICS).not.toContain('0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f');
  });
});
