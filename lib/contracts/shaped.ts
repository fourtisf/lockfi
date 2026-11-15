/**
 * From the shape builder's bins to the tick ranges TidewellShaper mints.
 *
 * The page draws a shape as N equal slices of a ±percent range in the
 * TOKEN's price. Uniswap v4 knows ticks, a log scale of token1 per token0,
 * that only exist on multiples of the pool's tick spacing. Three things
 * follow, and each is handled here rather than discovered as a revert:
 *
 *   Orientation. When the token is currency1 (always, against native ETH,
 *   which sorts first as address(0)), the pool's price is ETH-per-token
 *   inverted: the token's price rising is the tick FALLING. The slices are
 *   reversed so ticks ascend.
 *
 *   Alignment. Slice edges are rounded to the nearest usable tick. Slices
 *   narrower than the spacing collapse to nothing; their weight moves to the
 *   neighbour most of the slice actually lay in. Weight is never lost.
 *
 *   Integers. The contract wants whole basis points summing to exactly
 *   10,000 and no zeros (§3.2), so weights go through largest remainder.
 *
 * Pure and float-free where it matters: ticks are integers, weights are
 * integers, and the only floats are the log of a percentage and the share of
 * value each side needs, neither of which is an amount sent.
 */
import { MAX_BINS } from '../shapes';

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** TickMath.minUsableTick: MIN_TICK rounded toward zero to the spacing. */
export function minUsableTick(tickSpacing: number): number {
  return Math.trunc(MIN_TICK / tickSpacing) * tickSpacing || 0;
}

export function maxUsableTick(tickSpacing: number): number {
  return Math.trunc(MAX_TICK / tickSpacing) * tickSpacing || 0;
}

/** One position: a tick range and its share of the deposit, as the contract's `Bin`. */
export interface TickBin {
  lower: number;
  upper: number;
  weightBps: number;
}

export interface ShapeToTicksInput {
  /** The page's shape weights, lowest token price first (lib/shapes.ts). */
  weights: number[];
  /** The range as percent of the token's current price, e.g. -15 and 15. */
  minPct: number;
  maxPct: number;
  /** The pool's current tick, from StateView.getSlot0. */
  currentTick: number;
  tickSpacing: number;
  /** Whether the priced token is the pool's currency0. */
  tokenIsCurrency0: boolean;
}

export type ShapeToTicksResult =
  | {
      ok: true;
      bins: TickBin[];
      /** Page bins that collapsed into a neighbour on the tick grid. */
      merged: number;
    }
  | { ok: false; reason: string };

const LN_TICK = Math.log(1.0001);

/**
 * Integer basis points summing to exactly `total`, by largest remainder:
 * floor every share, then hand the shortfall to the largest fractional parts
 * (ties to the earlier index). Negative or non-finite weights count as zero.
 */
export function largestRemainderBps(weights: number[], total = 10_000): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((a, w) => a + w, 0);
  if (!(sum > 0)) return clean.map(() => 0);
  const exact = clean.map((w) => (w / sum) * total);
  const out = exact.map((e) => Math.floor(e));
  let rest = total - out.reduce((a, v) => a + v, 0);
  const order = exact
    .map((e, i) => ({ frac: e - out[i], i }))
    .filter(({ i }) => clean[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0 && order.length > 0; k++, rest--) out[order[k % order.length].i] += 1;
  return out;
}

/** The tick offset that moves the TOKEN's price by `ratio` (1.1 = +10%). */
function tokenTickOffset(ratio: number): number {
  return Math.log(ratio) / LN_TICK;
}

/**
 * Convert the page's shape into tick bins for `mintShaped`.
 *
 * Returns ticks that are multiples of the spacing, ascending, contiguous and
 * non-overlapping, at most 60 of them, with integer weights summing to
 * exactly 10,000 and none of them zero.
 */
