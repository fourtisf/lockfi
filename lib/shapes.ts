import type { ShapeId } from './data/types';

/**
 * Liquidity shapes are weight generators in the frontend, not contract modes
 * (§3.2). TidewellShaper takes whatever bins we hand it, so a new shape ships
 * without touching a contract.
 */
export const SHAPES: { id: ShapeId; label: string; hint: string }[] = [
  {
    id: 'spot',
    label: 'Spot',
    hint: 'Even liquidity across the range. Most fees at any price inside it.',
  },
  {
    id: 'curve',
    label: 'Curve',
    hint: 'Concentrated at the current price. Highest fees while it stays put, faster to leave range.',
  },
  {
    id: 'bidask',
    label: 'Bid-ask',
    hint: 'Heavy at the edges, light in the middle. Buys dips and sells rips; suits volatile tokens.',
  },
];

/** Max bins per transaction — past this, two transactions are cheaper (§3.2). */
export const MAX_BINS = 60;
export const MIN_BINS = 6;

/** Normalised bin weights, summing to 1. On-chain these become weightBps. */
export function shapeWeights(shape: ShapeId, bins: number): number[] {
  const raw: number[] = [];
  for (let i = 0; i < bins; i++) {
    const x = ((i + 0.5) / bins) * 2 - 1; // -1 … 1 across the range
    raw.push(shape === 'spot' ? 1 : shape === 'curve' ? Math.exp(-x * x * 4) : 0.15 + x * x);
  }
  const total = raw.reduce((a, v) => a + v, 0);
  return raw.map((v) => v / total);
}

/** Integer basis points summing to exactly 10_000, as the contract requires. */
export function weightsToBps(weights: number[]): number[] {
  const bps = weights.map((w) => Math.floor(w * 10_000));
  let drift = 10_000 - bps.reduce((a, v) => a + v, 0);
  for (let i = 0; drift > 0; i = (i + 1) % bps.length, drift--) bps[i] += 1;
  return bps;
}
