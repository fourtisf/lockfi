/**
 * Uniswap tick maths, ported exactly.
 *
 * v4's `ModifyLiquidity` carries a liquidity delta but no token amounts (§4),
 * so the amounts have to be computed from the delta, the tick range and the
 * pool's price. Those amounts are what a TVL figure is made of, so the maths
 * is integer-exact rather than approximated: `getSqrtRatioAtTick` is the
 * TickMath constant table, and there is a test comparing every power-of-two
 * tick against sqrt(1.0001^t) * 2^96 computed independently — a mistyped
 * constant shows up there rather than as a wrong TVL on the site.
 */

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const MAX_U256 = 2n ** 256n - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** The magic constants are 2^128 / 1.0001^(2^i), as in TickMath.sol. */
const RATIOS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** sqrt(1.0001^tick) * 2^96, exactly as the pool computes it. */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new RangeError(`tick ${tick} out of range`);

  let ratio = (absTick & 0x1) !== 0 ? RATIOS[0] : Q128;
  for (let i = 1; i < RATIOS.length; i++) {
    if ((absTick & (1 << i)) !== 0) ratio = (ratio * RATIOS[i]) >> 128n;
  }
  if (tick > 0) ratio = MAX_U256 / ratio;

  // Round up, matching the Solidity: (ratio >> 32) + (ratio % 2^32 == 0 ? 0 : 1)
  const shifted = ratio >> 32n;
  return ratio % 2n ** 32n === 0n ? shifted : shifted + 1n;
}

/** L * (sqrtB - sqrtA) * Q96 / (sqrtA * sqrtB) — the token0 side. */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (lo <= 0n) return 0n;
  return (liquidity * Q96 * (hi - lo)) / hi / lo;
}

/** L * (sqrtB - sqrtA) / Q96 — the token1 side. */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  return (liquidity * (hi - lo)) / Q96;
}

/**
 * Token amounts a liquidity delta moves, given where the price sits relative
 * to the range. Below the range the position is all token0, above it all
 * token1, and inside it both — which is the whole reason a concentrated
 * position's value is not simply "half and half".
 *
 * The sign of `liquidityDelta` is carried through: a burn returns negatives,
 * so summing these over a pool's whole event history gives its reserves.
 */
export function amountsForLiquidity(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
}): { amount0: bigint; amount1: bigint } {
  const { sqrtPriceX96, tickLower, tickUpper, liquidityDelta } = args;
  if (liquidityDelta === 0n) return { amount0: 0n, amount1: 0n };

  const sign = liquidityDelta < 0n ? -1n : 1n;
  const L = liquidityDelta < 0n ? -liquidityDelta : liquidityDelta;
  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);

  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtPriceX96 <= sqrtLower) {
    amount0 = amount0Delta(sqrtLower, sqrtUpper, L);
  } else if (sqrtPriceX96 >= sqrtUpper) {
    amount1 = amount1Delta(sqrtLower, sqrtUpper, L);
  } else {
    amount0 = amount0Delta(sqrtPriceX96, sqrtUpper, L);
    amount1 = amount1Delta(sqrtLower, sqrtPriceX96, L);
  }
  return { amount0: amount0 * sign, amount1: amount1 * sign };
}
