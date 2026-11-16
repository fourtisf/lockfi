/**
 * Price maths. Pure, integer-exact where it can be, and tested — every number
 * the site displays passes through here.
 *
 * §4.3: prices are derived from `sqrtPriceX96` and pool reserves, anchored to
 * WETH, then to USD through the WETH/USDG pool. One anchor, one path, no
 * averaging across venues. There is no third-party price API in this file and
 * there must never be one.
 */

const Q96 = 2n ** 96n;
/** Enough headroom to keep the ratio exact before it becomes a float. */
const SCALE = 10n ** 36n;

/**
 * Price of token1 per token0, in human units.
 *
 *   raw = (sqrtPriceX96 / 2^96)^2      -- token1 per token0, both in wei
 *   human = raw * 10^(dec0 - dec1)
 *
 * The division is done once, at the end, on a value already scaled by 1e36,
 * so an 18-decimal pair does not lose precision on the way through.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  if (sqrtPriceX96 <= 0n) return 0;
  // (sqrt^2 * SCALE) / Q96^2 is token1-per-token0 in wei, scaled.
  let scaled = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / (Q96 * Q96);
  const shift = decimals0 - decimals1;
  if (shift > 0) scaled *= 10n ** BigInt(shift);
  else if (shift < 0) scaled /= 10n ** BigInt(-shift);
  return Number(scaled) / Number(SCALE);
}

/** The same ratio the other way round: token0 per token1. */
export function invertPrice(price: number): number {
  return price > 0 ? 1 / price : 0;
}

/**
 * A token's price in WETH, given the pool it trades in.
 *
 * `wethIsToken1` is the only thing that decides which way the ratio goes, and
 * getting it backwards silently doubles or halves every figure on the site —
 * hence one function, used everywhere, with a test for both orderings.
 */
export function tokenPriceInWeth(args: {
  sqrtPriceX96: bigint;
  tokenDecimals: number;
  wethDecimals: number;
  wethIsToken1: boolean;
}): number {
  const { sqrtPriceX96, tokenDecimals, wethDecimals, wethIsToken1 } = args;
  if (wethIsToken1) {
    // token is token0: the ratio already reads "WETH per token".
    return priceFromSqrtX96(sqrtPriceX96, tokenDecimals, wethDecimals);
  }
  // token is token1: the ratio reads "token per WETH", so invert it.
  return invertPrice(priceFromSqrtX96(sqrtPriceX96, wethDecimals, tokenDecimals));
}

/**
 * WETH in USD, from the WETH/USDG pool and nothing else.
 *
 * This is the single anchor for the whole site. If this pool is missing or
 * unpriced the honest answer is 0, which makes every USD figure downstream 0
 * and visible as broken — far better than quietly substituting a guess.
 */
export function wethPriceUsd(args: {
  sqrtPriceX96: bigint;
  wethDecimals: number;
  usdgDecimals: number;
  usdgIsToken1: boolean;
}): number {
  const { sqrtPriceX96, wethDecimals, usdgDecimals, usdgIsToken1 } = args;
  if (usdgIsToken1) {
    return priceFromSqrtX96(sqrtPriceX96, wethDecimals, usdgDecimals);
  }
  return invertPrice(priceFromSqrtX96(sqrtPriceX96, usdgDecimals, wethDecimals));
}

/** Smallest units to human units, without going through a float first. */
export function fromUnits(amount: bigint, decimals: number): number {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs - whole * base;
  // Keep 12 fractional digits: more than any USD figure needs, few enough to
  // stay inside a double's 15-16 significant digits for realistic balances.
  const keep = Math.min(decimals, 12);
  const fracScaled = decimals > keep ? frac / 10n ** BigInt(decimals - keep) : frac;
  const value = Number(whole) + Number(fracScaled) / 10 ** keep;
  return neg ? -value : value;
}

/**
 * The fee taken on one swap, in the input token's smallest unit.
 *
 * Uniswap charges the fee on the way in, so the emitted input amount already
 * includes it: fee = amountIn * pips / 1e6. v4's Swap event carries the pips
 * actually charged, which is what a dynamic-fee hook makes different from the
 * pool's static tier.
 */
export function feeFromSwap(amountIn: bigint, feePips: number): bigint {
  if (amountIn <= 0n || feePips <= 0) return 0n;
  return (amountIn * BigInt(feePips)) / 1_000_000n;
}

/** v4's dynamic-fee flag: a key carrying it has no fixed fee; its hook sets one per swap. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * The part of a v4 swap's fee that goes to LPs, in pips.
 *
 * The fee a v4 Swap event reports is the whole charge, Uniswap's protocol fee
 * included: 625 pips on a 500-pip pool whose protocol fee is 125. For a
 * static-fee pool the LPs' part is the key's fee, so it is that, never more
 * than was charged. A dynamic-fee pool has no fixed fee to compare with, and
 * what it charged is taken as the LPs' (no protocol fee is set on them here).
 */
export function lpFeePips(swapPips: number, tierPips: number | undefined): number {
  if (swapPips <= 0) return 0;
  if (tierPips === undefined || tierPips <= 0 || tierPips >= 1_000_000 || (tierPips & DYNAMIC_FEE_FLAG) !== 0) return swapPips;
  return Math.min(swapPips, tierPips);
}

/**
 * Which side of the swap came in. Pool-perspective signs: positive means the
 * token entered the pool, so that is the side the fee was taken in.
 */
export function swapInputSide(amount0: bigint, amount1: bigint): 0 | 1 | null {
  if (amount0 > 0n && amount1 <= 0n) return 0;
  if (amount1 > 0n && amount0 <= 0n) return 1;
  // Both positive or both negative is not a swap this indexer can attribute —
  // count it as neither rather than guessing, and leave the row at zero fees.
  return null;
}
