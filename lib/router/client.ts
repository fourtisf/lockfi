/**
 * The page's side of the LockFi Router (§48): reading routers from the
 * factory, and saying a revert in words.
 *
 * Every figure here is read from the contracts themselves, through the same
 * public RPC the builder reads through. Nothing is taken from the indexer,
 * which can be weeks behind, because what a router holds and has routed is
 * the one thing a team needs to see exactly.
 */

import { BaseError, ContractFunctionRevertedError, decodeEventLog, type Address, type PublicClient, type TransactionReceipt } from 'viem';
import { CONTRACTS, ROUTER_FACTORY } from '../chain';
import { API_BASE } from '../site';
import { FACTORY_ABI, ROUTER_ABI, readRouter, teamBand } from './plan';

export interface RouterView {
  address: Address;
  token: Address;
  team: Address;
  isV4: boolean;
  v3Pool: Address;
  narrow: boolean;
  cadence: number;
  paused: boolean;
  /** Whether the factory's keeper may route it; the team decides. */
  keeperAllowed: boolean;
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
  /** LockFi's fee, charged and not yet accepted by the treasury: never routed, never the team's. */
  feeOwed: bigint;
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
  'keeperAllowed',
  'lastRouteAt',
  'nextRouteAt',
  'routes',
  'quoteBalance',
  'tokenBalance',
  'totalQuoteAdded',
  'totalTokenAdded',
  'totalFeePaid',
  'feeOwed',
  'key',
] as const;

/**
 * Every router's figures in one multicall. Each router is read on its own
 * terms: anyone can create a router for a token that refuses to answer, and
 * one such router must never blank the list for everyone else. Those come
 * back as `unreadable`.
 */
export async function readRouters(client: PublicClient, routers: readonly Address[]): Promise<{ views: RouterView[]; unreadable: Address[] }> {
  if (routers.length === 0) return { views: [], unreadable: [] };
  const calls = routers.flatMap((address) => FIELDS.map((functionName) => ({ address, abi: ROUTER_ABI, functionName })));
  const res = await client.multicall({ contracts: calls, allowFailure: true, multicallAddress: CONTRACTS.multicall3 as Address });
  const views: RouterView[] = [];
  const unreadable: Address[] = [];
  routers.forEach((address, i) => {
    const slice = res.slice(i * FIELDS.length, (i + 1) * FIELDS.length);
    if (slice.some((x) => x.status !== 'success')) {
      unreadable.push(address);
      return;
    }
    const v = (f: (typeof FIELDS)[number]) => slice[FIELDS.indexOf(f)].result as never;
    views.push({
      address,
      token: v('token'),
      team: v('team'),
      isV4: v('isV4'),
      v3Pool: v('v3Pool'),
      narrow: v('narrow'),
      cadence: Number(v('cadence')),
      paused: v('paused'),
      keeperAllowed: v('keeperAllowed'),
      lastRouteAt: Number(v('lastRouteAt')),
      nextRouteAt: Number(v('nextRouteAt')),
      routes: Number(v('routes')),
      quoteBalance: v('quoteBalance'),
      tokenBalance: v('tokenBalance'),
      totalQuoteAdded: v('totalQuoteAdded'),
      totalTokenAdded: v('totalTokenAdded'),
      totalFeePaid: v('totalFeePaid'),
      feeOwed: v('feeOwed'),
      key: v('key'),
    });
  });
  return { views, unreadable };
}

/** Every router the factory lists, a page at a time: the list is anyone's to lengthen. */
export async function allRouters(client: PublicClient, max = 1_000): Promise<Address[]> {
  if (!ROUTER_FACTORY) return [];
  const out: Address[] = [];
  for (let start = 0; start < max; start += 200) {
    const page = (await client.readContract({
      address: ROUTER_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'routersPage',
      args: [BigInt(start), 200n],
    })) as Address[];
    out.push(...page);
    if (page.length < 200) break;
  }
  return out;
}

/** The routers a wallet created, from the factory's own index: a team can always reach its own. */
export async function routersForTeam(client: PublicClient, team: Address): Promise<Address[]> {
  if (!ROUTER_FACTORY) return [];
  return (await client.readContract({ address: ROUTER_FACTORY, abi: FACTORY_ABI, functionName: 'routersForTeam', args: [team] })) as Address[];
}

