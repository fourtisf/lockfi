/**
 * The snapshot's vaults: empty and honest with nothing deployed, and with
 * vaults, what is staked and by how many — and nothing that describes a
 * stream or a harvest, because the vault has neither: fees are credited per
 * share when collected and claimable at once.
 *
 * And no wallet in it: the snapshot is one public document served the same
 * to every visitor.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { Poller } from '../indexer/poller';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { buildSnapshot } from './snapshot';

const POOL_A1 = `v4:0x${'a1'.padStart(64, '0')}`;
const POOL_A2 = `v4:0x${'a2'.padStart(64, '0')}`;
const FIRST = '0x000000000000000000000000000000000000a001';
const SECOND = '0x000000000000000000000000000000000000a002';
const STAKER = '0x00000000000000000000000000000000005ea7ed';
const TREASURY = '0x00000000000000000000000000000000000000c3';
const AS_OF = new Date('2026-03-08T12:00:00.000Z');

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  await resetDatabase();
  const chain = buildFixtureChain();
  await new Poller({
    source: new FixtureLogSource(chain),
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  }).syncToHead();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const build = async () => (await buildSnapshot({ usdgAddress: USDG }))!;
const d = (v: string | number) => new Prisma.Decimal(v);

describe('snapshot vaults', () => {
  it('is empty with no vault deployed — never an invented one', async () => {
    const snapshot = await build();
    expect(snapshot.vaults).toEqual([]);
    expect(snapshot.featured.stakers).toBe(0);
  });

  it('reports what is staked, by how many, and the fee — and no stream or harvest', async () => {
    const vault = (address: string, poolId: string, stakers: number, usd: string) => ({
      poolId,
      address,
      totalStaked: d('3000000000000000000'),
      totalStakedUsd: d(usd),
      stakers,
      protocolFeeBps: 1000,
      depositsOpen: true,
      feesCollected0: d('6000000000000000000'),
      feesCollected1: d('1500000000000000'),
      protocolCut0: d('600000000000000000'),
      protocolCut1: d('150000000000000'),
      claimed0: d(0),
      claimed1: d(0),
      protocolPaid0: d(0),
      protocolPaid1: d(0),
      stakedSince: new Date(AS_OF.getTime() - 10 * 86_400_000),
      lastCollectedAt: new Date(AS_OF.getTime() - 3_600_000),
      updatedAt: AS_OF,
    });
    await prisma.vault.createMany({ data: [vault(FIRST, POOL_A1, 2, '3373.97'), vault(SECOND, POOL_A2, 5, '120.5')] });
    await prisma.stake.create({
      data: { wallet: STAKER, vaultId: POOL_A1, shares: d('1000'), claimed0: d('5'), claimed1: d('7'), updatedAt: AS_OF },
    });

    const snapshot = await build();
    expect(snapshot.vaults).toHaveLength(2);
    const first = snapshot.vaults.find((v) => v.address === FIRST)!;
    expect(first).toEqual({
      id: `vault-${POOL_A1}`,
      poolId: POOL_A1,
      address: FIRST,
      totalStakedUsd: 3373.97,
      stakers: 2,
      protocolFeeBps: 1000,
      // No stream, no harvest, nothing that could be late.
      rewardRate: 0,
      nextHarvestInSeconds: 0,
      harvestLagSeconds: null,
    });
    expect(snapshot.featured.stakers).toBe(7);
  });

  it('carries no wallet: the same public document for every visitor', async () => {
    const json = JSON.stringify(await build());
    expect(json).not.toContain(STAKER);
    expect(json).not.toContain(TREASURY);
  });
});
