import { describe, expect, it } from 'vitest';
import { MAX_BINS, MIN_BINS, SHAPES, shapeWeights } from '../shapes';
import {
  largestRemainderBps,
  maxUsableTick,
  minUsableTick,
  shapeToTickBins,
  tokenShareOfBins,
  type ShapeToTicksInput,
} from './shaped';

const SPACINGS = [1, 10, 60, 200];
const RANGES: [number, number][] = [
  [-15, 15],
  [-2, 2],
  [-60, 10],
  [-5, 40],
  [-0.5, 0.5],
  [-99, 300],
];

function plan(over: Partial<ShapeToTicksInput> = {}) {
  const input: ShapeToTicksInput = {
    weights: shapeWeights('spot', 24),
    minPct: -15,
    maxPct: 15,
    currentTick: 12_345,
    tickSpacing: 60,
    tokenIsCurrency0: false,
    ...over,
  };
  const out = shapeToTickBins(input);
  if (!out.ok) throw new Error(out.reason);
  return out;
}

describe('shapeToTickBins', () => {
  /**
   * §3.2's rules, enforced on chain: a violation is a reverted mint. Every
   * shape, bin count, range, spacing and orientation is held to them.
   */
  it('always produces bins the shaper accepts', () => {
    for (const { id } of SHAPES) {
      for (const n of [MIN_BINS, 24, 37, MAX_BINS]) {
        for (const ts of SPACINGS) {
          for (const [minPct, maxPct] of RANGES) {
            for (const tokenIsCurrency0 of [true, false]) {
              for (const currentTick of [-200_001, 0, 12_345, 600_000]) {
                const { bins } = plan({ weights: shapeWeights(id, n), minPct, maxPct, tickSpacing: ts, tokenIsCurrency0, currentTick });
                const where = `${id} n=${n} ts=${ts} [${minPct},${maxPct}] c0=${tokenIsCurrency0} t=${currentTick}`;
                expect(bins.length, where).toBeGreaterThan(0);
                expect(bins.length, where).toBeLessThanOrEqual(60);
                expect(bins.reduce((a, b) => a + b.weightBps, 0), where).toBe(10_000);
                for (let i = 0; i < bins.length; i++) {
                  const b = bins[i];
                  expect(Number.isInteger(b.weightBps) && b.weightBps > 0, where).toBe(true);
                  expect(b.lower % ts === 0, where).toBe(true);
                  expect(b.upper % ts === 0, where).toBe(true);
                  expect(b.lower, where).toBeLessThan(b.upper);
                  expect(b.lower, where).toBeGreaterThanOrEqual(minUsableTick(ts));
                  expect(b.upper, where).toBeLessThanOrEqual(maxUsableTick(ts));
                  // Ascending and never overlapping.
                  if (i > 0) expect(b.lower, where).toBeGreaterThanOrEqual(bins[i - 1].upper);
                }
              }
            }
          }
        }
      }
    }
  });

  it('maps the range to the right ticks when the token is currency0', () => {
    // Token up 10% is the tick up ln(1.1)/ln(1.0001) ≈ 953; down 10% ≈ −1054.
    const { bins } = plan({ tokenIsCurrency0: true, tickSpacing: 1, currentTick: 0, minPct: -10, maxPct: 10 });
    expect(bins[0].lower).toBe(-1054);
    expect(bins[bins.length - 1].upper).toBe(953);
  });

  it('inverts the range when the token is currency1, as against native ETH', () => {
    // ETH per token: the token up 10% is the tick DOWN 953.
    const { bins } = plan({ tokenIsCurrency0: false, tickSpacing: 1, currentTick: 0, minPct: -10, maxPct: 10 });
    expect(bins[0].lower).toBe(-953);
    expect(bins[bins.length - 1].upper).toBe(1054);
  });

  it('reverses the weights with the ticks', () => {
    // A ramp, heaviest at the top of the TOKEN's price range.
    const ramp = Array.from({ length: 10 }, (_, i) => i + 1);
    const asC0 = plan({ weights: ramp, tokenIsCurrency0: true, tickSpacing: 1 }).bins;
    const asC1 = plan({ weights: ramp, tokenIsCurrency0: false, tickSpacing: 1 }).bins;
    // As currency0 the heaviest bin is the highest ticks; as currency1, the lowest.
    expect(asC0[asC0.length - 1].weightBps).toBeGreaterThan(asC0[0].weightBps);
    expect(asC1[0].weightBps).toBeGreaterThan(asC1[asC1.length - 1].weightBps);
    expect(asC1.map((b) => b.weightBps)).toEqual([...asC0.map((b) => b.weightBps)].reverse());
  });

  it('merges slices narrower than the tick spacing, keeping their weight', () => {
    // ±2% is about ±200 ticks; at spacing 200 sixty slices cannot survive.
    const out = plan({ weights: shapeWeights('curve', 60), minPct: -2, maxPct: 2, tickSpacing: 200, currentTick: 0 });
    expect(out.bins.length).toBeLessThan(5);
    expect(out.merged).toBe(60 - out.bins.length);
    expect(out.bins.reduce((a, b) => a + b.weightBps, 0)).toBe(10_000);
  });

  it('keeps every slice when the spacing is fine enough', () => {
    const out = plan({ weights: shapeWeights('bidask', 24), tickSpacing: 1 });
    expect(out.bins).toHaveLength(24);
    expect(out.merged).toBe(0);
  });

  it('mints one spacing-wide range when the whole range is narrower than a spacing', () => {
    const out = plan({ minPct: -0.1, maxPct: 0.1, tickSpacing: 200, currentTick: 50 });
    expect(out.bins).toEqual([{ lower: 0, upper: 200, weightBps: 10_000 }]);
  });

  it('refuses a range that cannot exist', () => {
    expect(shapeToTickBins({ weights: [1], minPct: -100, maxPct: 10, currentTick: 0, tickSpacing: 1, tokenIsCurrency0: true }).ok).toBe(false);
    expect(shapeToTickBins({ weights: [1], minPct: 5, maxPct: 5, currentTick: 0, tickSpacing: 1, tokenIsCurrency0: true }).ok).toBe(false);
    expect(shapeToTickBins({ weights: [], minPct: -5, maxPct: 5, currentTick: 0, tickSpacing: 1, tokenIsCurrency0: true }).ok).toBe(false);
  });

  it('caps a caller that passes more than 60 slices', () => {
    const out = plan({ weights: new Array(90).fill(1), tickSpacing: 1, minPct: -40, maxPct: 40 });
    expect(out.bins.length).toBe(60);
    expect(out.bins.reduce((a, b) => a + b.weightBps, 0)).toBe(10_000);
  });
});

