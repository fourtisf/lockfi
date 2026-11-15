import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { contractCursorKey } from '../indexer/contracts';
import { isReachable, resetDatabase } from '../test/db';
import { HISTORY_LIMIT, isWalletAddress, walletHistory } from './wallet-history';

const VAULT = '0x901deabd094bd204cbe02854b1924e5ab4c41597';
const POOL = 'v4:0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982';
const ME = '0x00000000000000000000000000000000000000aa';
const SOMEONE = '0x00000000000000000000000000000000000000bb';
const deployment = [{ address: VAULT as `0x${string}`, poolId: POOL, deployedBlock: 1 }];

let n = 0;
async function event(kind: string, account: string, amount0: string, amount1: string, at: string) {
  n++;
  await prisma.contractEvent.create({
    data: {
      txHash: `0x${n.toString(16).padStart(64, '0')}`,
      logIndex: 0,
      contract: VAULT,
      source: 'vault',
      blockNum: BigInt(n),
      blockTime: new Date(at),
      kind,
      account,
      args: { amount0, amount1, liquidity: '1' },
    },
  });
}

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  await resetDatabase();
  await event('Deposited', ME, '10000000000000000', '18000000', '2026-11-15T10:00:00Z');
  await event('Deposited', SOMEONE, '99', '99', '2026-11-15T10:30:00Z');
  await event('Claimed', ME, '0', '300000', '2026-11-15T11:00:00Z');
  await event('Withdrawn', ME, '5000000000000000', '9100000', '2026-11-15T12:00:00Z');
  await event('FeesCollected', ME, '1', '1', '2026-11-15T12:00:00Z');
  await prisma.indexerCursor.create({
    data: { contract: contractCursorKey(VAULT), lastIndexedBlock: 9n, lastIndexedAt: new Date('2026-11-15T12:05:00Z'), updatedAt: new Date() },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('walletHistory', () => {
  it("sums one wallet's deposits, withdrawals and claims per vault — nobody else's", async () => {
    const h = await walletHistory(ME.toUpperCase().replace('0X', '0x'), deployment);
    expect(h.wallet).toBe(ME);
    expect(h.vaults).toEqual([
      {
        vault: VAULT,
        poolId: POOL,
        deposited0: '10000000000000000',
        deposited1: '18000000',
        withdrawn0: '5000000000000000',
        withdrawn1: '9100000',
        claimed0: '0',
        claimed1: '300000',
        firstDepositAt: '2026-11-15T10:00:00.000Z',
      },
    ]);
    expect(h.events.map((e) => e.kind)).toEqual(['Withdrawn', 'Claimed', 'Deposited']);
    expect(h.events.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(h.asOf).toBe('2026-11-15T12:05:00.000Z');
  });

  it('is empty for a wallet with no history, and with no vault deployed', async () => {
    expect((await walletHistory('0x00000000000000000000000000000000000000cc', deployment)).vaults).toEqual([]);
    expect(await walletHistory(ME, [])).toEqual({ wallet: ME, vaults: [], events: [], asOf: null });
  });

  it('refuses what is not an address', () => {
    expect(isWalletAddress('0x12')).toBe(false);
    expect(isWalletAddress("0x00000000000000000000000000000000000000aa' OR 1=1")).toBe(false);
    expect(isWalletAddress(ME)).toBe(true);
  });
});
