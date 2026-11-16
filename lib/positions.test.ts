import { decodeAbiParameters, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  buildPosition,
  decodePositionInfo,
  encodeCollect,
  encodeRemove,
  feesOwed,
  priceCurrencies,
  removeMinimums,
  tokenPriceRange,
  type RawBin,
} from './positions';
import { amountsForLiquidity, getSqrtRatioAtTick } from './tick-math';

const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const KEY = { currency0: zeroAddress, currency1: PONS, fee: 10128, tickSpacing: 202, hooks: zeroAddress } as const;

describe('decodePositionInfo', () => {
  it('reads the ticks out of a real position NFT', () => {
    // NFT #4,301,289 on mainnet: the first bin of a PONS / ETH 1.0128% shaped
    // mint, read with PositionManager.getPoolAndPositionInfo.
    const info = 8515170081873685027514583931655106466573010107985209108996963863731431936512n;
    const { tickLower, tickUpper } = decodePositionInfo(info);
    expect(tickLower % 202).toBe(0);
    expect(tickUpper % 202).toBe(0);
    expect(tickUpper).toBeGreaterThan(tickLower);
    // The top 200 bits are the pool id's top 200 bits.
    const poolId = 0x12d36a5c6b193d14c5d40425166f4e3d72339792fa0efd65c01709c56df55859n;
    expect(info >> 56n).toBe(poolId >> 56n);
  });

  it('keeps the sign of negative ticks', () => {
    const pack = (lower: number, upper: number) =>
      ((BigInt(upper) & 0xffffffn) << 32n) | ((BigInt(lower) & 0xffffffn) << 8n) | 1n;
    expect(decodePositionInfo(pack(-887_000, -202))).toEqual({ tickLower: -887_000, tickUpper: -202 });
    expect(decodePositionInfo(pack(-404, 96_108))).toEqual({ tickLower: -404, tickUpper: 96_108 });
  });
});

describe('feesOwed', () => {
  it('is liquidity times fee growth since the last collect, over 2^128', () => {
    expect(feesOwed(10n ** 18n, 3n * 2n ** 128n, 2n ** 128n)).toBe(2n * 10n ** 18n);
  });

  it('survives fee growth wrapping past 2^256, as the contracts let it', () => {
    const last = 2n ** 256n - 2n ** 128n;
    expect(feesOwed(5n, 2n ** 128n, last)).toBe(10n);
  });
});

describe('priceCurrencies', () => {
  it('prices a token against ETH from the pool, and USDG at a dollar', () => {
    // 1 ETH = 10,000 PONS: sqrt(10,000) * 2^96.
    const sqrt = 100n * 2n ** 96n;
    const [eth, pons] = priceCurrencies(KEY, [18, 18], sqrt, 2_000, USDG);
    expect(eth).toBe(2_000);
    expect(pons).toBeCloseTo(0.2, 9);
    const [usdg, other] = priceCurrencies({ currency0: USDG, currency1: PONS }, [6, 18], 2n ** 96n * 1_000_000n, null, USDG);
    expect(usdg).toBe(1);
    expect(other).toBeCloseTo(1, 6);
  });

  it('prices nothing it cannot reach through ETH or USDG', () => {
    expect(priceCurrencies({ currency0: PONS, currency1: '0x0000000000000000000000000000000000000abc' }, [18, 18], 2n ** 96n, 2_000, USDG)).toEqual([null, null]);
  });
});

function bin(tokenId: bigint, tickLower: number, tickUpper: number, liquidity: bigint, earned = 0n): RawBin {
  return {
    tokenId,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0X128: earned * 2n ** 128n,
    feeGrowthInside1X128: 0n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
  };
}

