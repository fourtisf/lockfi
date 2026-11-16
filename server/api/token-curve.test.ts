/**
 * The token curve reader against a stand-in chain (§30, §31): it checks the
 * curve trades the token, prices from the reserves, and once the curve has
 * graduated finds the Uniswap pool and says whether a vault can hold it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_CA, TOKEN_LAUNCH } from '../../lib/site';

const chain = {
  graduated: false,
  hooks: '0x0000000000000000000000000000000000000000',
  fee: 10_000,
};
const HEAD = BigInt(TOKEN_LAUNCH!.launchBlock) + 1_000n;

const fake = {
  getBlockNumber: async () => HEAD,
  getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: 1_800_000_000n + blockNumber / 10n }),
  getBalance: async () => (chain.graduated ? 0n : 0n),
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'token') return TOKEN_CA;
    if (functionName === 'graduated') return chain.graduated;
    if (functionName === 'getReserves') return chain.graduated ? [0n, 0n] : [BigInt(TOKEN_LAUNCH!.virtualEthWei), BigInt(TOKEN_LAUNCH!.supply) * 10n ** 18n];
    throw new Error(`unexpected ${functionName}`);
  },
  getLogs: async (q: { event?: unknown; args?: { currency1?: string } }) => {
    if (!q.event) return []; // the curve: no trades yet
    // Native ETH (0x0) sorts first, so the token is currency1.
    if (q.args?.currency1 && chain.graduated) {
      return [{ blockNumber: HEAD - 10n, logIndex: 4, args: { id: `0x${'ee'.repeat(32)}`, fee: chain.fee, hooks: chain.hooks } }];
    }
    return [];
  },
};

vi.mock('../chain/client', () => ({ rpc: (fn: (c: typeof fake) => unknown) => fn(fake) }));
const { createTokenCurveReader } = await import('./token-curve');

beforeEach(() => {
  chain.graduated = false;
  chain.hooks = '0x0000000000000000000000000000000000000000';
  chain.fee = 10_000;
});

describe('createTokenCurveReader', () => {
  it('prices a curve with no trades at the launch reserves, verified', async () => {
    const v = await createTokenCurveReader(() => {})!.get(2000);
    expect(v?.graduated).toBe(false);
    expect(v?.verified).toBe(true);
    expect(v?.priceEth).toBeCloseTo(1.68 / 1e9, 18);
    expect(v?.priceUsd).toBeCloseTo((1.68 / 1e9) * 2000, 15);
    expect(v?.uniswapPool).toBeNull();
  });

  it('after graduation, finds the Uniswap pool and says a vault can hold it', async () => {
    chain.graduated = true;
    const v = await createTokenCurveReader(() => {})!.get(2000);
    expect(v?.graduated).toBe(true);
    expect(v?.priceEth).toBeNull();
    expect(v?.uniswapPool).toEqual({ id: `0x${'ee'.repeat(32)}`, fee: 10_000, hooks: '0x0000000000000000000000000000000000000000', vaultEligible: true });
  });

  it('says a vault cannot hold a graduation pool that runs a hook', async () => {
    chain.graduated = true;
    chain.hooks = '0x00000000000000000000000000000000000000c4';
    const v = await createTokenCurveReader(() => {})!.get(2000);
    expect(v?.uniswapPool?.vaultEligible).toBe(false);
  });
});
