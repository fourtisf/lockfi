/**
 * Launchpad classification, now set-based.
 *
 * It was one UPDATE per pool on every pass — thousands of round trips a pass
 * on the real chain. The behaviour must not have moved with the rewrite:
 * pools on a configured launchpad hook are not stakeable and their tokens
 * carry the launchpad's name; every other pool is stakeable (§4).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOOK = '0x00000000000000000000000000000000000000c4';
const OTHER_HOOK = '0x00000000000000000000000000000000000000c5';
// Read when discovery.ts loads, so set before it is imported.
process.env.LAUNCHPAD_HOOKS = `Pons:${HOOK}`;

const { prisma } = await import('../db');
const { isReachable, resetDatabase } = await import('../test/db');
const { classifyPools } = await import('./discovery');

const T = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL.');
  await resetDatabase();
  for (const n of [1, 2, 3, 4]) {
    await prisma.token.create({ data: { address: T(n), symbol: `T${n}`, name: `T${n}`, decimals: 18, firstSeen: new Date() } });
  }
  const pool = (id: string, token0: string, hooks: string | null, stakeable: boolean) =>
    prisma.pool.create({
      data: {
        id, address: id, chainId: 4663, token0, token1: T(4), feeTier: 3000, tickSpacing: 60,
        hooks, protocol: 'v4', createdBlock: 1n, createdAt: new Date(), stakeable,
      },
    });
  await pool('v4:launch', T(1), HOOK, true);
  await pool('v4:plain', T(2), null, false);
  await pool('v4:other', T(3), OTHER_HOOK, false);
});

afterAll(async () => {
  delete process.env.LAUNCHPAD_HOOKS;
  await prisma.$disconnect();
});

describe('classifyPools', () => {
  it('holds launchpad pools back from staking and frees every other pool', async () => {
    expect(await classifyPools()).toBe(3);
    const stakeable = Object.fromEntries(
      (await prisma.pool.findMany()).map((p) => [p.id, p.stakeable]),
    );
    expect(stakeable).toEqual({ 'v4:launch': false, 'v4:plain': true, 'v4:other': true });
  });

  it('names the launchpad on the launchpad pool’s token only', async () => {
    const launchpads = Object.fromEntries(
      (await prisma.token.findMany()).map((t) => [t.symbol, t.launchpad]),
    );
    expect(launchpads.T1).toBe('Pons');
    expect(launchpads.T2).toBeNull();
    expect(launchpads.T3).toBeNull();
  });

  it('changes nothing the second time', async () => {
    expect(await classifyPools()).toBe(0);
  });
});
