/**
 * What the router page needs to know about a token without waiting on the
 * indexer (§49): who created it, and which pools a router can be made for.
 *
 * Both are found through the explorer or an aggregator and proved on chain,
 * the rule §4 and §30 already follow: an outside source may name a
 * candidate, never state a fact.
 *
 * **Who created a token.** The explorer names the transaction that created
 * the token's contract. The chain then says who sent that transaction and
 * that the token was part of it. A token launched through a launchpad (Pons,
 * say) is created by the launchpad's contract, inside a transaction the
 * creator's own wallet sent, so "the sender of the creation transaction" is
 * the creator in both cases, and needs no knowledge of any launchpad.
 *
 * **Which pools.** The indexer is weeks behind (§25), so a token launched
 * since has no pool on the board. Pools are looked for directly:
 *   - v3: the factory's `getPool` against WETH at each standard fee;
 *   - v4: the common keys (ETH or WETH, standard fees, no hook) checked
 *     against the PoolManager, then any v4 pool id an aggregator lists for
 *     the token, whose key is recovered from its own Initialize log,
 *     read from the transaction's receipt and checked against the id;
 *   - and whatever the indexer already knows.
 * Only a pool with a price on chain and ETH or WETH on the other side is
 * returned.
 */

import {
  decodeEventLog,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { CONTRACTS, NATIVE_ETH } from '../../lib/chain';
import type { Pool } from '../../lib/data/types';
import { USER_AGENT } from '../indexer/logo-sources';

export type ChainRead = <T>(fn: (client: PublicClient) => Promise<T>) => Promise<T>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TokenMetaLite {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface Creator {
  /** The wallet that sent the transaction creating the token. */
  address: string;
  tx: string;
  /** The contract that created it (a launchpad), or null when the wallet deployed it itself. */
  via: string | null;
}

export interface PoolKeyLite {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface RouterPool {
  protocol: 'v3' | 'v4';
  /** v4: the pool id. v3: the pool's address. */
  id: string;
  key: PoolKeyLite;
  /** How the pool holds the ETH side. */
  quote: 'ETH' | 'WETH';
  /** The pool's active liquidity, raw, as a decimal string. */
  liquidity: string;
  /** The pool's liquidity in dollars when someone has measured it; null otherwise. */
  liquidityUsd: number | null;
  source: 'indexer' | 'chain' | 'aggregator';
}

/** A transaction a wallet sent, as the explorer lists it. */
export interface SentTx {
  hash: Hex;
  /** The contract it deployed directly, if any. */
  created: string | null;
  /** Whether it called a contract (a launchpad's `create`, say). */
  toContract: boolean;
}

/** ERC-20 `Transfer`: a token's supply is minted from the zero address in the transaction that creates it. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
/** How many of a wallet's contract calls have their receipts read for a mint. */
const SENT_RECEIPTS = 80;

export interface RouterTokenDeps {
  read: ChainRead;
  /** The transaction that created a token's contract, per the explorer; null if it does not say. */
  creationTx: (token: string) => Promise<Hex | null>;
  /** Tokens a wallet has held, per the explorer: candidates for what it created. */
  walletTokens: (wallet: string) => Promise<string[]>;
  /**
   * Transactions the wallet sent, per the explorer, newest first. The ones
   * that created a token are the strongest candidates: a launchpad's token
   * need never pass through its creator's wallet, so holding is not enough.
   */
  walletSent?: (wallet: string) => Promise<SentTx[]>;
  /** v4 pool ids an aggregator lists for a token, with the liquidity it measured. */
  v4PoolIds: (token: string) => Promise<{ id: Hex; liquidityUsd: number | null }[]>;
  /** The transaction that initialised a v4 pool, per the explorer. */
  initializeTx: (poolId: Hex) => Promise<Hex | null>;
  /** The pools the indexer already knows. */
  knownPools: () => Promise<Pool[]>;
  contracts?: { poolManager: string; v3Factory: string; weth: string };
  log?: (line: string) => void;
}

const ERC20 = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const PM = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const V3F = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
const V3POOL = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
]);
const INITIALIZE = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
export const INITIALIZE_TOPIC = keccak256(
  new TextEncoder().encode('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
);

/** Fee tiers and their usual spacings, as both venues deploy them. */
const TIERS: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];
const ZERO = '0x0000000000000000000000000000000000000000';

export function v4PoolId(k: PoolKeyLite): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [k.currency0 as Address, k.currency1 as Address, k.fee, k.tickSpacing, k.hooks as Address],
    ),
  );
}