export function shapeToTickBins(input: ShapeToTicksInput): ShapeToTicksResult {
  const { weights, minPct, maxPct, currentTick, tickSpacing, tokenIsCurrency0 } = input;
  const n = weights.length;
  if (n === 0) return { ok: false, reason: 'The shape has no bins.' };
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) {
    return { ok: false, reason: 'This pool reports no usable tick spacing.' };
  }
  if (!Number.isFinite(currentTick)) return { ok: false, reason: 'The pool price is not known yet.' };
  if (!(minPct > -100)) return { ok: false, reason: 'Min must be above −100%.' };
  if (!(maxPct > minPct)) return { ok: false, reason: 'Max must be above Min.' };

  // Slice edges in the pool's ticks, unrounded, in the page's order (token
  // price ascending).
  const span = maxPct - minPct;
  const sign = tokenIsCurrency0 ? 1 : -1;
  const pageEdges: number[] = [];
  for (let k = 0; k <= n; k++) {
    const ratio = 1 + (minPct + (k * span) / n) / 100;
    pageEdges.push(currentTick + sign * tokenTickOffset(ratio));
  }

  // Ascending ticks. With the token as currency1 the page's top slice is the
  // pool's bottom range, so both edges and weights are reversed.
  const raw = tokenIsCurrency0 ? pageEdges : [...pageEdges].reverse();
  const w = tokenIsCurrency0 ? [...weights] : [...weights].reverse();

  const lo = minUsableTick(tickSpacing);
  const hi = maxUsableTick(tickSpacing);
  // `|| 0` turns a rounded −0 into 0 before it reaches an int24.
  const snap = (t: number) => Math.min(hi, Math.max(lo, Math.round(t / tickSpacing) * tickSpacing || 0));
  const edges = raw.map(snap);

  // Build the ranges; a slice whose two edges snapped to the same tick gives
  // its weight to the side most of it lay on.
  type Draft = { lower: number; upper: number; weight: number };
  const drafts: Draft[] = [];
  let carry = 0; // weight waiting for the next range up
  for (let j = 0; j < n; j++) {
    const weight = Number.isFinite(w[j]) && w[j] > 0 ? w[j] : 0;
    if (edges[j] < edges[j + 1]) {
      drafts.push({ lower: edges[j], upper: edges[j + 1], weight: weight + carry });
      carry = 0;
      continue;
    }
    const centre = (raw[j] + raw[j + 1]) / 2;
    const previous = drafts[drafts.length - 1];
    if (centre < edges[j] && previous) previous.weight += weight;
    else carry += weight;
  }
  if (carry > 0 && drafts.length > 0) drafts[drafts.length - 1].weight += carry;

  // The whole range is narrower than one tick spacing: mint it as the one
  // spacing-wide range that holds the current price.
  if (drafts.length === 0) {
    let lower = Math.floor(Math.min(raw[0], raw[n]) / tickSpacing) * tickSpacing;
    let upper = Math.ceil(Math.max(raw[0], raw[n]) / tickSpacing) * tickSpacing;
    if (upper <= lower) upper = lower + tickSpacing;
    lower = Math.max(lo, lower);
    upper = Math.min(hi, upper);
    if (upper <= lower) return { ok: false, reason: 'The range is outside what this pool can hold.' };
    drafts.push({ lower, upper, weight: 1 });
  }

  // At most 60 per transaction (§3.2): merge the lightest neighbouring pair
  // until it fits. The page already caps at 60, so this only guards callers.
  while (drafts.length > MAX_BINS) {
    let best = 0;
    for (let i = 1; i < drafts.length - 1; i++) {
      if (drafts[i].weight + drafts[i + 1].weight < drafts[best].weight + drafts[best + 1].weight) best = i;
    }
    const [a, b] = [drafts[best], drafts[best + 1]];
    drafts.splice(best, 2, { lower: a.lower, upper: b.upper, weight: a.weight + b.weight });
  }

  const bps = largestRemainderBps(drafts.map((d) => d.weight));
  const bins = drafts
    .map((d, i) => ({ lower: d.lower, upper: d.upper, weightBps: bps[i] }))
    .filter((b) => b.weightBps > 0);
  if (bins.length === 0) return { ok: false, reason: 'The shape has no weight to mint.' };

  return { ok: true, bins, merged: n - bins.length };
}

/** sqrtPriceX96 as a float sqrt price. For value shares only, never amounts. */
export function sqrtPriceToFloat(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / 2 ** 96;
}

/**
 * The share of a deposit's value that must be the TOKEN for these bins at
 * this price, 0–1. This is "split at mint": it decides how much ETH the
 * shaper swaps first.
 *
 * Per unit of liquidity a range [a, b] around price P holds
 *   amount0 = 1/√P − 1/√b   and   amount1 = √P − √a,
 * so in currency1 terms currency0's value is √P − P/√b. A range wholly above
 * the price is all currency0, one wholly below all currency1.
 */
export function tokenShareOfBins(bins: TickBin[], sqrtPriceX96: bigint, tokenIsCurrency0: boolean): number {
  const sp = sqrtPriceToFloat(sqrtPriceX96);
  let total = 0;
  let value0 = 0;
  for (const b of bins) {
    const sa = Math.pow(1.0001, b.lower / 2);
    const sb = Math.pow(1.0001, b.upper / 2);
    let f0: number;
    if (sp <= sa) f0 = 1;
    else if (sp >= sb) f0 = 0;
    else {
      const v0 = sp - (sp * sp) / sb;
      const v1 = sp - sa;
      f0 = v0 + v1 > 0 ? v0 / (v0 + v1) : 0.5;
    }
    total += b.weightBps;
    value0 += b.weightBps * f0;
  }
  if (total <= 0) return 0;
  const share0 = value0 / total;
  return tokenIsCurrency0 ? share0 : 1 - share0;
}
