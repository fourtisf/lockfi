/**
 * A wallet's Uniswap v4 positions minted through Tidewell, read from the
 * chain and valued. Pure: the reading is in hooks/useWalletPositions.ts.
 *
 * A shaped mint is one transaction and N position NFTs, one per bin
 * (TidewellShaper's `ShapeMinted` names the first id; the rest follow in
 * order). The portfolio shows the mint as one position with N bins, because
 * that is what the person made, and it is closed the same way: every bin in
 * one PositionManager call.
 *
 * Fees are what the PoolManager has credited to each bin and not yet paid:
 * liquidity × (fee growth inside the range now − at the last collect) ÷ 2¹²⁸,
 * the same arithmetic the PositionManager does when it collects.
 */
import { concatHex, encodeAbiParameters, toHex, zeroAddress, type Hex } from 'viem';
import { CONTRACTS } from './chain';
import { sqrtPriceBounds } from './contracts/tx';
import type { PoolKey } from './data/types';
import { amountsForLiquidity, getSqrtRatioAtTick } from './tick-math';

type Address = `0x${string}`;

/** v4-periphery's Actions.sol, the three this file encodes. */
export const ACTIONS = { DECREASE_LIQUIDITY: 0x01, BURN_POSITION: 0x03, TAKE_PAIR: 0x11 } as const;

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const MOD_256 = 2n ** 256n;
const WETH = CONTRACTS.weth.toLowerCase();

/** PositionInfo: 200 bits poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber. */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  const int24 = (v: bigint) => {
    const x = Number(v & 0xffffffn);
    return x >= 0x800000 ? x - 0x1000000 : x;
  };
  return { tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
}

/** Fees credited and not yet collected. Fee growth wraps (uint256), so the difference does too. */
export function feesOwed(liquidity: bigint, insideNowX128: bigint, insideLastX128: bigint): bigint {
  const delta = (((insideNowX128 - insideLastX128) % MOD_256) + MOD_256) % MOD_256;
  return (liquidity * delta) / Q128;
}

export function isEthCurrency(currency: string): boolean {
  const c = currency.toLowerCase();
  return c === zeroAddress || c === WETH;
}

export interface CurrencyInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** Dollars per whole token; null when neither side of the pool can be priced. */
  usd: number | null;
}

/** One bin: one position NFT. */
export interface PositionBin {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
  inRange: boolean;
}

export interface WalletPosition {
  /** The mint transaction: one position per mint. */
  txHash: Hex;
  blockNumber: bigint;
  /** bytes32 v4 pool id. */
  poolId: Hex;
  key: PoolKey;
  currencies: [CurrencyInfo, CurrencyInfo];
  /** Which currency is the traded token, and which the quote it is priced in. */
  tokenIndex: 0 | 1;
  sqrtPriceX96: bigint;
  tick: number;
  /** Bins this wallet still owns that hold liquidity or fees. */
  bins: PositionBin[];
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
  valueUsd: number | null;
  feesUsd: number | null;
  binsInRange: number;
  /** Across all bins: the lowest lower tick and the highest upper tick. */
  tickLower: number;
  tickUpper: number;
}