/** The fee the deployed factory takes, in bps, as the chain says rather than as this site assumes. */
export async function factoryFeeBps(client: PublicClient): Promise<number | null> {
  if (!ROUTER_FACTORY) return null;
  return Number(await client.readContract({ address: ROUTER_FACTORY, abi: FACTORY_ABI, functionName: 'feeBps' }));
}

/**
 * The arguments a team's own "Route now" sends: a band of ±2% around the
 * pool's price, read a moment before, and the minimum rate at its worse edge.
 * The swap stops at the band's edge, so a price pushed further between
 * reading and landing leaves the rest waiting instead of trading into it.
 */
export async function teamRouteArgs(client: PublicClient, router: Address, deadline: bigint): Promise<readonly [bigint, bigint, bigint, bigint]> {
  const s = await readRouter(client, router);
  const b = teamBand(s);
  return [b.minRate, b.lo, b.hi, deadline] as const;
}

/**
 * The router a create transaction deployed, from its own receipt. Never the
 * simulated result: the factory's next address is whoever lands first, and
 * showing a team another caller's router would send its fees to a stranger.
 */
export function routerFromReceipt(receipt: TransactionReceipt, team: string): Address | null {
  if (!ROUTER_FACTORY) return null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ROUTER_FACTORY.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics });
      const args = ev.args as unknown as { router: Address; team: Address };
      if (ev.eventName === 'RouterCreated' && args.team.toLowerCase() === team.toLowerCase()) return args.router;
    } catch {
      /* another event */
    }
  }
  return null;
}

const WORDS: Record<string, string> = {
  NotAuthorized: 'Only the team that created this router, or the keeper, can do that.',
  NotDue: 'This router is not due yet.',
  IsPaused: 'This router is paused. Resume it to route.',
  NotPaused: 'Pause the router first: fees can be withdrawn only while it is paused.',
  Expired: 'The transaction took too long to land. Try again.',
  Slippage: 'The swap would have paid more than the minimum allows, so nothing was routed. Try again.',
  HookOverdraw: "The pool asked the router for more than the route planned, so nothing was routed.",
  BadBounds: 'The price band sent with the route was not valid, so nothing was routed.',
  PriceOutOfBounds: 'The price moved outside the band before the route landed, so nothing was routed. Try again.',
  BadHook: "That pool's hook can act on liquidity, which a router cannot safely add to. Choose a pool without one.",
  BadAddress: 'That address cannot be used here.',
  TooEarly: 'The new keeper cannot take over yet: the delay has not passed.',
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

// ── the API's token lookups (server/api/router-tokens.ts, §49) ───────────────


export interface TokenMetaLite {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}
export interface Creator {
  address: string;
  tx: string;
  via: string | null;
}
export interface RouterPool {
  protocol: 'v3' | 'v4';
  id: string;
  key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  quote: 'ETH' | 'WETH';
  liquidity: string;
  liquidityUsd: number | null;
  source: 'indexer' | 'chain' | 'aggregator';
}
export interface TokenLookup {
  token: TokenMetaLite;
  creator: Creator | null;
  pools: RouterPool[];
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The tokens a wallet created, proved on chain by the API; null if it could not be asked. */
export async function tokensCreatedBy(wallet: string): Promise<(TokenMetaLite & { creator: Creator })[] | null> {
  const body = await getJson<{ tokens: (TokenMetaLite & { creator: Creator })[] }>(`/api/router/mine?wallet=${wallet}`);
  return body ? body.tokens : null;
}

/** A token, its creator and the pools a router can be made for; null if it is not a token or could not be asked. */
export async function lookupToken(address: string): Promise<TokenLookup | null> {
  return getJson<TokenLookup>(`/api/router/token/${address}`);
}

export async function creatorsOf(tokens: string[]): Promise<Record<string, Creator | null>> {
  if (tokens.length === 0) return {};
  const body = await getJson<{ creators: Record<string, Creator | null> }>(`/api/router/creators?tokens=${tokens.join(',')}`);
  return body?.creators ?? {};
}

export const ZERO_HOOK = '0x0000000000000000000000000000000000000000';

/**
 * Hook permissions that act on liquidity: before/after add and remove, and
 * the two liquidity return deltas. The factory refuses a pool whose hook has
 * any of them (LIQUIDITY_HOOK_FLAGS in LockFiRouterFactory.sol).
 */
export const LIQUIDITY_HOOK_FLAGS = 0xf03n;
export function hookActsOnLiquidity(hooks: string): boolean {
  return (BigInt(hooks) & LIQUIDITY_HOOK_FLAGS) !== 0n;
}