describe('largestRemainderBps', () => {
  it('sums to exactly 10000 and hands the remainder to the largest fractions', () => {
    expect(largestRemainderBps([1 / 3, 1 / 3, 1 / 3])).toEqual([3334, 3333, 3333]);
    expect(largestRemainderBps([0.12345, 0.87655])).toEqual([1235, 8765]);
  });
  it('gives a zero weight nothing', () => {
    expect(largestRemainderBps([0, 1, 0, 1])).toEqual([0, 5000, 0, 5000]);
  });
});

describe('tokenShareOfBins', () => {
  const sqrtAt = (tick: number) => BigInt(Math.round(Math.pow(1.0001, tick / 2) * 2 ** 96));

  it('is all token for ranges wholly on the token side', () => {
    // Token is currency0: ranges above the price hold only currency0.
    expect(tokenShareOfBins([{ lower: 100, upper: 200, weightBps: 10_000 }], sqrtAt(0), true)).toBe(1);
    // Token is currency1: ranges below the price hold only currency1.
    expect(tokenShareOfBins([{ lower: -200, upper: -100, weightBps: 10_000 }], sqrtAt(0), false)).toBe(1);
  });

  it('is no token for ranges wholly on the ETH side', () => {
    expect(tokenShareOfBins([{ lower: -200, upper: -100, weightBps: 10_000 }], sqrtAt(0), true)).toBe(0);
  });

  it('splits a range centred on the price about evenly', () => {
    const share = tokenShareOfBins([{ lower: -1000, upper: 1000, weightBps: 10_000 }], sqrtAt(0), true);
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });

  it('weights each bin by its basis points', () => {
    const bins = [
      { lower: 100, upper: 200, weightBps: 2_500 },
      { lower: -200, upper: -100, weightBps: 7_500 },
    ];
    expect(tokenShareOfBins(bins, sqrtAt(0), true)).toBeCloseTo(0.25, 12);
    expect(tokenShareOfBins(bins, sqrtAt(0), false)).toBeCloseTo(0.75, 12);
  });
});
