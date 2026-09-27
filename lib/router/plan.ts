/**
 * What the keeper decides about one router, kept apart from the loop that
 * sends transactions so the local test (server/scripts/router-local.ts) runs
 * exactly the code the keeper runs.
 *
 * A route is sent only when all of these hold:
 *   - the router is not paused and its cadence has elapsed;
 *   - at least `minRouteWei` of new ETH has arrived since the last route;
 *   - the pool's price now is within `maxDeviationBps` of its own recent
 *     average, which the keeper samples itself (v4 pools have no on-chain
 *     oracle). A price pushed away just before a route is the one a sandwich
 *     needs, and the keeper waits it out instead of routing into it;
 *   - the quoter says what the swap returns, and the route is sent with a
 *     minimum `slippageBps` below that. The contract reverts below it.
 */

import { parseAbi, type Abi, type Address, type PublicClient } from 'viem';
import abi from './abi.json';

export const ROUTER_ABI = abi.router as Abi;
export const FACTORY_ABI = abi.factory as Abi;

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
  due: boolean;
  nextRouteAt: bigint;
  quoteBalance: bigint;
  tokenBalance: bigint;
  feeFreeQuote: bigint;
  sqrtPriceX96: bigint;
  fee: bigint;
  swapIn: bigint;
}

export async function readRouter(client: PublicClient, address: Address): Promise<RouterState> {
  const r = { address, abi: ROUTER_ABI } as const;
  const read = <T>(functionName: string) => client.readContract({ ...r, functionName }) as Promise<T>;
  const [isV4, key, v3Pool, token, quote, tokenIs0, team, paused, due, nextRouteAt, quoteBalance, tokenBalance, feeFreeQuote, price, plan] =
    await Promise.all([
      read<boolean>('isV4'),
      read<PoolKey>('key'),
      read<Address>('v3Pool'),
      read<Address>('token'),
      read<Address>('quote'),
      read<boolean>('tokenIs0'),
      read<Address>('team'),
      read<boolean>('paused'),
      read<boolean>('due'),
      read<bigint>('nextRouteAt'),
      read<bigint>('quoteBalance'),
      read<bigint>('tokenBalance'),
      read<bigint>('feeFreeQuote'),
      read<readonly [bigint, number]>('price'),
      read<readonly [bigint, bigint]>('plan'),
    ]);
  return {
    address,
    isV4,
    key,
    v3Pool,
    token,
    quote,
    tokenIs0,
    team,
    paused,
    due,
    nextRouteAt,
    quoteBalance,
    tokenBalance,
    feeFreeQuote,
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

/**
 * A rolling record of each pool's price, sampled by the keeper, standing in
 * for the oracle a v4 pool does not have. `average` is the time-weighted mean
 * of the sqrt price over the window; it is null until the window is covered,
 * so a restarted keeper waits a full window before its first route.
 */
export class PriceWindow {
  private samples = new Map<string, { at: number; sqrtP: bigint }[]>();
  constructor(private readonly windowMs = 30 * 60_000) {}

  add(pool: string, sqrtP: bigint, at = Date.now()): void {
    const list = this.samples.get(pool) ?? [];
    list.push({ at, sqrtP });
    while (list.length > 2 && list[1].at <= at - this.windowMs) list.shift();
    this.samples.set(pool, list);
  }

  average(pool: string, now = Date.now()): bigint | null {
    const list = this.samples.get(pool);
    if (!list || list.length < 2 || list[0].at > now - this.windowMs * 0.9) return null;
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
}

export async function decide(
  client: PublicClient,
  s: RouterState,
  opts: { quoters: Quoters; minRouteWei: bigint; slippageBps: number; maxDeviationBps: number; reference: bigint | null },
): Promise<Decision> {
  const no = (reason: string): Decision => ({ route: false, reason, minRate: 0n });
  if (s.paused) return no('paused');
  if (!s.due) return no(`not due until ${new Date(Number(s.nextRouteAt) * 1000).toISOString()}`);
  const fresh = s.quoteBalance > s.feeFreeQuote ? s.quoteBalance - s.feeFreeQuote : 0n;
  if (fresh < opts.minRouteWei) return no(`only ${fresh} wei of new ETH`);
  if (opts.reference === null) return no('price window not yet covered');
  const dev = deviationBps(s.sqrtPriceX96, opts.reference);
  if (dev > opts.maxDeviationBps) return no(`price is ${dev.toFixed(0)} bps from its 30-minute average`);
  const out = await quoteTokenOut(client, s, s.swapIn, opts.quoters);
  return { route: true, reason: `swap ${s.swapIn} wei for about ${out}`, minRate: minRateFrom(s.swapIn, out, opts.slippageBps) };
}
