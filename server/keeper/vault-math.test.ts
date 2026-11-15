import { describe, expect, it } from 'vitest';
import {
  Q128,
  blockAtTime,
  feeGrowthStep,
  fullRangeAmounts,
  fullRangeReturn,
  interpolateTime,
  lpFeeOfSwap,
  priceOf0In1,
} from './vault-math';

// Real swaps on Robinhood Chain's ETH/USDG pools, 15 Nov 2026.
const SQRT_P = 3366143111038999895281590n; // ETH ≈ $1,805
const L = 118876407481504139n;

describe('lpFeeOfSwap', () => {
  it('takes the fee on the side the swapper paid in — the NEGATIVE amount in a v4 event', () => {
    // ETH sold into the 0.05% pool: amount0 negative, the price went down.
    const f = lpFeeOfSwap(-44295449715306873n, 79909875n, 625, 500);
    expect(f.feeToken).toBe(0);
    expect(f.amountIn).toBe(44295449715306873n);
  });

  it("takes Uniswap's protocol fee out: 625 pips charged on a 500-pip pool pays LPs 500", () => {
    // protocol = (625 − 500)·10⁶ / (10⁶ − 500) = 125.06 → 125; LP = 625 − 125.
    const f = lpFeeOfSwap(-1_000_000_000_000n, 1n, 625, 500);
    expect(f.lpFee).toBe((1_000_000_000_000n * 500n) / 1_000_000n);
    // The 0.046% pool: 577 charged on 460 → protocol 117, LP 460.
    expect(lpFeeOfSwap(1n, -1_000_000n, 577, 460).lpFee).toBe(460n);
  });

  it('pays LPs the whole fee when there is no protocol fee', () => {
    expect(lpFeeOfSwap(-10_000_000n, 5n, 3000, 3000).lpFee).toBe(30_000n);
  });

  it('attributes nothing when the signs do not say which side came in', () => {
    expect(lpFeeOfSwap(5n, 5n, 625, 500)).toEqual({ feeToken: -1, amountIn: 0n, lpFee: 0n });
    expect(lpFeeOfSwap(-5n, -5n, 625, 500).feeToken).toBe(-1);
  });
});

describe('feeGrowthStep', () => {
  it('is the fee per unit of in-range liquidity, ×2¹²⁸', () => {
    expect(feeGrowthStep(1000n, 4000n)).toBe(Q128 / 4n);
    expect(feeGrowthStep(1000n, 0n)).toBe(0n);
  });
});

describe('fullRangeReturn', () => {
  it('is fees over the value of a unit of full-range liquidity, which is 2√P in token1', () => {
    // Each unit earned 0.001 of its own value, all of it in token1.
    const sqrtP = Number(SQRT_P) / 2 ** 96;
    const g1 = BigInt(Math.round(0.001 * 2 * sqrtP * 2 ** 64)) * (Q128 >> 64n);
    expect(fullRangeReturn(0n, g1, SQRT_P)).toBeCloseTo(0.001, 6);
  });

  it('values token0 fees at the price now, so the same value in either token is the same return', () => {
    const sqrtP = Number(SQRT_P) / 2 ** 96;
    const P = sqrtP * sqrtP;
    // 1 unit of token1 per unit of liquidity, or 1/P of token0: equal value.
    const g1 = Q128;
    const g0 = BigInt(Math.round((1 / P) * 2 ** 64)) * (Q128 >> 64n);
    expect(fullRangeReturn(g0, 0n, SQRT_P)).toBeCloseTo(fullRangeReturn(0n, g1, SQRT_P), 9);
  });

  it('is zero with no price', () => {
    expect(fullRangeReturn(Q128, Q128, 0n)).toBe(0);
  });
});

describe('prices and amounts', () => {
  it('reads ETH in USDG from the pool price, with 18 and 6 decimals', () => {
    expect(priceOf0In1(SQRT_P, 18, 6)).toBeCloseTo(1805.1, 0);
  });

  it('splits full-range liquidity into equal value on both sides', () => {
    const [eth, usdg] = fullRangeAmounts(L, SQRT_P, 18, 6);
    expect(eth * priceOf0In1(SQRT_P, 18, 6)).toBeCloseTo(usdg, 0);
    expect(usdg).toBeGreaterThan(5_000_000);
  });
});

describe('interpolateTime', () => {
  it('places a block linearly between two known ones, clamped to the range', () => {
    expect(interpolateTime(150n, 100n, 1_000, 200n, 2_000)).toBe(1_500);
    expect(interpolateTime(250n, 100n, 1_000, 200n, 2_000)).toBe(2_000);
    expect(interpolateTime(5n, 5n, 7, 5n, 9)).toBe(9);
  });
});

describe('blockAtTime', () => {
  it('finds the first block at or after a time, by bisection', async () => {
    // Ten blocks a second from block 0 at t = 0.
    const timeOf = async (b: bigint) => Math.floor(Number(b) / 10);
    expect(await blockAtTime(500, 100_000n, 10_000, timeOf)).toBe(5_000n);
    expect(await blockAtTime(20_000, 100_000n, 10_000, timeOf)).toBe(100_000n);
    expect(await blockAtTime(-5, 100_000n, 10_000, timeOf)).toBe(0n);
  });
});