function sortedKey(a: string, b: string, fee: number, tickSpacing: number, hooks: string): PoolKeyLite {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0: c0.toLowerCase(), currency1: c1.toLowerCase(), fee, tickSpacing, hooks: hooks.toLowerCase() };
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export class RouterTokens {
  private creators = new Map<string, { value: Creator | null; at: number }>();
  private metas = new Map<string, TokenMetaLite>();
  private pools = new Map<string, { value: RouterPool[]; at: number }>();
  private mine = new Map<string, { value: (TokenMetaLite & { creator: Creator })[]; at: number }>();
  private readonly c: { poolManager: string; v3Factory: string; weth: string };

  constructor(private readonly deps: RouterTokenDeps) {
    this.c = deps.contracts ?? { poolManager: CONTRACTS.poolManager, v3Factory: CONTRACTS.v3Factory, weth: CONTRACTS.weth };
  }

  /**
   * Who created `token`: the sender of the transaction that created it, once
   * the chain confirms that transaction created or first touched the token.
   * A creator never changes, so a found one is kept; a miss is asked again
   * after ten minutes.
   */
  async creatorOf(token: string): Promise<Creator | null> {
    const t = token.toLowerCase();
    const hit = this.creators.get(t);
    if (hit && (hit.value || Date.now() - hit.at < 600_000)) return hit.value;
    let value: Creator | null = null;
    try {
      const hash = await this.deps.creationTx(t);
      if (hash) {
        value = await this.deps.read(async (client) => {
          const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
          if (receipt.status !== 'success') return null;
          const direct = receipt.contractAddress?.toLowerCase() === t;
          // A launchpad's creation leaves the new token's own logs (its mint)
          // in the same receipt; a transaction that never touched it does not.
          const touched = direct || receipt.logs.some((l) => l.address.toLowerCase() === t);
          if (!touched) return null;
          return { address: tx.from.toLowerCase(), tx: hash, via: direct ? null : (tx.to?.toLowerCase() ?? null) };
        });
      }
    } catch (e) {
      this.deps.log?.(`router: could not read the creator of ${t}: ${(e as Error).message.split('\n')[0]}`);
      return hit?.value ?? null;
    }
    this.creators.set(t, { value, at: Date.now() });
    return value;
  }

  async creatorsOf(tokens: string[]): Promise<Record<string, Creator | null>> {
    const unique = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 100);
    const found = await inBatches(unique, 4, (t) => this.creatorOf(t));
    return Object.fromEntries(unique.map((t, i) => [t, found[i]]));
  }

  async tokenMeta(token: string): Promise<TokenMetaLite | null> {
    const t = token.toLowerCase();
    const hit = this.metas.get(t);
    if (hit) return hit;
    try {
      const meta = await this.deps.read(async (client) => {
        const [symbol, name, decimals] = await Promise.all([
          client.readContract({ address: t as Address, abi: ERC20, functionName: 'symbol' }),
          client.readContract({ address: t as Address, abi: ERC20, functionName: 'name' }).catch(() => ''),
          client.readContract({ address: t as Address, abi: ERC20, functionName: 'decimals' }),
        ]);
        return { address: t, symbol, name, decimals: Number(decimals) };
      });
      this.metas.set(t, meta);
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * The tokens `wallet` created. Candidates come from three places, and every
   * one is then proved the same way (`creatorOf`):
   *
   * - the contracts the wallet's own transactions deployed, or minted a new
   *   supply in — a launchpad's token is minted inside the launch
   *   transaction the creator sent, whoever the supply goes to;
   * - the tokens the explorer says the wallet has held;
   * - the board's tokens whose creator is already known.
   *
   * A wallet's answer is kept for five minutes (one minute when empty), so a
   * page that asks on every connect does not re-read a hundred receipts.
   */
  async createdBy(wallet: string): Promise<(TokenMetaLite & { creator: Creator })[]> {
    const w = wallet.toLowerCase();
    const hit = this.mine.get(w);
    if (hit && Date.now() - hit.at < (hit.value.length > 0 ? 300_000 : 60_000)) return hit.value;
    const [sent, held] = await Promise.all([
      this.deps.walletSent ? this.deps.walletSent(w).catch(() => [] as SentTx[]) : Promise.resolve([] as SentTx[]),
      this.deps.walletTokens(w).catch(() => [] as string[]),
    ]);
    const launched = await this.mintedIn(sent);
    const known = (await this.deps.knownPools().catch(() => [] as Pool[])).map((p) => p.token.address.toLowerCase());
    // The board's creators are learned in the background: asked all at once
    // they would hold a first connect for the explorer's time per token.
    this.warmCreators(known);
    const knownMine = known.filter((t) => this.creators.get(t)?.value?.address === w);
    const weth = this.c.weth.toLowerCase();
    const candidates = [...new Set([...launched, ...held.map((t) => t.toLowerCase()), ...knownMine])]
      .filter((t) => t !== weth)
      .slice(0, 100);
    const creators = await this.creatorsOf(candidates);
    const mine = candidates.filter((t) => creators[t]?.address === w);
    const metas = await Promise.all(mine.map((t) => this.tokenMeta(t)));
    const value = mine.flatMap((t, i) => (metas[i] ? [{ ...metas[i]!, creator: creators[t]! }] : []));
    this.mine.set(w, { value, at: Date.now() });
    return value;
  }

  /** The contracts a wallet's transactions deployed, or minted a fresh supply of. */
  private async mintedIn(sent: SentTx[]): Promise<string[]> {
    const out = new Set<string>();
    for (const t of sent) if (t.created) out.add(t.created.toLowerCase());
    const calls = sent.filter((t) => !t.created && t.toContract).slice(0, SENT_RECEIPTS);
    const found = await inBatches(calls, 6, async (t) => {
      try {
        const receipt = await this.deps.read((client) => client.getTransactionReceipt({ hash: t.hash }));
        if (receipt.status !== 'success') return [];
        if (receipt.contractAddress) return [receipt.contractAddress.toLowerCase()];
        // an ERC-20 mint (three topics; an NFT's has four) from the zero address
        return receipt.logs
          .filter((l) => l.topics.length === 3 && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics[1]?.toLowerCase() === ZERO_TOPIC)
          .map((l) => l.address.toLowerCase());
      } catch {
        return [];
      }
    });
    for (const list of found) for (const a of list) out.add(a);
    return [...out];
  }

  private warmedAt = 0;
  private warmCreators(tokens: string[]): void {
    if (tokens.length === 0 || Date.now() - this.warmedAt < 600_000) return;
    this.warmedAt = Date.now();
    void this.creatorsOf(tokens).catch(() => undefined);
  }

  /** The pools a router can be made for, deepest first. Kept for a minute. */
  async poolsFor(token: string): Promise<RouterPool[]> {
    const t = token.toLowerCase();
    const hit = this.pools.get(t);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const weth = this.c.weth.toLowerCase();
    const found = new Map<string, RouterPool>();
    const add = (p: RouterPool) => {
      const prev = found.get(p.id);
      // what the indexer or an aggregator measured in dollars is kept over a bare chain read
      if (!prev || (prev.liquidityUsd === null && p.liquidityUsd !== null)) found.set(p.id, p);
    };

    // what the indexer knows, with its dollar figures
    for (const p of await this.deps.knownPools().catch(() => [] as Pool[])) {
      if (p.token.address.toLowerCase() !== t || !p.key) continue;
      const k = p.key;
      const other = k.currency0.toLowerCase() === t ? k.currency1.toLowerCase() : k.currency0.toLowerCase();
      if (other !== NATIVE_ETH && other !== weth) continue;
      const key = { currency0: k.currency0.toLowerCase(), currency1: k.currency1.toLowerCase(), fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks.toLowerCase() };
      add({
        protocol: p.protocol,
        id: p.protocol === 'v4' ? v4PoolId(key) : p.address.toLowerCase(),
        key,
        quote: other === NATIVE_ETH ? 'ETH' : 'WETH',
        liquidity: '0',
        liquidityUsd: p.tvlUsd > 0 ? p.tvlUsd : null,
        source: 'indexer',
      });
    }

    // v3: the factory's own pools against WETH
    try {
      const v3 = await this.deps.read((client) =>
        Promise.all(
          TIERS.map(([fee]) =>
            client.readContract({ address: this.c.v3Factory as Address, abi: V3F, functionName: 'getPool', args: [t as Address, weth as Address, fee] }),
          ),
        ),
      );
      for (let i = 0; i < TIERS.length; i++) {
        const pool = v3[i].toLowerCase();
        if (pool === ZERO) continue;
        add({ protocol: 'v3', id: pool, key: sortedKey(t, weth, TIERS[i][0], TIERS[i][1], ZERO), quote: 'WETH', liquidity: '0', liquidityUsd: null, source: 'chain' });
      }
    } catch (e) {
      this.deps.log?.(`router: v3 lookup for ${t} failed: ${(e as Error).message.split('\n')[0]}`);
    }

    // v4: the common keys, with no hook
    for (const quote of [NATIVE_ETH, weth]) {
      for (const [fee, spacing] of TIERS) {
        const key = sortedKey(t, quote, fee, spacing, ZERO);
        add({ protocol: 'v4', id: v4PoolId(key), key, quote: quote === NATIVE_ETH ? 'ETH' : 'WETH', liquidity: '0', liquidityUsd: null, source: 'chain' });
      }
    }

    // v4: pools an aggregator lists, their keys recovered from their own Initialize
    const listed = await this.deps.v4PoolIds(t).catch(() => []);
    for (const { id, liquidityUsd } of listed.slice(0, 6)) {
      const known = found.get(id.toLowerCase());
      if (known) {
        if (known.liquidityUsd === null) known.liquidityUsd = liquidityUsd;
        continue;
      }
      const key = await this.keyFromInitialize(id).catch(() => null);
      if (!key) continue;
      const other = key.currency0 === t ? key.currency1 : key.currency1 === t ? key.currency0 : null;
      if (other !== NATIVE_ETH && other !== weth) continue;
      add({ protocol: 'v4', id: id.toLowerCase(), key, quote: other === NATIVE_ETH ? 'ETH' : 'WETH', liquidity: '0', liquidityUsd, source: 'aggregator' });
    }

    // only pools the chain says exist, with a price; their active liquidity, read now
    const checked = await this.deps
      .read((client) => Promise.all([...found.values()].map((p) => this.liveState(client, p))))
      .catch(() => [] as (RouterPool | null)[]);
    const value = checked.filter((p): p is RouterPool => p !== null).sort((a, b) => {
      if (a.liquidityUsd !== null || b.liquidityUsd !== null) return (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
      return BigInt(b.liquidity) > BigInt(a.liquidity) ? 1 : -1;
    });
    this.pools.set(t, { value, at: Date.now() });
    return value;
  }

  private async liveState(client: PublicClient, p: RouterPool): Promise<RouterPool | null> {
    if (p.protocol === 'v3') {
      const [slot0, liquidity] = await Promise.all([
        client.readContract({ address: p.id as Address, abi: V3POOL, functionName: 'slot0' }),
        client.readContract({ address: p.id as Address, abi: V3POOL, functionName: 'liquidity' }),
      ]).catch(() => [null, 0n] as const);
      if (!slot0 || slot0[0] === 0n) return null;
      return { ...p, liquidity: liquidity.toString() };
    }
    const state = keccak256(encodePacked(['bytes32', 'bytes32'], [p.id as Hex, `0x${'6'.padStart(64, '0')}`]));
    const liqSlot = `0x${(BigInt(state) + 3n).toString(16).padStart(64, '0')}` as Hex;
    const [slot0, liq] = await Promise.all([
      client.readContract({ address: this.c.poolManager as Address, abi: PM, functionName: 'extsload', args: [state] }),
      client.readContract({ address: this.c.poolManager as Address, abi: PM, functionName: 'extsload', args: [liqSlot] }),
    ]);
    if ((BigInt(slot0) & ((1n << 160n) - 1n)) === 0n) return null;
    return { ...p, liquidity: (BigInt(liq) & ((1n << 128n) - 1n)).toString() };
  }

  /** A v4 pool's key, from the Initialize log in the transaction that created it, checked against its id. */
  private async keyFromInitialize(id: Hex): Promise<PoolKeyLite | null> {
    const hash = await this.deps.initializeTx(id);
    if (!hash) return null;
    return this.deps.read(async (client) => {
      const receipt = await client.getTransactionReceipt({ hash });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== this.c.poolManager.toLowerCase() || log.topics[0] !== INITIALIZE_TOPIC) continue;
        const ev = decodeEventLog({ abi: INITIALIZE, data: log.data, topics: log.topics });
        const a = ev.args;
        const key = {
          currency0: a.currency0.toLowerCase(),
          currency1: a.currency1.toLowerCase(),
          fee: a.fee,
          tickSpacing: a.tickSpacing,
          hooks: a.hooks.toLowerCase(),
        };
        if (v4PoolId(key) === id.toLowerCase()) return key;
      }
      return null;
    });
  }
}