/** What a bin read from the chain carries, before it is valued. */
export interface RawBin {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0X128: bigint;
  feeGrowthInside1X128: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

function whole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** token1 per token0, in whole tokens, at a sqrt price. */
export function price1Per0(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const r = Number(sqrtPriceX96) / Number(Q96);
  return r * r * 10 ** (decimals0 - decimals1);
}

/**
 * Dollars per token for both sides of a pool: ETH (native or WETH) at
 * `ethUsd`, USDG at $1, and a token paired with either at the pool's own
 * price. Neither side priceable: both null.
 */
export function priceCurrencies(
  key: Pick<PoolKey, 'currency0' | 'currency1'>,
  decimals: [number, number],
  sqrtPriceX96: bigint,
  ethUsd: number | null,
  usdg: string | null,
): [number | null, number | null] {
  const known = (c: string): number | null => {
    if (isEthCurrency(c)) return ethUsd !== null && ethUsd > 0 ? ethUsd : null;
    if (usdg && c.toLowerCase() === usdg.toLowerCase()) return 1;
    return null;
  };
  let u0 = known(key.currency0);
  let u1 = known(key.currency1);
  const p = price1Per0(sqrtPriceX96, decimals[0], decimals[1]);
  if (!(p > 0) || !Number.isFinite(p)) return [u0, u1];
  if (u0 === null && u1 !== null) u0 = u1 * p;
  if (u1 === null && u0 !== null) u1 = u0 / p;
  return [u0, u1];
}

/** The traded token: the side that is not USDG, else not ETH (the snapshot's rule). */
export function tokenIndexOf(key: Pick<PoolKey, 'currency0' | 'currency1'>, usdg: string | null): 0 | 1 {
  const isUsdg = (c: string) => usdg !== null && c.toLowerCase() === usdg.toLowerCase();
  if (isUsdg(key.currency0)) return 1;
  if (isUsdg(key.currency1)) return 0;
  if (isEthCurrency(key.currency0)) return 1;
  return 0;
}

/** Values a mint's bins at the pool's current price. Null when no bin is left. */
export function buildPosition(args: {
  txHash: Hex;
  blockNumber: bigint;
  poolId: Hex;
  key: PoolKey;
  currencies: [Omit<CurrencyInfo, 'usd'>, Omit<CurrencyInfo, 'usd'>];
  sqrtPriceX96: bigint;
  tick: number;
  bins: RawBin[];
  ethUsd: number | null;
  usdg: string | null;
}): WalletPosition | null {
  const { sqrtPriceX96, tick } = args;
  const bins: PositionBin[] = [];
  for (const b of args.bins) {
    const { amount0, amount1 } = amountsForLiquidity({
      sqrtPriceX96,
      tickLower: b.tickLower,
      tickUpper: b.tickUpper,
      liquidityDelta: b.liquidity,
    });
    const fees0 = feesOwed(b.liquidity, b.feeGrowthInside0X128, b.feeGrowthInside0LastX128);
    const fees1 = feesOwed(b.liquidity, b.feeGrowthInside1X128, b.feeGrowthInside1LastX128);
    if (b.liquidity === 0n && fees0 === 0n && fees1 === 0n) continue;
    bins.push({
      tokenId: b.tokenId,
      tickLower: b.tickLower,
      tickUpper: b.tickUpper,
      liquidity: b.liquidity,
      amount0,
      amount1,
      fees0,
      fees1,
      // Earning only while the price is inside the bin: lower inclusive, upper exclusive.
      inRange: b.liquidity > 0n && tick >= b.tickLower && tick < b.tickUpper,
    });
  }
  if (bins.length === 0) return null;

  const decimals: [number, number] = [args.currencies[0].decimals, args.currencies[1].decimals];
  const [usd0, usd1] = priceCurrencies(args.key, decimals, sqrtPriceX96, args.ethUsd, args.usdg);
  const sum = (f: (b: PositionBin) => bigint) => bins.reduce((a, b) => a + f(b), 0n);
  const amount0 = sum((b) => b.amount0);
  const amount1 = sum((b) => b.amount1);
  const fees0 = sum((b) => b.fees0);
  const fees1 = sum((b) => b.fees1);
  const usd = (a0: bigint, a1: bigint) =>
    usd0 === null || usd1 === null ? null : whole(a0, decimals[0]) * usd0 + whole(a1, decimals[1]) * usd1;

  return {
    txHash: args.txHash,
    blockNumber: args.blockNumber,
    poolId: args.poolId,
    key: args.key,
    currencies: [
      { ...args.currencies[0], usd: usd0 },
      { ...args.currencies[1], usd: usd1 },
    ],
    tokenIndex: tokenIndexOf(args.key, args.usdg),
    sqrtPriceX96,
    tick,
    bins,
    amount0,
    amount1,
    fees0,
    fees1,
    valueUsd: usd(amount0, amount1),
    feesUsd: usd(fees0, fees1),
    binsInRange: bins.filter((b) => b.inRange).length,
    tickLower: Math.min(...bins.map((b) => b.tickLower)),
    tickUpper: Math.max(...bins.map((b) => b.tickUpper)),
  };
}

/**
 * The traded token's dollar price at each end of the position's range, low
 * to high, at today's price of its quote. Null when the quote is not priced.
 */
export function tokenPriceRange(p: WalletPosition): { low: number; high: number } | null {
  const t = p.tokenIndex;
  const q = t === 0 ? 1 : 0;
  const quoteUsd = p.currencies[q].usd;
  if (quoteUsd === null) return null;
  const at = (tick: number) => {
    const p10 = price1Per0(getSqrtRatioAtTick(tick), p.currencies[0].decimals, p.currencies[1].decimals);
    return t === 0 ? quoteUsd * p10 : quoteUsd / p10;
  };
  const a = at(p.tickLower);
  const b = at(p.tickUpper);
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

/**
 * The least of each token a bin can return while the price stays within
 * the mint's own ±0.5% band (sqrtPriceBounds): token0 shrinks as the price
 * rises and token1 as it falls, so each minimum is taken at the band's far
 * end. A flat 0.5% off the amounts now would revert a narrow bin the price
 * sits inside on a move far smaller than that, because its mix changes
 * faster than its value.
 */
export function removeMinimums(bin: Pick<PositionBin, 'tickLower' | 'tickUpper' | 'liquidity'>, sqrtPriceX96: bigint): {
  amount0Min: bigint;
  amount1Min: bigint;
} {
  const { min, max } = sqrtPriceBounds(sqrtPriceX96);
  const atHigh = amountsForLiquidity({ sqrtPriceX96: max, tickLower: bin.tickLower, tickUpper: bin.tickUpper, liquidityDelta: bin.liquidity });
  const atLow = amountsForLiquidity({ sqrtPriceX96: min, tickLower: bin.tickLower, tickUpper: bin.tickUpper, liquidityDelta: bin.liquidity });
  const less = (x: bigint) => (x > 1n ? x - 1n : 0n);
  return { amount0Min: less(atHigh.amount0), amount1Min: less(atLow.amount1) };
}

function unlockData(actions: number[], params: Hex[]): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [concatHex(actions.map((a) => toHex(a, { size: 1 }))), params],
  );
}

