/**
 * What the keeper decides about one router, kept apart from the loop that
 * sends transactions so the local test (server/scripts/router-local.ts) runs
 * exactly the code the keeper runs.
 *
 * A route is sent only when all of these hold:
 *   - the router is not paused, lets the keeper route it, and is due;
 *   - at least `minRouteWei` of new ETH has arrived since the last route;
 *   - the keeper has sampled the pool's price across the last 30 minutes (v4
 *     pools have no on-chain oracle), and the price now is within
 *     `maxDeviationBps` of that average. A price pushed away just before a
 *     route is the one a sandwich needs, and the keeper waits it out.
 *
 * The route then carries a price band of ±`maxDeviationBps` around that
 * average. The contract refuses to start outside it, stops the swap at its
 * edge, and adds the liquidity inside it; and the minimum rate is the rate at
 * the band's worse edge, less the pool's fee and `slippageBps`, so it is
 * never zero and never depends on a quote taken at a pushed price.
 */

import { parseAbi, type Abi, type Address, type PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import abi from './abi.json';

export const ROUTER_ABI = abi.router as Abi;
export const FACTORY_ABI = abi.factory as Abi;
/** The widest band, in price bps either side, the contract takes from a keeper (≈ 1.05 in sqrt price). */
export const MAX_KEEPER_BAND_BPS = 480;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface RouterState {
  address: Address;
  isV4: boolean;
  key: PoolKey;
  v3Pool: Address;
  token: Address;
  quote: Address;
  tokenIs0: boolean;
  team: Address;
  paused: boolean;
  keeperAllowed: boolean;
  due: boolean;
  nextRouteAt: bigint;
  quoteBalance: bigint;
  tokenBalance: bigint;
  feeFreeQuote: bigint;
  feeOwed: bigint;
  sqrtPriceX96: bigint;
  fee: bigint;
  swapIn: bigint;
}

const STATE_FIELDS = [
  'isV4',
  'key',
  'v3Pool',
  'token',
  'quote',
  'tokenIs0',
  'team',
  'paused',
  'keeperAllowed',
  'due',
  'nextRouteAt',
  'quoteBalance',
  'tokenBalance',
  'feeFreeQuote',
  'feeOwed',
  'price',
  'plan',
] as const;

/** One router's state, in one multicall. */
export async function readRouter(client: PublicClient, address: Address): Promise<RouterState> {
  const res = (await client.multicall({
    contracts: STATE_FIELDS.map((functionName) => ({ address, abi: ROUTER_ABI, functionName })),
    allowFailure: false,
    multicallAddress: CONTRACTS.multicall3 as Address,
  })) as unknown[];
  const v = <T>(f: (typeof STATE_FIELDS)[number]) => res[STATE_FIELDS.indexOf(f)] as T;
  const price = v<readonly [bigint, number]>('price');
  const plan = v<readonly [bigint, bigint]>('plan');
  return {
    address,
    isV4: v('isV4'),
    key: v('key'),
    v3Pool: v('v3Pool'),
    token: v('token'),
    quote: v('quote'),
    tokenIs0: v('tokenIs0'),
    team: v('team'),
    paused: v('paused'),
    keeperAllowed: v('keeperAllowed'),
    due: v('due'),
    nextRouteAt: v('nextRouteAt'),
    quoteBalance: v('quoteBalance'),
    tokenBalance: v('tokenBalance'),
    feeFreeQuote: v('feeFreeQuote'),
    feeOwed: v('feeOwed'),
    sqrtPriceX96: price[0],
    fee: plan[0],
    swapIn: plan[1],
  };
}

const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const QUOTER_V2_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export interface Quoters {
  v4Quoter: Address;
  quoterV2: Address;
}

/** Token (smallest unit) out for `amountIn` wei of the quote, from Uniswap's own quoter. */
export async function quoteTokenOut(client: PublicClient, s: RouterState, amountIn: bigint, q: Quoters): Promise<bigint> {
  if (amountIn === 0n) return 0n;
  if (s.isV4) {
    const { result } = await client.simulateContract({
      address: q.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: s.key, zeroForOne: !s.tokenIs0, exactAmount: amountIn, hookData: '0x' }],
    });
    return result[0];
  }
  const { result } = await client.simulateContract({
    address: q.quoterV2,
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: s.quote, tokenOut: s.token, amountIn, fee: s.key.fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/** The minimum rate `route` takes: token per wei of quote, times 1e18, less the slippage allowance. */
export function minRateFrom(amountIn: bigint, amountOut: bigint, slippageBps: number): bigint {
  if (amountIn === 0n) return 0n;
  return (amountOut * 10n ** 18n * BigInt(10_000 - slippageBps)) / (amountIn * 10_000n);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

const E18 = 10n ** 18n;
const Q192 = 1n << 192n;

/** The band ±`bps` in price around a sqrt price, as the two sqrt-price edges `route` takes. */
export function bandAround(sqrtRef: bigint, bps: number): { lo: bigint; hi: bigint } {
  const f = (b: number) => isqrt(BigInt(10_000 + b) * 10n ** 32n); // sqrt(1 + b/1e4) · 1e18
  return { lo: (sqrtRef * f(-bps)) / E18, hi: (sqrtRef * f(bps)) / E18 };
}

/**
 * The least rate a swap inside the band can give: token per wei of quote at
 * the band's worse edge for a buyer of the token, less the pool's fee and
 * `slippageBps`. Buying the token moves the pool's price toward that edge
 * and the swap stops there, so every unit it buys is at least this cheap. A
 * dynamic-fee pool's fee is not in its key and is taken as 1%.
 */
export function bandMinRate(
  s: { tokenIs0: boolean; key: { fee: number } },
  band: { lo: bigint; hi: bigint },
  slippageBps: number,
): bigint {
  const feePips = (s.key.fee & 0x800000) !== 0 || s.key.fee >= 1_000_000 ? 10_000 : s.key.fee;
  // pool price = currency1 per currency0. With the token as currency0 it is
  // the quote per token, rising as the token is bought: the worse edge is hi.
  const rate = s.tokenIs0 ? (Q192 * E18) / (band.hi * band.hi) : (band.lo * band.lo * E18) / Q192;
  return (rate * BigInt(1_000_000 - feePips) * BigInt(10_000 - slippageBps)) / (1_000_000n * 10_000n);
}

/**
 * A rolling record of each pool's price, sampled by the keeper, standing in
 * for the oracle a v4 pool does not have. `average` is the time-weighted mean
 * of the sqrt price over the window; it is null until the window is covered
 * by at least `minSamples` samples, so a restarted keeper waits a full window
 * before its first route, and one old sample can never be the whole average.
 */
export class PriceWindow {
  private samples = new Map<string, { at: number; sqrtP: bigint }[]>();
  constructor(
    private readonly windowMs = 30 * 60_000,
    private readonly minSamples = 10,
  ) {}

  add(pool: string, sqrtP: bigint, at = Date.now()): void {
    const list = this.samples.get(pool) ?? [];
    list.push({ at, sqrtP });
    while (list.length > 2 && list[1].at <= at - this.windowMs) list.shift();
    this.samples.set(pool, list);
  }

  average(pool: string, now = Date.now()): bigint | null {
    const list = this.samples.get(pool);
    if (!list || list.length < 2 || list[0].at > now - this.windowMs * 0.9) return null;
    if (list.filter((x) => x.at >= now - this.windowMs).length < this.minSamples) return null;
    let weighted = 0n;
    let total = 0n;
    for (let i = 0; i < list.length; i++) {
      const end = i + 1 < list.length ? list[i + 1].at : now;
      const dt = BigInt(Math.max(0, end - Math.max(list[i].at, now - this.windowMs)));
      weighted += list[i].sqrtP * dt;
      total += dt;
    }
    return total > 0n ? weighted / total : null;
  }
}

/** Price deviation in basis points between two sqrt prices (price = sqrt²). */
export function deviationBps(sqrtNow: bigint, sqrtRef: bigint): number {
  if (sqrtRef === 0n) return Infinity;
  const ratio = Number((sqrtNow * sqrtNow * 1_000_000n) / (sqrtRef * sqrtRef)) / 1_000_000;
  return Math.abs(ratio - 1) * 10_000;
}

export interface Decision {
  route: boolean;
  reason: string;
  minRate: bigint;
  lo: bigint;
  hi: bigint;
}

export async function decide(
  client: PublicClient,
  s: RouterState,
  opts: { quoters: Quoters; minRouteWei: bigint; slippageBps: number; maxDeviationBps: number; reference: bigint | null },
): Promise<Decision> {
  const no = (reason: string): Decision => ({ route: false, reason, minRate: 0n, lo: 0n, hi: 0n });
  if (s.paused) return no('paused');
  if (!s.keeperAllowed) return no('the team has turned the keeper off');
  if (!s.due) return no(`not due until ${new Date(Number(s.nextRouteAt) * 1000).toISOString()}`);
  const fresh = s.quoteBalance > s.feeFreeQuote ? s.quoteBalance - s.feeFreeQuote : 0n;
  if (fresh < opts.minRouteWei) return no(`only ${fresh} wei of new ETH`);
  if (opts.reference === null) return no('price window not yet covered');
  const dev = deviationBps(s.sqrtPriceX96, opts.reference);
  if (dev > opts.maxDeviationBps) return no(`price is ${dev.toFixed(0)} bps from its 30-minute average`);
  const band = bandAround(opts.reference, opts.maxDeviationBps);
  if (s.sqrtPriceX96 < band.lo || s.sqrtPriceX96 > band.hi) return no('price is at the edge of its band');
  const minRate = bandMinRate(s, band, opts.slippageBps);
  if (minRate === 0n) return no('the minimum rate rounds to zero for this token');
  const out = await quoteTokenOut(client, s, s.swapIn, opts.quoters).catch(() => null);
  return {
    route: true,
    reason: `swap up to ${s.swapIn} wei${out === null ? '' : ` for about ${out}`}, inside ±${opts.maxDeviationBps} bps`,
    minRate,
    ...band,
  };
}

/**
 * The band and minimum a team's own "Route now" sends: ±`bandBps` around the
 * pool's price now, which the page reads a moment before. The team is not
 * held to the keeper's 30-minute average; the band still stops a swap that
 * would move the price past it.
 */
export function teamBand(s: RouterState, bandBps = 200, slippageBps = 100): { minRate: bigint; lo: bigint; hi: bigint } {
  const band = bandAround(s.sqrtPriceX96, bandBps);
  return { minRate: bandMinRate(s, band, slippageBps), ...band };
}
