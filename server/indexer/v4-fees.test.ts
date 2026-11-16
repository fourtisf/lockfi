/**
 * v4 swaps are counted from the pool's side, at the LPs' fee (§31).
 *
 * v4's Swap event carries the swapper's signs (negative = paid in) and a fee
 * that includes Uniswap's protocol fee. The indexer read both as if they were
 * v3's: fees on the token that left the pool, at the whole charge. These pin
 * the decode, the ingest and the migration that corrected the rows already
 * stored.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POOL_MANAGER_ABI } from '../chain/abi';
import { lpFeePips } from '../chain/price';
import { getSqrtRatioAtTick } from '../chain/tick-math';
import { decodePoolManagerLog } from './events';
import { planIngest } from './ingest';
import { runStartupTasks } from './tasks';

const { prisma } = await import('../db');
const { isReachable, resetDatabase } = await import('../test/db');

const POOL = `0x${'ab'.repeat(32)}` as `0x${string}`;
const SENDER = `0x${'0c'.repeat(20)}` as `0x${string}`;
const E18 = 10n ** 18n;

function v4Swap(amount0: bigint, amount1: bigint, fee: number) {
  const topics = encodeEventTopics({ abi: POOL_MANAGER_ABI, eventName: 'Swap', args: { id: POOL, sender: SENDER } });
  const data = encodeAbiParameters(
    parseAbiParameters('int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee'),
    [amount0, amount1, getSqrtRatioAtTick(0), 10n ** 20n, 0, fee],
  );
  // The shape the poller hands the decoder: a viem Log.
  return {
    address: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    topics,
    data,
    blockNumber: 10n,
    blockHash: `0x${'33'.repeat(32)}`,
    logIndex: 3,
    transactionIndex: 0,
    transactionHash: `0x${'11'.repeat(32)}`,
    removed: false,
  } as unknown as Parameters<typeof decodePoolManagerLog>[0];
}

describe('lpFeePips', () => {
  it('is the key fee on a static-fee pool, never more than was charged', () => {
    expect(lpFeePips(625, 500)).toBe(500); // 125 pips were Uniswap's
    expect(lpFeePips(500, 500)).toBe(500);
    expect(lpFeePips(400, 500)).toBe(400);
  });
  it('is what was charged on a dynamic-fee pool, or with no tier known', () => {
    expect(lpFeePips(7000, 0x800000)).toBe(7000);
    expect(lpFeePips(3000, undefined)).toBe(3000);
    expect(lpFeePips(0, 500)).toBe(0);
  });
});

describe('a v4 swap, read from the pool side', () => {
  // On chain: the swapper paid 2 token0 (−2e18) and received 1.9 token1.
  const log = v4Swap(-2n * E18, 19n * 10n ** 17n, 625);

  it('decodes to the pool perspective: positive is what entered', () => {
    const ev = decodePoolManagerLog(log, new Date('2026-11-16T00:00:00Z'));
    expect(ev?.kind).toBe('swap');
    if (ev?.kind !== 'swap') return;
    expect(ev.amount0).toBe(2n * E18);
    expect(ev.amount1).toBe(-19n * 10n ** 17n);
    expect(ev.feePips).toBe(625);
  });

  it('takes the LPs’ fee on the token that entered', () => {
    const ev = decodePoolManagerLog(log, new Date('2026-11-16T00:00:00Z'))!;
    const poolId = (ev as { poolId: string }).poolId;
    const plan = planIngest([ev], { chainId: 4663, sqrtPriceByPool: new Map([[poolId, getSqrtRatioAtTick(0)]]), feePipsByPool: new Map([[poolId, 500]]) });
    expect(plan.swaps).toHaveLength(1);
    expect(plan.swaps[0].feeToken).toBe(0);
    expect(plan.swaps[0].feeAmount).toBe((2n * E18 * 500n) / 1_000_000n); // 0.001 token0, not 0.0011875 token1
  });
});

describe('the startup task that corrects the stored rows', () => {
  const T = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

  beforeAll(async () => {
    if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL.');
    await resetDatabase();
    for (const n of [1, 2]) await prisma.token.create({ data: { address: T(n), symbol: `T${n}`, name: `T${n}`, decimals: 18, firstSeen: new Date() } });
    const pool = (id: string, address: string, feeTier: number, protocol: string) =>
      prisma.pool.create({
        data: { id, address, chainId: 4663, token0: T(1), token1: T(2), feeTier, tickSpacing: 10, hooks: null, protocol, createdBlock: 1n, createdAt: new Date(), stakeable: true },
      });
    await pool('v4:static', T(0x91), 500, 'v4');
    await pool('v4:dynamic', T(0x92), 0x800000, 'v4');
    await pool('v3:pool', T(0x93), 3000, 'v3');
    const swap = (poolId: string, logIndex: number, amount0: bigint, amount1: bigint, feeAmount: bigint, feeToken: number) =>
      prisma.swapEvent.create({
        data: {
          txHash: `0x${'22'.repeat(32)}`, logIndex, poolId, blockNum: 5n, blockTime: new Date('2026-11-10T00:00:00Z'),
          amount0: amount0.toString(), amount1: amount1.toString(), sqrtPrice: getSqrtRatioAtTick(0).toString(),
          liquidity: (10n ** 20n).toString(), tick: 0, feeAmount: feeAmount.toString(), feeToken, sender: SENDER,
        },
      });
    // As the old code stored them: the swapper's signs; the fee on the
    // positive (output) side at the whole charge (625 pips).
    await swap('v4:static', 1, -2n * E18, 19n * 10n ** 17n, (19n * 10n ** 17n * 625n) / 1_000_000n, 1);
    await swap('v4:dynamic', 2, 3n * E18, -4n * E18, (3n * E18 * 7000n) / 1_000_000n, 0);
    // v3 rows were always right and must not move.
    await swap('v3:pool', 3, 5n * E18, -4n * E18, (5n * E18 * 3000n) / 1_000_000n, 0);
    // What the migration leaves behind; the indexer runs it before its first pass.
    await prisma.$executeRawUnsafe(`INSERT INTO indexer_tasks (name) VALUES ('fix-v4-swap-signs')`);
    done = await runStartupTasks();
  });
  let done: string[] = [];
  afterAll(async () => {
    await resetDatabase();
  });

  const row = async (poolId: string) => {
    const [r] = await prisma.$queryRawUnsafe<{ a0: string; a1: string; fee: string; side: number }[]>(
      'SELECT amount0::text AS a0, amount1::text AS a1, fee_amount::text AS fee, fee_token AS side FROM swap_events WHERE pool_id = $1',
      poolId,
    );
    return r;
  };

  it('runs once, and leaves the fee hours to be rebuilt', async () => {
    expect(done[0]).toMatch(/: 2 rows/);
    const tasks = await prisma.$queryRawUnsafe<{ name: string }[]>('SELECT name FROM indexer_tasks ORDER BY name');
    expect(tasks.map((t) => t.name)).toEqual(['rebuild-fee-hours']);
    const before = await row('v4:static');
    expect(await runStartupTasks()).toEqual([]); // the task is gone: a second start changes nothing
    expect(await row('v4:static')).toEqual(before);
  });

  it('the migration only leaves the task: the correction is not made while the old indexer runs', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261116140000_v4_swap_signs/migration.sql'), 'utf8');
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/UPDATE\s+swap_events/i);
    expect(sql).toMatch(/'fix-v4-swap-signs'/);
  });

  it('flips a static pool’s row and charges the key fee on the input', async () => {
    const r = await row('v4:static');
    expect(r).toEqual({ a0: (2n * E18).toString(), a1: (-19n * 10n ** 17n).toString(), fee: ((2n * E18 * 500n) / 1_000_000n).toString(), side: 0 });
  });

  it('flips a dynamic pool’s row and moves its charge to the input side', async () => {
    const r = await row('v4:dynamic');
    expect(r.a0).toBe((-3n * E18).toString());
    expect(r.a1).toBe((4n * E18).toString());
    expect(r.side).toBe(1);
    expect(r.fee).toBe(((4n * E18 * 7000n) / 1_000_000n).toString());
  });

  it('leaves v3 rows as they were', async () => {
    const r = await row('v3:pool');
    expect(r).toEqual({ a0: (5n * E18).toString(), a1: (-4n * E18).toString(), fee: ((5n * E18 * 3000n) / 1_000_000n).toString(), side: 0 });
  });
});
