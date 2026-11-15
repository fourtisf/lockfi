/**
 * The router form, turned into TidewellRouterFactory.createRouter's Config.
 *
 * Pure, and it refuses exactly what the contract's constructor refuses —
 * BadRange, BadConfig, MilestonesNotAscending, UnsupportedPool — so a team is
 * told before it signs, not by a revert after.
 *
 * One conversion matters more than the rest: milestones are typed in dollars
 * of market cap, but the router measures fully diluted value IN WETH
 * (totalSupply × TWAP price), so each dollar figure is converted at today's
 * ETH price and fixed forever. If ETH moves, the dollar value at which a
 * milestone fires moves with it. The page says so.
 */
import { zeroAddress } from 'viem';
import { CONTRACTS } from '../chain';
import type { PoolKey } from '../data/types';
import { parseEthInput } from './tx';
import { maxUsableTick, minUsableTick } from './shaped';

export const ROUTER_MODE = { cadence: 0, milestone: 1 } as const;

/** The contract's floor on a cadence, and its ceiling on slippage. */
export const MIN_CADENCE_SECONDS = 3600;
export const MAX_SLIPPAGE_BPS = 1000;

/**
 * Defaults for the guards (a product call, shown and editable on the page):
 * 3% slippage against the TWAP price and a 3% spot-vs-TWAP deviation —
 * memecoins routinely move a few percent in 30 minutes, and a tighter guard
 * would leave every route reverting — and no route under 0.01 WETH, which
 * would cost the keeper more in gas than it adds in depth.
 */
export const ROUTER_DEFAULTS = {
  cadenceSeconds: 86_400,
  maxSlippagePct: '3',
  twapDeviationPct: '3',
  minRouteEth: '0.01',
  maxRouteEth: '',
} as const;

export interface RouterConfig {
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
  mode: number;
  cadenceSeconds: number;
  milestonesWeth: bigint[];
  maxSlippageBps: number;
  maxTwapDeviationTicks: number;
  minRouteWeth: bigint;
  maxRouteWeth: bigint;
}

/** Dollars to WETH wei at an ETH price, or null without a price. */
export function usdToWethWei(usd: number, ethPriceUsd: number): bigint | null {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) return null;
  // Six decimals of each side keep the division exact enough for a milestone.
  const u = BigInt(Math.round(usd * 1e6));
  const p = BigInt(Math.round(ethPriceUsd * 1e6));
  return (u * 10n ** 18n) / p;
}

/** A percentage of price as whole ticks, rounded up: ln(1 + p) / ln(1.0001). */
export function pctToTicks(pct: number): number {
  if (!(pct > 0)) return 0;
  return Math.ceil(Math.log(1 + pct / 100) / Math.log(1.0001));
}

/**
 * Whether a pool's hook could rewrite a liquidity delta — the two
 * permissions the router refuses (the low two bits of a v4 hook address:
 * AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA and AFTER_ADD_LIQUIDITY_RETURNS_DELTA).
 */
export function hookCanTakeLiquidity(hooks: string): boolean {
  if (hooks.toLowerCase() === zeroAddress) return false;
  return (BigInt(hooks) & 0b11n) !== 0n;
}

/** Whether the pool has exactly one ETH side (native or WETH), as the router needs. */
export function hasOneEthSide(key: PoolKey): boolean {
  const weth = CONTRACTS.weth.toLowerCase();
  const eth0 = key.currency0.toLowerCase() === zeroAddress || key.currency0.toLowerCase() === weth;
  const eth1 = key.currency1.toLowerCase() === weth;
  return eth0 !== eth1;
}

/** Full range for a spacing: TickMath's usable bounds. */
export function fullRange(tickSpacing: number): { lower: number; upper: number } {
  return { lower: minUsableTick(tickSpacing), upper: maxUsableTick(tickSpacing) };
}

