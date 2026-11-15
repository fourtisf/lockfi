import { describe, expect, it } from 'vitest';
import { CONTRACTS } from './chain';
import { DYNAMIC_FEE_FLAG, feeTierLabel, feeTokensLabel, pairLabel, poolContracts } from './pair';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as const;
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4' as const;
const weth = { address: CONTRACTS.weth, symbol: 'WETH' } as never;
const cashcat = { address: CASHCAT, symbol: 'CASHCAT' } as never;
const key = (c0: `0x${string}`, c1: `0x${string}`, fee: number) => ({ currency0: c0, currency1: c1, fee, tickSpacing: 1, hooks: ZERO });

describe('pairLabel', () => {
  it('names the native ETH/USDG vault pools ETH / USDG, not WETH / WETH', () => {
    const pool = { token: weth, quote: 'USDG' as const, key: key(ZERO, USDG, 460) };
    expect(pairLabel(pool)).toBe('ETH / USDG');
    expect(feeTokensLabel(pool)).toBe('ETH and USDG');
  });
  it('names a memecoin against native ETH as TOKEN / ETH', () => {
    expect(pairLabel({ token: cashcat, quote: 'ETH', key: key(ZERO, CASHCAT, 20000) })).toBe('CASHCAT / ETH');
  });
  it('keeps WETH where the pool holds WETH', () => {
    expect(pairLabel({ token: cashcat, quote: 'ETH', key: key(CASHCAT, CONTRACTS.weth.toLowerCase() as `0x${string}`, 3000) })).toBe('CASHCAT / WETH');
    expect(pairLabel({ token: weth, quote: 'USDG', key: undefined })).toBe('WETH / USDG');
  });
});

describe('feeTierLabel', () => {
  it('tells the two ETH/USDG vaults apart: 0.046% and 0.05%, not both 0.05%', () => {
    expect(feeTierLabel({ feeTierBps: 5, key: key(ZERO, USDG, 460) })).toBe('0.046%');
    expect(feeTierLabel({ feeTierBps: 5, key: key(ZERO, USDG, 500) })).toBe('0.05%');
  });
  it('prints whole and odd tiers as they are on chain', () => {
    expect(feeTierLabel({ feeTierBps: 200, key: key(ZERO, CASHCAT, 20000) })).toBe('2%');
    expect(feeTierLabel({ feeTierBps: 30, key: undefined })).toBe('0.3%');
  });
});

describe('dynamic fees', () => {
  it('names a hook-set fee "Dynamic", not 838.8608%', () => {
    expect(feeTierLabel({ feeTierBps: 83886, key: key(ZERO, CASHCAT, DYNAMIC_FEE_FLAG) })).toBe('Dynamic');
  });
});

describe('poolContracts', () => {
  it('lists USDG for the native ETH/USDG pools, never the WETH contract they do not hold', () => {
    expect(poolContracts({ token: weth, quote: 'USDG', key: key(ZERO, USDG, 460) })).toEqual([{ symbol: 'USDG', address: USDG }]);
  });
  it('lists the traded token first, then its quote', () => {
    const wethLower = CONTRACTS.weth.toLowerCase() as `0x${string}`;
    expect(poolContracts({ token: cashcat, quote: 'ETH', key: key(CASHCAT, wethLower, 3000) })).toEqual([
      { symbol: 'CASHCAT', address: CASHCAT },
      { symbol: 'WETH', address: wethLower },
    ]);
    expect(poolContracts({ token: cashcat, quote: 'ETH', key: key(ZERO, CASHCAT, 20000) })).toEqual([{ symbol: 'CASHCAT', address: CASHCAT }]);
  });
});
