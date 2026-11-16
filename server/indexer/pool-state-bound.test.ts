/**
 * Pool state is rebuilt under a time limit, and a rebuild cut off by it
 * changes nothing and says so.
 *
 * On the live box the rebuild ran with no limit at all and held the indexer
 * for close to an hour: swaps were written, the cursor never moved, and the
 * health check called it stalled. A stale TVL for a while is a far smaller
 * loss than a frozen indexer, so the poller now rebuilds it bounded and
 * carries on when the bound is hit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { PoolStateTimeout, rebuildPoolState, type PriceAnchors } from './aggregate';

const ANCHORS: PriceAnchors = {
  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  wethDecimals: 18,
  usdgDecimals: 6,
  anchorPoolId: null,
};

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('rebuildPoolState with a time limit', () => {
  it('finishes normally inside it', async () => {
    await expect(rebuildPoolState(ANCHORS, { timeoutMs: 30_000, liveDays: 8 })).resolves.toBe(0);
  });

  it('is cancelled past it, as PoolStateTimeout, and leaves pool state as it was', async () => {
    // Another transaction holds pool_state, so the rebuild's write must wait —
    // exactly what a rebuild that cannot finish looks like from outside.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE pool_state IN ACCESS EXCLUSIVE MODE');
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;

    const started = Date.now();
    const outcome = await rebuildPoolState(ANCHORS, { timeoutMs: 500, liveDays: 8 }).then(
      () => 'finished',
      (error) => error,
    );
    release();
    await holder;

    expect(outcome).toBeInstanceOf(PoolStateTimeout);
    expect(String((outcome as Error).message)).toMatch(/cancelled; nothing changed/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await prisma.poolState.count()).toBe(0);
  });

  it('without a limit is not reported as a timeout when something else fails', async () => {
    await expect(rebuildPoolState({ ...ANCHORS, weth: "x'; DROP TABLE pools; --" })).rejects.not.toBeInstanceOf(PoolStateTimeout);
  });
});
