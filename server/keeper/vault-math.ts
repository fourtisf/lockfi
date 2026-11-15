/**
 * The arithmetic behind a vault's live figures. Pure, so it is tested rather
 * than trusted.
 *
 * Why a vault's yield is not its pool's. The pool figure on the boards is
 * fees ÷ the pool's whole depth: an average over every LP, most of whom
 * concentrate their liquidity near the price and so earn many times more per
 * dollar than liquidity spread across every price. The vault holds exactly
 * that spread — one full-range position — so it earns the full-range rate,
 * not the average. On the ETH/USDG 0.05% pool the board read 133% while a
 * full-range position earned about 12% (measured on chain, 15 Nov 2026).
 *
 * The full-range rate needs no depth figure at all. Uniswap credits each
 * swap's LP fee to in-range liquidity as `fee × 2¹²⁸ ÷ liquidity` — the pool's
 * fee growth — and a full-range position is always in range, so per unit of
 * liquidity it earns exactly the sum of those steps. A unit of full-range
 * liquidity is worth `1/√P` of token0 plus `√P` of token1, which is `2√P` in
 * token1 at price P. So over any window:
 *
 *     yield = (G0 · P + G1) / 2¹²⁸ / (2√P)
 *
 * with G0, G1 the summed fee growth in each token. Unitless: no USD price,
 * no TVL, nothing that can be wrong in another table. Summing per-swap steps
 * with each swap's post-swap liquidity was checked against the PoolManager's
 * own fee-growth counter over 5,859 blocks on both vault pools: within
 * 0.002% on the ETH side and 0.4% on the much smaller USDG side.
 */

export const Q128 = 1n << 128n;
const Q96 = 2 ** 96;

/** Uniswap v4's ceiling on a fee in pips (100%). */
const MAX_PIPS = 1_000_000;

export interface SwapFee {
  /** Which currency came in: 0 or 1, or -1 when the signs do not say. */
  feeToken: 0 | 1 | -1;
  /** The gross input, fee included, in that currency's smallest unit. */
  amountIn: bigint;
  /** The LPs' part of the fee, after Uniswap's protocol fee. */
  lpFee: bigint;
}

/**
 * The LP fee of one v4 swap, from the event alone.
 *
 * Signs: a v4 Swap event carries the SWAPPER's deltas — negative is what the
 * swapper paid in. (Checked on chain: on the ETH/USDG pools, a negative
 * amount0 moves the price down, i.e. ETH was sold into the pool. The v3
 * event is the other way round.)
 *
 * Fee: the event's `fee` is the whole swap fee, Uniswap's protocol fee
 * included — 625 pips on a 500-pip pool whose protocol fee is 125. The
 * protocol's part never reaches LPs, so it is taken out:
 *
 *     swapFee  = protocolFee + lpFee − protocolFee·lpFee/10⁶   (v4-core)
 *     protocol = (swapFee − lpFee) · 10⁶ / (10⁶ − lpFee)
 *     LP fee   = amountIn · (swapFee − protocol) / 10⁶
 *
 * @param lpFeePips the pool's LP fee from its key (a vault's pool is
 *        hookless, so its fee is static).
 */
export function lpFeeOfSwap(amount0: bigint, amount1: bigint, swapFeePips: number, lpFeePips: number): SwapFee {
  let feeToken: 0 | 1 | -1 = -1;
  let amountIn = 0n;
  if (amount0 < 0n && amount1 >= 0n) {
    feeToken = 0;
    amountIn = -amount0;
  } else if (amount1 < 0n && amount0 >= 0n) {
    feeToken = 1;
    amountIn = -amount1;
  }
  if (feeToken === -1 || swapFeePips <= 0) return { feeToken, amountIn, lpFee: 0n };
  const lp = Math.max(0, Math.min(lpFeePips, MAX_PIPS - 1));
  const protocol = swapFeePips > lp ? Math.round(((swapFeePips - lp) * MAX_PIPS) / (MAX_PIPS - lp)) : 0;
  const lpPips = Math.max(0, swapFeePips - protocol);
  return { feeToken, amountIn, lpFee: (amountIn * BigInt(lpPips)) / BigInt(MAX_PIPS) };
}

/** One swap's step of the pool's fee growth: lpFee · 2¹²⁸ / liquidity. */
export function feeGrowthStep(lpFee: bigint, liquidity: bigint): bigint {
  return liquidity > 0n && lpFee > 0n ? (lpFee * Q128) / liquidity : 0n;
}

/**
 * What a full-range position earned per unit of value over a window, as a
 * fraction (0.01 = 1%), from the window's summed fee growth and the price
 * now. Fees earned in token0 are valued at today's price, as any yield is.
 */
export function fullRangeReturn(g0X128: bigint, g1X128: bigint, sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const growth0 = Number(g0X128) / Number(Q128);
  const growth1 = Number(g1X128) / Number(Q128);
  return (growth0 * sqrtP * sqrtP + growth1) / (2 * sqrtP);
}

/**
 * The token amounts `liquidity` of full-range liquidity holds at a price, as
 * plain numbers of WHOLE tokens — for display and USD maths only.
 */
export function fullRangeAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): [number, number] {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return [0, 0];
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity);
  return [L / sqrtP / 10 ** decimals0, (L * sqrtP) / 10 ** decimals1];
}

/** The price of one whole token0 in whole token1, from sqrtPriceX96. */
export function priceOf0In1(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const sqrtP = Number(sqrtPriceX96) / Q96;
  return sqrtP * sqrtP * 10 ** (decimals0 - decimals1);
}

/** A block's timestamp, linearly between two blocks whose times are known. */
export function interpolateTime(block: bigint, from: bigint, fromTime: number, to: bigint, toTime: number): number {
  if (to <= from) return toTime;
  const f = Number(block - from) / Number(to - from);
  return Math.round(fromTime + Math.min(1, Math.max(0, f)) * (toTime - fromTime));
}

/**
 * The first block at or after `targetTime`, by bisection on timestamps —
 * which on an Arbitrum chain never go backwards. About 25 reads for 30
 * million blocks.
 */
export async function blockAtTime(
  targetTime: number,
  head: bigint,
  headTime: number,
  timeOf: (block: bigint) => Promise<number>,
  lowest = 0n,
): Promise<bigint> {
  if (targetTime >= headTime) return head;
  let lo = lowest;
  let hi = head;
  if ((await timeOf(lo)) >= targetTime) return lo;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await timeOf(mid)) < targetTime) lo = mid;
    else hi = mid;
  }
  return hi;
}