export interface RouterFormInput {
  key: PoolKey;
  range: { lower: number; upper: number };
  mode: 'cadence' | 'milestone';
  cadenceSeconds: number;
  milestonesUsd: number[];
  ethPriceUsd: number;
  maxSlippagePct: string;
  twapDeviationPct: string;
  minRouteEth: string;
  maxRouteEth: string;
}

export type RouterConfigResult = { ok: true; cfg: RouterConfig } | { ok: false; reason: string };

export function buildRouterConfig(input: RouterFormInput): RouterConfigResult {
  const { key, range } = input;
  if (!hasOneEthSide(key)) return { ok: false, reason: 'The router needs a pool with exactly one ETH or WETH side.' };
  if (hookCanTakeLiquidity(key.hooks)) {
    return { ok: false, reason: "This pool's hook can rewrite liquidity changes, so the router will not route into it." };
  }
  const ts = key.tickSpacing;
  if (
    !(range.lower < range.upper) ||
    range.lower % ts !== 0 ||
    range.upper % ts !== 0 ||
    range.lower < minUsableTick(ts) ||
    range.upper > maxUsableTick(ts)
  ) {
    return { ok: false, reason: 'The destination range is not a valid range for this pool.' };
  }

  const slippage = Number(input.maxSlippagePct);
  const maxSlippageBps = Math.round(slippage * 100);
  if (!Number.isFinite(slippage) || maxSlippageBps < 1 || maxSlippageBps > MAX_SLIPPAGE_BPS) {
    return { ok: false, reason: 'Slippage guard must be between 0.01% and 10%.' };
  }
  const deviation = Number(input.twapDeviationPct);
  const maxTwapDeviationTicks = pctToTicks(deviation);
  if (!Number.isFinite(deviation) || maxTwapDeviationTicks < 1 || maxTwapDeviationTicks > 0xffffff) {
    return { ok: false, reason: 'TWAP guard must be a percentage above zero.' };
  }

  const minRouteWeth = input.minRouteEth.trim() === '' ? 0n : parseEthInput(input.minRouteEth);
  const maxRouteWeth = input.maxRouteEth.trim() === '' ? 0n : parseEthInput(input.maxRouteEth);
  if (minRouteWeth === null) return { ok: false, reason: 'Minimum route is not an amount of WETH.' };
  if (maxRouteWeth === null) return { ok: false, reason: 'Maximum route is not an amount of WETH.' };
  if (maxRouteWeth !== 0n && maxRouteWeth < minRouteWeth) {
    return { ok: false, reason: 'Maximum route must be at least the minimum route.' };
  }

  let milestonesWeth: bigint[] = [];
  let cadenceSeconds = 0;
  if (input.mode === 'cadence') {
    cadenceSeconds = Math.round(input.cadenceSeconds);
    if (!(cadenceSeconds >= MIN_CADENCE_SECONDS) || cadenceSeconds > 0xffffffff) {
      return { ok: false, reason: 'A cadence must be at least one hour.' };
    }
  } else {
    if (input.milestonesUsd.length === 0) return { ok: false, reason: 'Add at least one milestone.' };
    if (!(input.ethPriceUsd > 0)) {
      return { ok: false, reason: 'The ETH price is not known yet, so dollar milestones cannot be converted to WETH.' };
    }
    for (let i = 0; i < input.milestonesUsd.length; i++) {
      const wei = usdToWethWei(input.milestonesUsd[i], input.ethPriceUsd);
      if (wei === null || wei === 0n) return { ok: false, reason: `Milestone ${i + 1} must be above zero.` };
      if (i > 0 && wei <= milestonesWeth[i - 1]) {
        return { ok: false, reason: 'Milestones must ascend. Each one fires once, in order.' };
      }
      milestonesWeth.push(wei);
    }
  }

  return {
    ok: true,
    cfg: {
      key,
      tickLower: range.lower,
      tickUpper: range.upper,
      mode: ROUTER_MODE[input.mode],
      cadenceSeconds,
      milestonesWeth,
      maxSlippageBps,
      maxTwapDeviationTicks,
      minRouteWeth,
      maxRouteWeth,
    },
  };
}
