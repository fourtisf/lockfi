/**
 * A token read that nobody answered is not a token's facts.
 *
 * readToken turns every failed read into a fallback — a made-up ticker,
 * "Unknown token", 18 decimals — and those used to be written for good,
 * whether the contract had answered with a revert or every endpoint had
 * simply refused the request. Decimals are an input to every price, so a
 * 6-decimal token read during a rate-limited burst was priced 10^12 too high
 * from then on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { PENDING_DECIMALS, ensureTokens, hydrateTokens, networkFailure, refreshSupplies, type TokenFacts } from './discovery';

const TOKEN = '0x00000000000000000000000000000000000000ab';

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('networkFailure', () => {
  it('knows a read nobody answered from a contract that answered badly', () => {
    for (const m of [
      'symbol(0x..) failed on all 4 endpoints:\n  a: HTTP request failed.\n  b: The request took too long to respond.',
      'x failed:\n  a: Too Many Requests',
      'x failed:\n  a: RPC Request failed. status 429',
      'fetch failed',
      'x: 503 Service Unavailable',
    ]) {
      expect(networkFailure(m), m).toBe(true);
    }
    for (const m of [
      'The contract function "decimals" reverted.',
      'The contract function "symbol" returned no data ("0x").',
      'Position `96` is out of bounds',
      'execution reverted',
    ]) {
      expect(networkFailure(m), m).toBe(false);
    }
  });
});

describe('a token whose reads failed on every endpoint', () => {
  const unreachable = async (address: string): Promise<TokenFacts> => ({
    address,
    symbol: 'AB…AB',
    name: 'Unknown token',
    decimals: 18,
    totalSupply: null,
    transient: true,
  });
  const answers = async (address: string): Promise<TokenFacts> => ({
    address,
    symbol: 'USDX',
    name: 'Dollar X',
    decimals: 6,
    totalSupply: 10n ** 12n,
  });

  it('stays pending through hydration, and is read for real next time', async () => {
    await ensureTokens([TOKEN], new Date(), answers, { lazy: true });
    expect(await hydrateTokens([TOKEN], unreachable)).toBe(0);
    const still = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(still.decimals).toBe(PENDING_DECIMALS);
    expect(still.symbol).toBe('');

    expect(await hydrateTokens([TOKEN], answers)).toBe(1);
    const read = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect([read.symbol, read.decimals]).toEqual(['USDX', 6]);
  });

  it('is recorded pending when first seen, not with made-up facts', async () => {
    await ensureTokens([TOKEN], new Date(), unreachable);
    const row = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(row.decimals).toBe(PENDING_DECIMALS);
    expect(row.symbol).toBe('');
  });
});

describe('refreshing supplies', () => {
  it('does not let a token that reports no supply hold the queue', async () => {
    const SILENT = '0x00000000000000000000000000000000000000cd';
    const facts = (address: string, totalSupply: bigint | null): TokenFacts => ({
      address, symbol: 'T', name: 'T', decimals: 18, totalSupply,
    });
    await ensureTokens([SILENT, TOKEN], new Date('2026-11-01T00:00:00Z'), async (a) => facts(a, null));
    await prisma.token.update({ where: { address: SILENT }, data: { supplyReadAt: null } });
    await prisma.token.update({ where: { address: TOKEN }, data: { supplyReadAt: new Date('2026-11-01T00:00:00Z') } });

    const asked: string[] = [];
    const read = async (a: string) => {
      asked.push(a);
      return facts(a, a === TOKEN ? 10n ** 24n : null);
    };
    const now = new Date('2026-11-02T00:00:00Z');
    await refreshSupplies(now, { limit: 1, read });
    await refreshSupplies(now, { limit: 1, read });
    expect(asked).toEqual([SILENT, TOKEN]);
    const row = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(row.totalSupply?.toFixed()).toBe((10n ** 24n).toString());
  });
});
