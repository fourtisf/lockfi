import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  GAS_RESERVE_WEI,
  ethValueAt,
  formatEthDown,
  lossBps,
  maxSpendableWei,
  minusSlippage,
  parseEthInput,
  sharesForPct,
  sqrtPriceBounds,
  swapAmountForShare,
  txDeadline,
  v4PoolId,
  weiToNumber,
  zapStakeSwapAmount,
} from './tx';

describe('txDeadline', () => {
  it('is a unix timestamp ten minutes out, not a block number (§2)', () => {
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(txDeadline(now)).toBe(BigInt(now / 1000 + 600));
  });
});

describe('minusSlippage', () => {
  it('takes 0.5% off, rounding down', () => {
    expect(minusSlippage(10_000n)).toBe(9_950n);
    expect(minusSlippage(199n)).toBe(198n); // 198.005 → 198
    expect(minusSlippage(0n)).toBe(0n);
  });
});

describe('swapAmountForShare', () => {
  const A = parseEther('1');

  it('swaps a hair over half for a full-range vault, to cover the fee', () => {
    // s = A / (2 − f). At 0.30%: 1 / 1.997.
    const s = zapStakeSwapAmount(A, 3000);
    expect(Number(s) / 1e18).toBeCloseTo(1 / 1.997, 9);
    expect(s).toBeGreaterThan(A / 2n);
  });

  it('is exactly half with no fee', () => {
    expect(zapStakeSwapAmount(A, 0)).toBe(A / 2n);
  });

  it('leaves equal value on both sides after the fee', () => {
    for (const fee of [100, 500, 3000, 10_000]) {
      for (const share of [0.1, 0.37, 0.5, 0.9]) {
        const s = Number(swapAmountForShare(A, share, fee)) / 1e18;
        const kept = 1 - s;
        const bought = s * (1 - fee / 1e6);
        expect(bought / (kept + bought)).toBeCloseTo(share, 5);
      }
    }
  });

  it('swaps nothing for a zero share and everything for a full one', () => {
    expect(swapAmountForShare(A, 0, 3000)).toBe(0n);
    expect(swapAmountForShare(A, 1, 3000)).toBe(A);
    expect(swapAmountForShare(0n, 0.5, 3000)).toBe(0n);
  });

  it('never swaps more than the input', () => {
    expect(swapAmountForShare(A, 0.999999, 999_999)).toBeLessThanOrEqual(A);
  });
});

describe('ethValueAt', () => {
  const Q96 = 2n ** 96n;

  it('values the token side at the pool price, whichever side ETH is', () => {
    // price = token1 per token0 = 4 (sqrt 2): with ETH as currency0, 8 token1 is 2 ETH.
    expect(ethValueAt(1n * 10n ** 18n, 8n * 10n ** 18n, 2n * Q96, 0)).toBe(3n * 10n ** 18n);
    // With ETH as currency1, 1 token0 is 4 ETH.
    expect(ethValueAt(1n * 10n ** 18n, 1n * 10n ** 18n, 2n * Q96, 1)).toBe(5n * 10n ** 18n);
  });

  it('is zero with no price', () => {
    expect(ethValueAt(1n, 1n, 0n, 0)).toBe(0n);
  });
});

describe('lossBps', () => {
  it('measures what a zap lost to its own swap', () => {
    expect(lossBps(parseEther('1'), parseEther('0.97'))).toBe(300);
    expect(lossBps(parseEther('1'), parseEther('1.01'))).toBe(0);
    expect(lossBps(0n, 0n)).toBe(0);
  });
});

describe('maxSpendableWei', () => {
  it('keeps the gas reserve back', () => {
    expect(maxSpendableWei(parseEther('1'))).toBe(parseEther('1') - GAS_RESERVE_WEI);
  });
  it('is zero, not negative, for a balance under the reserve', () => {
    expect(maxSpendableWei(GAS_RESERVE_WEI / 2n)).toBe(0n);
  });
});

describe('parseEthInput', () => {
  it('reads plain decimals', () => {
    expect(parseEthInput('1.5')).toBe(parseEther('1.5'));
    expect(parseEthInput(' .25 ')).toBe(parseEther('0.25'));
    expect(parseEthInput('3')).toBe(parseEther('3'));
  });
  it('refuses what is not an amount', () => {
    for (const bad of ['', '.', '-1', '1e3', 'abc', '1.2.3', '0.0000000000000000001']) {
      expect(parseEthInput(bad), bad).toBeNull();
    }
  });
});

describe('formatEthDown', () => {
  it('rounds down, never up — a Max must be spendable', () => {
    expect(formatEthDown(parseEther('1.23459'), 4)).toBe('1.2345');
    expect(formatEthDown(parseEther('2'), 4)).toBe('2');
    expect(formatEthDown(0n)).toBe('0');
  });
});

describe('sharesForPct', () => {
  it('is the whole balance at 100%, with no rounding dust left behind', () => {
    expect(sharesForPct(123_456_789n, 100)).toBe(123_456_789n);
  });
  it('scales part withdrawals', () => {
    expect(sharesForPct(1000n, 25)).toBe(250n);
    expect(sharesForPct(1000n, 0)).toBe(0n);
  });
});

describe('sqrtPriceBounds', () => {
  it('allows at least ±0.5% of PRICE, which is about ±0.25% of sqrt price', () => {
    const sqrtP = 2n ** 96n; // price 1
    const { min, max } = sqrtPriceBounds(sqrtP);
    const pMin = (Number(min) / 2 ** 96) ** 2;
    const pMax = (Number(max) / 2 ** 96) ** 2;
    expect(pMin).toBeLessThanOrEqual(0.995);
    expect(pMin).toBeGreaterThan(0.994);
    expect(pMax).toBeGreaterThanOrEqual(1.005);
    expect(pMax).toBeLessThan(1.006);
  });
});

describe('v4PoolId', () => {
  it('takes the bytes32 after v4:', () => {
    const id = `0x${'ab'.repeat(32)}`;
    expect(v4PoolId(`v4:${id.toUpperCase().replace('0X', '0x')}`)).toBe(id);
  });
  it('is null for v3 and simulated pools', () => {
    expect(v4PoolId('v3:0x1234')).toBeNull();
    expect(v4PoolId('pons')).toBeNull();
  });
});

describe('weiToNumber', () => {
  it('converts without losing the whole part', () => {
    expect(weiToNumber(parseEther('1234.5'))).toBeCloseTo(1234.5, 12);
    expect(weiToNumber(1_500_000n, 6)).toBe(1.5);
  });
});
