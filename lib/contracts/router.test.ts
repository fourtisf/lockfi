import { parseEther, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { CONTRACTS } from '../chain';
import type { PoolKey } from '../data/types';
import {
  ROUTER_DEFAULTS,
  buildRouterConfig,
  fullRange,
  hookCanTakeLiquidity,
  pctToTicks,
  usdToWethWei,
  type RouterFormInput,
} from './router';

const TOKEN = `0x${'ee'.repeat(20)}` as `0x${string}`;
const nativeKey: PoolKey = { currency0: zeroAddress, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress };

function input(over: Partial<RouterFormInput> = {}): RouterFormInput {
  return {
    key: nativeKey,
    range: fullRange(60),
    mode: 'cadence',
    cadenceSeconds: ROUTER_DEFAULTS.cadenceSeconds,
    milestonesUsd: [],
    ethPriceUsd: 2500,
    maxSlippagePct: ROUTER_DEFAULTS.maxSlippagePct,
    twapDeviationPct: ROUTER_DEFAULTS.twapDeviationPct,
    minRouteEth: ROUTER_DEFAULTS.minRouteEth,
    maxRouteEth: ROUTER_DEFAULTS.maxRouteEth,
    ...over,
  };
}

describe('usdToWethWei', () => {
  it('converts dollars of FDV to WETH at the ETH price', () => {
    expect(usdToWethWei(5_000_000, 2500)).toBe(parseEther('2000'));
    expect(usdToWethWei(1, 3000)).toBe(333_333_333_333_333n);
  });
  it('refuses without a price', () => {
    expect(usdToWethWei(5_000_000, 0)).toBeNull();
  });
});

describe('fullRange', () => {
  it("is TickMath's usable bounds for the spacing", () => {
    expect(fullRange(60)).toEqual({ lower: -887220, upper: 887220 });
    expect(fullRange(1)).toEqual({ lower: -887272, upper: 887272 });
    expect(fullRange(200)).toEqual({ lower: -887200, upper: 887200 });
  });
});

describe('pctToTicks', () => {
  it('rounds a price percentage up to whole ticks', () => {
    expect(pctToTicks(3)).toBe(296); // ln(1.03)/ln(1.0001) = 295.6
    expect(pctToTicks(0)).toBe(0);
  });
});

describe('hookCanTakeLiquidity', () => {
  it('reads the two return-delta permission bits of a hook address', () => {
    expect(hookCanTakeLiquidity(zeroAddress)).toBe(false);
    expect(hookCanTakeLiquidity('0x0000000000000000000000000000000000000080')).toBe(false);
    expect(hookCanTakeLiquidity('0x0000000000000000000000000000000000000001')).toBe(true);
    expect(hookCanTakeLiquidity('0x00000000000000000000000000000000000000c2')).toBe(true);
  });

  it('also refuses a hook that runs when liquidity is added, even without a delta', () => {
    // BEFORE_ADD_LIQUIDITY (bit 11) and AFTER_ADD_LIQUIDITY (bit 10) run
    // inside the deposit, after the router has checked its price.
    expect(hookCanTakeLiquidity('0x0000000000000000000000000000000000000800')).toBe(true);
    expect(hookCanTakeLiquidity('0x0000000000000000000000000000000000000400')).toBe(true);
    // A swap-only hook (BEFORE_SWAP, bit 7) is not about liquidity; the
    // contract refuses swap hooks on its own.
    expect(hookCanTakeLiquidity('0x0000000000000000000000000000000000000080')).toBe(false);
  });
});

describe('buildRouterConfig', () => {
  it('builds a cadence config the contract accepts', () => {
    const out = buildRouterConfig(input());
    if (!out.ok) throw new Error(out.reason);
    expect(out.cfg).toMatchObject({
      tickLower: -887220,
      tickUpper: 887220,
      mode: 0,
      cadenceSeconds: 86_400,
      milestonesWeth: [],
      maxSlippageBps: 300,
      maxTwapDeviationTicks: 296,
      minRouteWeth: parseEther('0.01'),
      maxRouteWeth: 0n,
    });
  });

  it('converts milestones to WETH and leaves the cadence at zero', () => {
    const out = buildRouterConfig(input({ mode: 'milestone', milestonesUsd: [5e6, 1e7] }));
    if (!out.ok) throw new Error(out.reason);
    expect(out.cfg.mode).toBe(1);
    expect(out.cfg.cadenceSeconds).toBe(0);
    expect(out.cfg.milestonesWeth).toEqual([parseEther('2000'), parseEther('4000')]);
  });

  it('refuses milestones out of order at config time, as the contract would (§3.5)', () => {
    const out = buildRouterConfig(input({ mode: 'milestone', milestonesUsd: [5e6, 1e6] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/must ascend/);
  });

  it('refuses dollar milestones with no ETH price to convert them at', () => {
    const out = buildRouterConfig(input({ mode: 'milestone', milestonesUsd: [5e6], ethPriceUsd: 0 }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/ETH price is not known/);
  });

  it('holds the guards inside what the constructor allows', () => {
    expect(buildRouterConfig(input({ maxSlippagePct: '0' })).ok).toBe(false);
    expect(buildRouterConfig(input({ maxSlippagePct: '10.5' })).ok).toBe(false);
    expect(buildRouterConfig(input({ maxSlippagePct: '10' })).ok).toBe(true);
    expect(buildRouterConfig(input({ twapDeviationPct: '0' })).ok).toBe(false);
    expect(buildRouterConfig(input({ cadenceSeconds: 1800 })).ok).toBe(false);
    expect(buildRouterConfig(input({ minRouteEth: '1', maxRouteEth: '0.5' })).ok).toBe(false);
  });

  it('refuses a range off the tick grid or past the usable bounds', () => {
    expect(buildRouterConfig(input({ range: { lower: -90, upper: 60 } })).ok).toBe(false);
    expect(buildRouterConfig(input({ range: { lower: -887280, upper: 60 } })).ok).toBe(false);
    expect(buildRouterConfig(input({ range: { lower: 60, upper: 60 } })).ok).toBe(false);
  });

  it('refuses a pool without exactly one ETH side, and a hook that could take liquidity', () => {
    const noEth = { ...nativeKey, currency0: `0x${'11'.repeat(20)}` as `0x${string}` };
    expect(buildRouterConfig(input({ key: noEth })).ok).toBe(false);
    const wethWeth = { ...nativeKey, currency1: CONTRACTS.weth as `0x${string}` };
    expect(buildRouterConfig(input({ key: wethWeth })).ok).toBe(false);
    const hooked = { ...nativeKey, hooks: '0x0000000000000000000000000000000000000002' as `0x${string}` };
    expect(buildRouterConfig(input({ key: hooked })).ok).toBe(false);
  });
});
