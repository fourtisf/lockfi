import { describe, expect, it } from 'vitest';
import type { Pool } from './data/types';
import { LP_FEE_SHARE, PREVIEW_BALANCE_ETH, dailyFromHalfDays, depositProblem, stakeQuote } from './stake';

const pool = (over: Partial<Pool> = {}): Pool =>
  ({
    tvlUsd: 1_000_000,
    feesWindowUsd: 70_000,
    feeWindowHours: 168,
    feeYield: { basis: 'trailing7d', pct: 364 },
    ...over,
  }) as Pool;

describe('stakeQuote', () => {
  it('takes the protocol cut from the fees, never the deposit', () => {
    // $10K into a $1M pool earning $70K a week: 0.99% of it, less 10%.
    const q = stakeQuote(pool(), 4, 2500);
    expect(q.depositUsd).toBe(10_000);
    expect(q.share).toBeCloseTo(10_000 / 1_010_000, 12);
    expect(q.weeklyWeth).toBeCloseTo((70_000 * q.share * LP_FEE_SHARE) / 2500, 12);
    expect(LP_FEE_SHARE).toBe(0.9);
  });

  it('scales a young pool’s window to a week rather than calling it one', () => {
    const young = stakeQuote(pool({ feesWindowUsd: 20_000, feeWindowHours: 48 }), 4, 2500);
    const full = stakeQuote(pool({ feesWindowUsd: 70_000 }), 4, 2500);
    expect(young.weeklyWeth).toBeCloseTo(full.weeklyWeth!, 12);
  });

  it('shows no figure under 24h of data (§7)', () => {
    expect(stakeQuote(pool({ feeYield: { basis: 'insufficient' } }), 1, 2500).weeklyWeth).toBeNull();
  });

  it('is zero for nothing deposited', () => {
    expect(stakeQuote(pool(), 0, 2500)).toEqual({ depositUsd: 0, share: 0, weeklyWeth: 0 });
  });
});

describe('depositProblem', () => {
  it('refuses empty and over-balance amounts', () => {
    expect(depositProblem(0)).toMatch(/Enter/);
    expect(depositProblem(Number.NaN)).toMatch(/Enter/);
    expect(depositProblem(PREVIEW_BALANCE_ETH + 0.01)).toMatch(/balance/);
    expect(depositProblem(PREVIEW_BALANCE_ETH)).toBeNull();
  });
});

describe('dailyFromHalfDays', () => {
  it('folds 14 half-days into 7 days, keeping the total', () => {
    const halves = Array.from({ length: 14 }, (_, i) => i + 1);
    const days = dailyFromHalfDays(halves);
    expect(days).toEqual([3, 7, 11, 15, 19, 23, 27]);
    expect(days.reduce((a, v) => a + v, 0)).toBe(halves.reduce((a, v) => a + v, 0));
  });
});
