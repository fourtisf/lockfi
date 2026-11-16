/**
 * Rebalancing an out-of-range position (§31): withdraw it, then mint the same
 * shape again around today's price. This works out where the Positions page
 * should open: the old position's symmetric width and its bin count, within
 * what the page accepts.
 */

export const MIN_WIDTH_PCT = 2;
export const MAX_WIDTH_PCT = 60;

/**
 * The symmetric ± width, in percent, of a range spanning these ticks: the
 * price ratio across it is r = 1.0001^(upper − lower), and a range of ±w
 * around a price spans (1 + w) / (1 − w) = r, so w = (r − 1) / (r + 1).
 */
export function widthPctOfTicks(tickLower: number, tickUpper: number): number {
  const r = Math.pow(1.0001, Math.max(0, tickUpper - tickLower));
  const w = ((r - 1) / (r + 1)) * 100;
  return Math.min(MAX_WIDTH_PCT, Math.max(MIN_WIDTH_PCT, Math.round(w)));
}

export function rebalanceHref(poolId: string, tickLower: number, tickUpper: number, bins: number, minBins: number, maxBins: number): string {
  const b = Math.min(maxBins, Math.max(minBins, bins));
  const q = new URLSearchParams({ pool: poolId, width: String(widthPctOfTicks(tickLower, tickUpper)), bins: String(b), rebalance: '1' });
  return `/positions?${q.toString()}`;
}