describe('buildPosition', () => {
  const sqrt = getSqrtRatioAtTick(92_000);
  const base = {
    txHash: '0xabc' as const,
    blockNumber: 115_542_718n,
    poolId: '0x12d36a5c6b193d14c5d40425166f4e3d72339792fa0efd65c01709c56df55859' as const,
    key: KEY,
    currencies: [
      { address: zeroAddress, symbol: 'ETH', decimals: 18 },
      { address: PONS as `0x${string}`, symbol: 'PONS', decimals: 18 },
    ] as [{ address: `0x${string}`; symbol: string; decimals: number }, { address: `0x${string}`; symbol: string; decimals: number }],
    sqrtPriceX96: sqrt,
    tick: 92_000,
    ethUsd: 2_000,
    usdg: USDG,
  };

  it('adds the bins up, says which earn, and values them at today\'s price', () => {
    const bins = [bin(1n, 91_708, 92_112, 10n ** 18n, 3n), bin(2n, 92_112, 92_516, 10n ** 18n), bin(3n, 91_304, 91_708, 10n ** 18n)];
    const p = buildPosition({ ...base, bins })!;
    expect(p.bins).toHaveLength(3);
    expect(p.binsInRange).toBe(1);
    expect(p.bins.map((b) => b.inRange)).toEqual([true, false, false]);
    const each = bins.map((b) => amountsForLiquidity({ sqrtPriceX96: sqrt, tickLower: b.tickLower, tickUpper: b.tickUpper, liquidityDelta: b.liquidity }));
    expect(p.amount0).toBe(each.reduce((a, x) => a + x.amount0, 0n));
    expect(p.amount1).toBe(each.reduce((a, x) => a + x.amount1, 0n));
    expect(p.fees0).toBe(3n * 10n ** 18n);
    expect(p.feesUsd).toBeCloseTo(3 * 2_000, 6);
    expect(p.tickLower).toBe(91_304);
    expect(p.tickUpper).toBe(92_516);
    expect(p.tokenIndex).toBe(1);
    const range = tokenPriceRange(p)!;
    const now = p.currencies[1].usd!;
    expect(range.low).toBeLessThan(now);
    expect(range.high).toBeGreaterThan(now);
  });

  it('leaves out a bin with nothing left in it, and a mint with no bin at all', () => {
    expect(buildPosition({ ...base, bins: [bin(1n, 91_708, 92_112, 0n)] })).toBeNull();
    // Owed fees are liquidity times fee growth, so a drained bin owes none:
    // v4 pays a position's fees out when its liquidity is removed.
    const p = buildPosition({ ...base, bins: [bin(1n, 91_708, 92_112, 0n, 1n), bin(2n, 92_112, 92_516, 10n ** 18n)] })!;
    expect(p.bins.map((b) => [b.tokenId, b.inRange])).toEqual([[2n, false]]);
    expect(p.binsInRange).toBe(0);
  });
});

describe('removeMinimums', () => {
  const sqrt = getSqrtRatioAtTick(92_000);

  it('asks almost all of a bin the price is outside of', () => {
    const b = { tickLower: 92_112, tickUpper: 92_516, liquidity: 10n ** 20n };
    const now = amountsForLiquidity({ sqrtPriceX96: sqrt, ...b, liquidityDelta: b.liquidity });
    const { amount0Min, amount1Min } = removeMinimums(b, sqrt);
    expect(amount1Min).toBe(0n);
    expect(amount0Min).toBeLessThanOrEqual(now.amount0);
    expect(Number(amount0Min)).toBeGreaterThan(Number(now.amount0) * 0.999);
  });

  it('allows a bin the price sits inside to change its mix within the band', () => {
    const b = { tickLower: 91_960, tickUpper: 92_040, liquidity: 10n ** 20n };
    const now = amountsForLiquidity({ sqrtPriceX96: sqrt, ...b, liquidityDelta: b.liquidity });
    const { amount0Min, amount1Min } = removeMinimums(b, sqrt);
    // A narrow bin's mix moves far more than 0.5% on a 0.5% price move.
    expect(Number(amount0Min)).toBeLessThan(Number(now.amount0) * 0.9);
    expect(Number(amount1Min)).toBeLessThan(Number(now.amount1) * 0.9);
  });
});

describe('encodeCollect / encodeRemove', () => {
  const me = '0x00000000000000000000000000000000000000aa' as const;
  const decode = (data: `0x${string}`) => decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data);

  it('collects with a zero-liquidity decrease per bin, then one take of both tokens', () => {
    const [actions, params] = decode(encodeCollect([{ tokenId: 7n }, { tokenId: 8n }], KEY, me));
    expect(actions).toBe('0x010111');
    expect(params).toHaveLength(3);
    const [id, liq, m0, m1] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      params[1],
    );
    expect([id, liq, m0, m1]).toEqual([8n, 0n, 0n, 0n]);
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], params[2]).map((a) => String(a).toLowerCase())).toEqual([
      zeroAddress,
      PONS,
      me,
    ]);
  });

  it('removes by burning each bin with its minimums, then one take', () => {
    const [actions, params] = decode(encodeRemove([{ tokenId: 7n, amount0Min: 5n, amount1Min: 6n }], KEY, me));
    expect(actions).toBe(`0x${ACTIONS.BURN_POSITION.toString(16).padStart(2, '0')}${ACTIONS.TAKE_PAIR.toString(16)}`);
    const [id, m0, m1] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], params[0]);
    expect([id, m0, m1]).toEqual([7n, 5n, 6n]);
  });
});