// ── the explorer and the aggregator, as the defaults ───────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function getJson(fetchFn: Fetch, url: string, timeoutMs = 6_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Blockscout's creation transaction for a contract. It has spelled the field two ways. */
export function explorerCreationTx(base: string, fetchFn: Fetch = fetch) {
  const root = base.replace(/\/+$/, '');
  return async (token: string): Promise<Hex | null> => {
    const body = asRecord(await getJson(fetchFn, `${root}/api/v2/addresses/${token}`));
    const hash = body?.creation_transaction_hash ?? body?.creation_tx_hash;
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash.toLowerCase() as Hex) : null;
  };
}

/** The ERC-20s a wallet has sent or received, per Blockscout: two pages of transfers. */
export function explorerWalletTokens(base: string, fetchFn: Fetch = fetch) {
  const root = base.replace(/\/+$/, '');
  return async (wallet: string): Promise<string[]> => {
    const tokens = new Set<string>();
    let params: Record<string, unknown> | null = { type: 'ERC-20' };
    for (let page = 0; params && page < 2; page++) {
      const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      const body = asRecord(await getJson(fetchFn, `${root}/api/v2/addresses/${wallet}/token-transfers?${query}`));
      for (const raw of Array.isArray(body?.items) ? body!.items : []) {
        const token = asRecord(asRecord(raw)?.token);
        const a = token?.address_hash ?? token?.address;
        if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) tokens.add(a.toLowerCase());
      }
      const next = asRecord(body?.next_page_params);
      params = next ? { type: 'ERC-20', ...next } : null;
    }
    return [...tokens];
  };
}