function takePair(key: Pick<PoolKey, 'currency0' | 'currency1'>, recipient: Address): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [key.currency0 as Address, key.currency1 as Address, recipient],
  );
}

/** Collect every bin's fees, principal untouched: a zero-liquidity decrease each, then one take. */
export function encodeCollect(
  bins: Pick<PositionBin, 'tokenId'>[],
  key: Pick<PoolKey, 'currency0' | 'currency1'>,
  recipient: Address,
): Hex {
  const params = bins.map((b) =>
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      [b.tokenId, 0n, 0n, 0n, '0x'],
    ),
  );
  return unlockData([...bins.map(() => ACTIONS.DECREASE_LIQUIDITY), ACTIONS.TAKE_PAIR], [...params, takePair(key, recipient)]);
}

/**
 * Close every bin: each NFT burned (its liquidity removed and its fees
 * collected), then both tokens sent to the wallet in one take. The minimums
 * apply to the principal, as the PositionManager checks them.
 */
export function encodeRemove(
  bins: (Pick<PositionBin, 'tokenId'> & { amount0Min: bigint; amount1Min: bigint })[],
  key: Pick<PoolKey, 'currency0' | 'currency1'>,
  recipient: Address,
): Hex {
  const params = bins.map((b) =>
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      [b.tokenId, b.amount0Min, b.amount1Min, '0x'],
    ),
  );
  return unlockData([...bins.map(() => ACTIONS.BURN_POSITION), ACTIONS.TAKE_PAIR], [...params, takePair(key, recipient)]);
}
