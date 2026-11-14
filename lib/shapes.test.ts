import { describe, expect, it } from 'vitest';
import { MAX_BINS, MIN_BINS, SHAPES, shapeWeights, weightsToBps } from './shapes';

const ALL_BIN_COUNTS = Array.from({ length: MAX_BINS - MIN_BINS + 1 }, (_, i) => MIN_BINS + i);

describe('shapeWeights', () => {
  it('returns one normalised weight per bin', () => {
    for (const { id } of SHAPES) {
      for (const bins of [MIN_BINS, 24, MAX_BINS]) {
        const w = shapeWeights(id, bins);
        expect(w).toHaveLength(bins);
        expect(w.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
        expect(w.every((v) => v > 0)).toBe(true);
      }
    }
  });

  it('spreads spot evenly', () => {
    const w = shapeWeights('spot', 12);
    expect(new Set(w.map((v) => v.toFixed(12))).size).toBe(1);
  });

  it('concentrates curve at the current price', () => {
    const w = shapeWeights('curve', 12);
    const middle = w[6];
    expect(middle).toBeGreaterThan(w[0]);
    expect(middle).toBeGreaterThan(w[11]);
  });

  it('puts bid-ask heaviest at the edges', () => {
    const w = shapeWeights('bidask', 12);
    expect(w[0]).toBeGreaterThan(w[6]);
    expect(w[11]).toBeGreaterThan(w[6]);
  });

  it('is symmetric for every shape', () => {
    for (const { id } of SHAPES) {
      const w = shapeWeights(id, 20);
      for (let i = 0; i < 10; i++) expect(w[i]).toBeCloseTo(w[19 - i], 12);
    }
  });
});

describe('weightsToBps', () => {
  /**
   * §3.2: TidewellShaper enforces sum(weightBps) == 10_000 on-chain. A rounding
   * bug here is a reverted mint, so every shape at every bin count is checked.
   */
  it('sums to exactly 10000 for every shape and every legal bin count', () => {
    for (const { id } of SHAPES) {
      for (const bins of ALL_BIN_COUNTS) {
        const bps = weightsToBps(shapeWeights(id, bins));
        expect(bps).toHaveLength(bins);
        expect(bps.reduce((a, v) => a + v, 0)).toBe(10_000);
      }
    }
  });

  it('returns whole basis points only, never a fraction', () => {
    for (const { id } of SHAPES) {
      for (const bins of [MIN_BINS, 37, MAX_BINS]) {
        for (const v of weightsToBps(shapeWeights(id, bins))) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThan(0);
        }
      }
    }
  });

  it('holds for a pathological weight set', () => {
    // Three bins that each round down: naive flooring would give 9999.
    const bps = weightsToBps([1 / 3, 1 / 3, 1 / 3]);
    expect(bps.reduce((a, v) => a + v, 0)).toBe(10_000);
  });
});

describe('bin limits', () => {
  it('caps a transaction at 60 bins (§3.2)', () => {
    expect(MAX_BINS).toBe(60);
  });
});