/**
 * The transactions a wallet sent, newest first, per Blockscout: three pages.
 * Only the hash, what it deployed and whether it called a contract are read;
 * everything that follows is checked against the chain.
 */
export function explorerWalletSent(base: string, fetchFn: Fetch = fetch) {
  const root = base.replace(/\/+$/, '');
  return async (wallet: string): Promise<SentTx[]> => {
    const out: SentTx[] = [];
    let params: Record<string, unknown> | null = { filter: 'from' };
    for (let page = 0; params && page < 3; page++) {
      const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      const body = asRecord(await getJson(fetchFn, `${root}/api/v2/addresses/${wallet}/transactions?${query}`));
      for (const raw of Array.isArray(body?.items) ? body!.items : []) {
        const item = asRecord(raw);
        const hash = item?.hash;
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) continue;
        if (item?.status === 'error') continue;
        const from = asRecord(item?.from)?.hash;
        if (typeof from === 'string' && from.toLowerCase() !== wallet.toLowerCase()) continue;
        const created = asRecord(item?.created_contract)?.hash;
        const to = asRecord(item?.to);
        out.push({
          hash: hash.toLowerCase() as Hex,
          created: typeof created === 'string' && /^0x[0-9a-fA-F]{40}$/.test(created) ? created.toLowerCase() : null,
          // a field it leaves out is not a no: only an address it calls an account is skipped
          toContract: to !== null && to.is_contract !== false,
        });
      }
      const next = asRecord(body?.next_page_params);
      params = next ? { filter: 'from', ...next } : null;
    }
    return out;
  };
}

