import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  depositOptions,
  depositSides,
  depositUsd,
  displayOrder,
  formatAmountDown,
  parseAmount,
  plusMargin,
  toNumber,
  unlimited,
} from './deposit';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as const;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as const;
const TOKEN = `0x${'33'.repeat(20)}` as const;

describe('depositSides / depositOptions', () => {
  it('offers ETH, USDG, and both for a native ETH/USDG vault, ETH first', () => {
    const sides = depositSides({ currency0: zeroAddress, currency1: USDG }, [undefined, { symbol: 'USDG', decimals: 6, priceUsd: 1 }]);
    expect(sides[0]).toMatchObject({ symbol: 'ETH', decimals: 18, native: true, isEth: true });
    expect(sides[1]).toMatchObject({ symbol: 'USDG', decimals: 6, native: false, isEth: false, priceUsd: 1 });
    const options = depositOptions(sides);
    expect(options.map((o) => [o.route, o.label])).toEqual([
      [0, 'ETH'],
      [1, 'USDG'],
      ['both', 'ETH + USDG'],
    ]);
    // Each route says what it does: the single ones swap, both does not.
    expect(options[0].note).toMatch(/swapped into USDG/);
    expect(options[1].note).toMatch(/swapped into ETH/);
    expect(options[2].note).toMatch(/nothing is swapped/);
  });

  it('puts a WETH side first when it is currency1, and pays it in ETH on its own', () => {
    const sides = depositSides({ currency0: TOKEN, currency1: WETH }, [{ symbol: 'TKN', decimals: 9 }, undefined]);
    expect(sides[1]).toMatchObject({ symbol: 'WETH', native: false, isEth: true, decimals: null });
    expect(depositOptions(sides).map((o) => o.label)).toEqual(['ETH', 'TKN', 'WETH + TKN']);
    expect(displayOrder(sides).map((s) => s.symbol)).toEqual(['WETH', 'TKN']);
  });

  it('leaves decimals unknown until read, rather than assuming 18', () => {
    const [, other] = depositSides({ currency0: zeroAddress, currency1: TOKEN }, [undefined, undefined]);
    expect(other.decimals).toBeNull();
    expect(parseAmount('1', other.decimals)).toBeNull();
  });
});

describe('parseAmount / formatAmountDown', () => {
  it('parses to smallest units at the token’s own decimals', () => {
    expect(parseAmount('12.5', 6)).toBe(12_500_000n);
    expect(parseAmount('.5', 18)).toBe(5n * 10n ** 17n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
  });

  it('refuses what is not an amount, or has more places than the token', () => {
    for (const bad of ['', '.', '-1', '1e3', '1.2.3', 'abc']) expect(parseAmount(bad, 6)).toBeNull();
    expect(parseAmount('0.0000001', 6)).toBeNull();
  });

  it('formats rounding DOWN, so a Max never offers what the wallet does not have', () => {
    expect(formatAmountDown(1_999_999n, 6, 2)).toBe('1.99');
    expect(formatAmountDown(116_899_999_999_999_999n, 18, 4)).toBe('0.1168');
    expect(formatAmountDown(5_000_000n, 6, 2)).toBe('5');
    expect(formatAmountDown(0n, 6, 2)).toBe('0');
  });

  it('round-trips', () => {
    expect(toNumber(parseAmount('1234.567891', 6)!, 6)).toBeCloseTo(1234.567891, 9);
  });
});

describe('matching the other side', () => {
  it('asks the vault with a stand-in that is never the limit but cannot overflow', () => {
    expect(unlimited(6)).toBe(10n ** 18n);
    // Within uint128 liquidity even at the full-range sqrt price extremes:
    expect(unlimited(18) < 2n ** 128n).toBe(true);
  });

  it('allows the matched side 0.5% more, rounded up', () => {
    expect(plusMargin(1_000_000n)).toBe(1_005_000n);
    expect(plusMargin(1n)).toBe(2n);
    expect(plusMargin(0n)).toBe(0n);
  });
});

describe('depositUsd', () => {
  it('sums both sides at their prices', () => {
    expect(depositUsd([{ amount: 0.01, priceUsd: 1800 }, { amount: 18, priceUsd: 1 }])).toBeCloseTo(36, 9);
  });

  it('is unknown when a side with an amount has no price — never valued at zero', () => {
    expect(depositUsd([{ amount: 1, priceUsd: null }])).toBeNull();
    expect(depositUsd([{ amount: 0, priceUsd: null }, { amount: 5, priceUsd: 1 }])).toBe(5);
  });
});
