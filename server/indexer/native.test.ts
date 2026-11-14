/**
 * Uniswap v4 pools that hold native ETH.
 *
 * v4 names native ETH as the zero address, and most v4 ETH pairs use it
 * rather than WETH. The indexer recognised only WETH, so on the real chain
 * an ETH/USDG anchor could never be found: the site sat on "Looking for the
 * USD anchor" with every dollar figure waiting, however long it ran.
 *
 * Two things are proven here: a chain whose pools hold native ETH is priced
 * exactly as one holding WETH, and pools stored before the fix are corrected
 * in place without a re-sync.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  FixtureLogSource,
  NATIVE_POOLS,
  USDG,
  WETH,
  buildNativeEthChain,
  fixtureTokenReader,
} from '../test/fixture';
import { resolveUsdg } from './anchor';
import { adoptNativeEthPools, findAnchorPool } from './discovery';
import { NATIVE_CURRENCY, pricedCurrencies } from './events';
import { Poller } from './poller';

const ANCHOR_ID = `v4:${NATIVE_POOLS[0].id}`;
const PONS_ID = `v4:${NATIVE_POOLS[1].id}`;
const OTHER = '0x00000000000000000000000000000000000000aa';

async function sync(): Promise<void> {
  const chain = buildNativeEthChain();
  await new Poller({
    source: new FixtureLogSource(chain),
    // A fresh box: no anchor configured, so it has to be found.
    usdgAddress: null,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  }).syncToHead();
}

async function prices(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ pool_id: string; price: string }[]>`
    SELECT pool_id, price_usd::text AS price FROM pool_state
  `;
  return Object.fromEntries(rows.map((r) => [r.pool_id, Number(r.price)]));
}

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pricedCurrencies', () => {
  it('records native ETH as WETH, on either side, keeping positions', () => {
    expect(pricedCurrencies(NATIVE_CURRENCY, USDG)).toEqual([WETH, USDG.toLowerCase()]);
    expect(pricedCurrencies(OTHER, NATIVE_CURRENCY)).toEqual([OTHER, WETH]);
  });

  it('leaves ordinary pairs alone', () => {
    expect(pricedCurrencies(USDG, WETH)).toEqual([USDG.toLowerCase(), WETH]);
    expect(pricedCurrencies(OTHER, USDG)).toEqual([OTHER, USDG.toLowerCase()]);
  });

  it('leaves ETH against WETH alone, rather than making WETH against WETH', () => {
    expect(pricedCurrencies(NATIVE_CURRENCY, WETH)).toEqual([NATIVE_CURRENCY, WETH]);
  });
});

describe('a chain whose ETH pools hold native ETH', () => {
  it('finds the ETH/USDG pool as the USD anchor without being told', async () => {
    await resetDatabase();
    await sync();

    const pools = await prisma.pool.findMany({ orderBy: { id: 'asc' } });
    expect(pools.map((p) => p.token0)).toEqual([WETH, WETH]);
    // No placeholder token read off the zero address.
    expect(await prisma.token.findUnique({ where: { address: NATIVE_CURRENCY } })).toBeNull();

    const resolved = await resolveUsdg(null);
    expect(resolved.address).toBe(USDG.toLowerCase());
    expect(resolved.source).toBe('discovered');
    expect(await findAnchorPool(USDG)).toBe(ANCHOR_ID);
  });

  it('prices ETH at its market and a token through ETH', async () => {
    const p = await prices();
    // ETH at $2,500 off the ETH/USDG pool, and PONS at $0.5937 through it —
    // the fixture's prices, to within the tick spacing.
    expect(Math.abs(p[ANCHOR_ID] - 2500) / 2500).toBeLessThan(0.01);
    expect(Math.abs(p[PONS_ID] - 0.5937) / 0.5937).toBeLessThan(0.01);
  });
});

describe('pools stored before native ETH was understood', () => {
  it('are corrected in place and become priceable, with no re-sync', async () => {
    await resetDatabase();
    await sync();

    // Put the database back in the state the old decoder left: the zero
    // address as token0, and a placeholder token row for it.
    await prisma.token.create({
      data: {
        address: NATIVE_CURRENCY,
        symbol: '0000…0000',
        name: 'Unknown token',
        decimals: 18,
        firstSeen: new Date(),
      },
    });
    await prisma.pool.updateMany({ data: { token0: NATIVE_CURRENCY } });
    expect((await resolveUsdg(null)).address).toBeNull();

    expect(await adoptNativeEthPools(new Date(), fixtureTokenReader)).toBe(2);

    expect((await resolveUsdg(null)).address).toBe(USDG.toLowerCase());
    expect(await findAnchorPool(USDG)).toBe(ANCHOR_ID);
    expect(await prisma.token.findUnique({ where: { address: NATIVE_CURRENCY } })).toBeNull();
    // Idempotent: a second run finds nothing to do.
    expect(await adoptNativeEthPools(new Date(), fixtureTokenReader)).toBe(0);
  });

  it('leaves an ETH/WETH pool, and the token row it needs, alone', async () => {
    await resetDatabase();
    await sync();
    await prisma.token.create({
      data: { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18, firstSeen: new Date() },
    });
    await prisma.pool.update({
      where: { id: PONS_ID },
      data: { token0: NATIVE_CURRENCY, token1: WETH },
    });

    expect(await adoptNativeEthPools(new Date(), fixtureTokenReader)).toBe(0);
    const pool = await prisma.pool.findUniqueOrThrow({ where: { id: PONS_ID } });
    expect([pool.token0, pool.token1]).toEqual([NATIVE_CURRENCY, WETH]);
    expect(await prisma.token.findUnique({ where: { address: NATIVE_CURRENCY } })).not.toBeNull();
  });
});