/** The transaction that initialised a v4 pool: its Initialize log, found through Blockscout's logs API. */
export function explorerInitializeTx(base: string, poolManager: string = CONTRACTS.poolManager, fetchFn: Fetch = fetch) {
  const root = base.replace(/\/+$/, '');
  return async (poolId: Hex): Promise<Hex | null> => {
    const query = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      fromBlock: '0',
      toBlock: 'latest',
      address: poolManager.toLowerCase(),
      topic0: INITIALIZE_TOPIC,
      topic1: poolId.toLowerCase(),
      topic0_1_opr: 'and',
    });
    const body = asRecord(await getJson(fetchFn, `${root}/api?${query}`));
    const row = Array.isArray(body?.result) ? asRecord(body!.result[0]) : null;
    const hash = row?.transactionHash;
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash.toLowerCase() as Hex) : null;
  };
}

/** v4 pool ids DexScreener lists for a token on this chain, with the liquidity it measured. */
export function dexscreenerV4PoolIds(base: string, chain: string | null, fetchFn: Fetch = fetch) {
  const root = base.replace(/\/+$/, '');
  return async (token: string): Promise<{ id: Hex; liquidityUsd: number | null }[]> => {
    const body = asRecord(await getJson(fetchFn, `${root}/latest/dex/tokens/${token}`));
    const out: { id: Hex; liquidityUsd: number | null }[] = [];
    for (const raw of Array.isArray(body?.pairs) ? body!.pairs : []) {
      const pair = asRecord(raw);
      if (!pair) continue;
      if (chain && pair.chainId !== chain) continue;
      const id = pair.pairAddress;
      // a v4 pool is named by its 32-byte id; a v3 pool (a 20-byte address) is found through the factory instead
      if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
      const liq = Number(asRecord(pair.liquidity)?.usd);
      out.push({ id: id.toLowerCase() as Hex, liquidityUsd: Number.isFinite(liq) && liq > 0 ? liq : null });
    }
    return out;
  };
}
