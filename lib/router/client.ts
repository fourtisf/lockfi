/**
 * The page's side of the LockFi Router (§48): reading routers from the
 * factory, and saying a revert in words.
 *
 * Every figure here is read from the contracts themselves, through the same
 * public RPC the builder reads through. Nothing is taken from the indexer,
 * which can be weeks behind, because what a router holds and has routed is
 * the one thing a team needs to see exactly.
 */

import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from 'viem';
import { CONTRACTS, ROUTER_FACTORY } from '../chain';
import { FACTORY_ABI, ROUTER_ABI, minRateFrom, quoteTokenOut, readRouter } from './plan';

export interface RouterView {
  address: Address;
  token: Address;
  team: Address;
  isV4: boolean;
  v3Pool: Address;
  narrow: boolean;
  cadence: number;
  paused: boolean;
  lastRouteAt: number;
  nextRouteAt: number;
  routes: number;
  /** ETH and WETH waiting to be routed, in wei. */
  quoteBalance: bigint;
  /** The token waiting to be routed, in its smallest unit. */
  tokenBalance: bigint;
  totalQuoteAdded: bigint;
  totalTokenAdded: bigint;
  totalFeePaid: bigint;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
}

const FIELDS = [
  'token',
  'team',
  'isV4',
  'v3Pool',
  'narrow',
  'cadence',
  'paused',
  'lastRouteAt',
  'nextRouteAt',
  'routes',
  'quoteBalance',
  'tokenBalance',
  'totalQuoteAdded',
  'totalTokenAdded',
  'totalFeePaid',
  'key',
] as const;

/** Every router's figures in one multicall. */
export async function readRouters(client: PublicClient, routers: readonly Address[]): Promise<RouterView[]> {
  if (routers.length === 0) return [];
  const calls = routers.flatMap((address) => FIELDS.map((functionName) => ({ address, abi: ROUTER_ABI, functionName })));
  const res = await client.multicall({ contracts: calls, allowFailure: false });
  return routers.map((address, i) => {
    const v = (f: (typeof FIELDS)[number]) => res[i * FIELDS.length + FIELDS.indexOf(f)] as never;
    return {
      address,
      token: v('token'),
      team: v('team'),
      isV4: v('isV4'),
      v3Pool: v('v3Pool'),
      narrow: v('narrow'),
      cadence: Number(v('cadence')),
      paused: v('paused'),
      lastRouteAt: Number(v('lastRouteAt')),
      nextRouteAt: Number(v('nextRouteAt')),
      routes: Number(v('routes')),
      quoteBalance: v('quoteBalance'),
      tokenBalance: v('tokenBalance'),
      totalQuoteAdded: v('totalQuoteAdded'),
      totalTokenAdded: v('totalTokenAdded'),
      totalFeePaid: v('totalFeePaid'),
      key: v('key'),
    };
  });
}

export async function allRouters(client: PublicClient): Promise<Address[]> {
  if (!ROUTER_FACTORY) return [];
  return (await client.readContract({ address: ROUTER_FACTORY, abi: FACTORY_ABI, functionName: 'routers' })) as Address[];
}

/**
 * The minimum rate a team's own "Route now" sends: Uniswap's quoter for the
 * swap the router would make, less 1%. A price that moves further before the
 * transaction lands reverts it, as the keeper's does.
 */
export async function teamMinRate(client: PublicClient, router: Address, slippageBps = 100): Promise<bigint> {
  const s = await readRouter(client, router);
  const out = await quoteTokenOut(client, s, s.swapIn, {
    v4Quoter: CONTRACTS.v4Quoter as Address,
    quoterV2: CONTRACTS.v3QuoterV2 as Address,
  });
  return minRateFrom(s.swapIn, out, slippageBps);
}

const WORDS: Record<string, string> = {
  NotAuthorized: 'Only the team that created this router, or the keeper, can do that.',
  NotDue: 'This router is not due yet.',
  IsPaused: 'This router is paused. Resume it to route.',
  NotPaused: 'Pause the router first: fees can be withdrawn only while it is paused.',
  Expired: 'The transaction took too long to land. Try again.',
  Slippage: 'The price moved more than 1% before the route landed, so nothing was routed. Try again.',
  HookOverdraw: "The pool's hook asked for more than the router holds, so nothing was routed.",
  TransferFailed: 'A transfer failed, so nothing was routed.',
  BadPool: 'That pool cannot take a router: it needs ETH or WETH on the other side, and a price.',
  BadCadence: 'Choose a schedule between one hour and thirty days.',
  NotOwner: 'Only the factory owner can do that.',
};

/** A revert from the router or the factory, in words; null if it is not one of theirs. */
export function describeRouterError(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName;
      if (name && WORDS[name]) return WORDS[name];
    }
  }
  return null;
}
