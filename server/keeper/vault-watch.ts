/**
 * The vault watcher: each deployed vault's pool, read live from the chain.
 *
 * The pool indexer (server/indexer) is crossing months of chain history, and
 * every figure on the boards is as of the last swap it has read — on the day
 * this was written, 8 July, four months behind. A vault is where money goes
 * in, and its figures cannot wait for that. So, every minute, for each vault:
 *
 *   1. its pool's Swap logs since the last read (the trailing eight days on
 *      the first run), filtered by pool id — a few hundred logs a minute;
 *   2. the pool's state at that block from StateView: price, in-range
 *      liquidity, fee growth; and the vault's own liquidity (totalSupply).
 *
 * From those the snapshot computes the vault's figures (server/api/
 * vault-live.ts): fees and volume over the last 24 hours, and what a
 * full-range position — exactly what the vault holds — actually earned over
 * the trailing seven days (vault-math.ts). Nothing here depends on the pool
 * indexer, its anchor or its prices.
 *
 * Progress is durable: the swap cursor is written after every chunk, so a
 * restart mid-backfill resumes where it stopped. Re-reading blocks changes
 * nothing (rows are keyed by log coordinates). A watcher down for longer
 * than the window resumes at the window's start, and says the history it
 * has begins there.
 */

import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import type { VaultDeployment } from '../../lib/contracts/deployments';
import { robinhoodChain } from '../chain/client';
import { RPC_URLS } from '../chain/endpoints';
import { prisma } from '../db';
import { blockAtTime, feeGrowthStep, interpolateTime, lpFeeOfSwap } from './vault-math';

/** Swap history kept and read on a first run: the 7-day window plus a day of margin. */
export const WATCH_WINDOW_DAYS = 8;
/** Blocks re-read every pass, for a reorg (§4.1 uses the same depth). */
const REORG_DEPTH = 32n;
const INITIAL_CHUNK = 50_000n;
const MIN_CHUNK = 1_000n;
const MAX_CHUNK = 100_000n;

const SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)',
]);
const VAULT_ABI = parseAbi([
  'function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function totalSupply() view returns (uint256)',
]);
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

const ZERO = '0x0000000000000000000000000000000000000000';

export interface RawSwap {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
}

export interface PoolChainState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  feeGrowth0X128: bigint;
  feeGrowth1X128: bigint;
}

/** What the watcher needs from a chain: small enough to mock in a test. */
export interface WatchClient {
  head(): Promise<{ number: bigint; timestamp: number }>;
  blockTime(block: bigint): Promise<number>;
  swapLogs(poolId: Hex, fromBlock: bigint, toBlock: bigint): Promise<RawSwap[]>;
  poolState(poolId: Hex, block: bigint): Promise<PoolChainState>;
  vaultKey(vault: Address): Promise<{ currency0: string; currency1: string; fee: number }>;
  vaultSupply(vault: Address, block: bigint): Promise<bigint>;
  token(address: string): Promise<{ symbol: string; decimals: number }>;
}

interface VaultMeta {
  poolId: string;
  poolIdHex: Hex;
  vault: Address;
  currency0: string;
  currency1: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  lpFeePips: number;
}

export function vaultSwapCursorKey(poolId: string): string {
  return `vault-swaps:${poolId.toLowerCase()}`;
}

/** True when an RPC error is the endpoint refusing a range as too large. */
function isRangeRefusal(message: string): boolean {
  // The chain's own endpoint answers an oversized range with "Missing or
  // invalid parameters": narrowing is the answer to that too.
  return /more than|too many|limit|exceed|range|10000|too large|response size|invalid parameters/i.test(message);
}

export interface VaultWatcherOptions {
  client: WatchClient;
  vaults: VaultDeployment[];
  log?: (message: string) => void;
  windowDays?: number;
}

export class VaultWatcher {
  private readonly client: WatchClient;
  private readonly vaults: VaultDeployment[];
  private readonly log: (message: string) => void;
  private readonly windowSeconds: number;
  private readonly meta = new Map<string, VaultMeta>();
  private chunk = INITIAL_CHUNK;
  private readonly failing = new Set<string>();

  constructor(options: VaultWatcherOptions) {
    this.client = options.client;
    this.vaults = options.vaults;
    this.log = options.log ?? (() => {});
    this.windowSeconds = (options.windowDays ?? WATCH_WINDOW_DAYS) * 86_400;
  }

  /** One pass over every vault. Never throws: a failure is logged and retried next pass. */
  async tick(): Promise<void> {
    let head: { number: bigint; timestamp: number };
    try {
      head = await this.client.head();
    } catch (error) {
      this.say('head', `vault watcher: could not read the chain head — ${firstLine(error)}`);
      return;
    }
    for (const deployment of this.vaults) {
      try {
        await this.watch(deployment, head);
        if (this.failing.delete(deployment.address)) this.log(`vault watcher: ${deployment.address} is being read again`);
      } catch (error) {
        this.say(deployment.address, `vault watcher: ${deployment.address} — ${firstLine(error)}`);
      }
    }
  }

  /** Log a failure once until it clears, not every minute. */
  private say(key: string, message: string): void {
    if (this.failing.has(key)) return;
    this.failing.add(key);
    this.log(message);
  }

  private async metaFor(deployment: VaultDeployment): Promise<VaultMeta> {
    const known = this.meta.get(deployment.address);
    if (known) return known;
    const poolIdHex = deployment.poolId.replace(/^v4:/, '').toLowerCase() as Hex;
    if (!/^0x[0-9a-f]{64}$/.test(poolIdHex)) throw new Error(`not a v4 pool id: ${deployment.poolId}`);
    const key = await this.client.vaultKey(deployment.address);
    const describe = async (currency: string) =>
      currency.toLowerCase() === ZERO ? { symbol: 'ETH', decimals: 18 } : this.client.token(currency);
    const [t0, t1] = [await describe(key.currency0), await describe(key.currency1)];
    const meta: VaultMeta = {
      poolId: deployment.poolId.toLowerCase(),
      poolIdHex,
      vault: deployment.address,
      currency0: key.currency0.toLowerCase(),
      currency1: key.currency1.toLowerCase(),
      symbol0: t0.symbol,
      symbol1: t1.symbol,
      decimals0: t0.decimals,
      decimals1: t1.decimals,
      lpFeePips: key.fee,
    };
    this.meta.set(deployment.address, meta);
    return meta;
  }

  private async watch(deployment: VaultDeployment, head: { number: bigint; timestamp: number }): Promise<void> {
    const meta = await this.metaFor(deployment);
    const cursorKey = vaultSwapCursorKey(meta.poolId);
    const [cursor, state] = await Promise.all([
      prisma.indexerCursor.findUnique({ where: { contract: cursorKey } }),
      prisma.vaultPoolState.findUnique({ where: { poolId: meta.poolId } }),
    ]);

    const windowStartTime = head.timestamp - this.windowSeconds;
    let historyFromBlock = state?.historyFromBlock ?? null;
    let historyFromTime = state ? Math.floor(state.historyFromTime.getTime() / 1000) : null;
    if (cursor && !state) {
      // A first backfill that stopped part-way: its history begins at the
      // first swap it wrote, which the cursor resumes after.
      const first = await prisma.vaultSwap.findFirst({ where: { poolId: meta.poolId }, orderBy: [{ blockNum: 'asc' }, { logIndex: 'asc' }] });
      if (first) {
        historyFromBlock = first.blockNum;
        historyFromTime = Math.floor(first.blockTime.getTime() / 1000);
      }
    }
    let from: bigint;
    let fromTime: number;
    const resumable =
      cursor && historyFromBlock !== null && Math.floor(cursor.lastIndexedAt.getTime() / 1000) >= windowStartTime;
    if (cursor && resumable) {
      from = cursor.lastIndexedBlock - REORG_DEPTH + 1n;
      if (historyFromBlock !== null && from < historyFromBlock) from = historyFromBlock;
      fromTime = Math.floor(cursor.lastIndexedAt.getTime() / 1000);
    } else {
      // A first run, or one back after longer than the window: start at the
      // window's beginning and say that is where the history begins.
      from = await blockAtTime(windowStartTime, head.number, head.timestamp, (b) => this.client.blockTime(b), BigInt(Math.max(0, deployment.deployedBlock - 50_000_000)));
      fromTime = await this.client.blockTime(from);
      historyFromBlock = from;
      historyFromTime = fromTime;
      this.log(
        `vault watcher: ${meta.symbol0}/${meta.symbol1} vault ${meta.vault} — reading the pool's swaps from block ${from} ` +
          `(${new Date(fromTime * 1000).toISOString()}) to ${head.number}`,
      );
    }

    // Swaps, chunk by chunk, the cursor written after each.
    let read = 0;
    let start = from;
    let startTime = fromTime;
    while (start <= head.number) {
      const end = start + this.chunk - 1n > head.number ? head.number : start + this.chunk - 1n;
      let logs: RawSwap[];
      try {
        logs = await this.client.swapLogs(meta.poolIdHex, start, end);
      } catch (error) {
        const message = firstLine(error);
        if (isRangeRefusal(message) && this.chunk > MIN_CHUNK) {
          this.chunk = this.chunk / 2n < MIN_CHUNK ? MIN_CHUNK : this.chunk / 2n;
          continue;
        }
        throw error;
      }
      const endTime = end === head.number ? head.timestamp : await this.client.blockTime(end);
      await writeSwaps(meta, logs, start - 1n, startTime, end, endTime);
      await prisma.indexerCursor.upsert({
        where: { contract: cursorKey },
        create: { contract: cursorKey, lastIndexedBlock: end, lastIndexedAt: new Date(endTime * 1000), updatedAt: new Date() },
        update: { lastIndexedBlock: end, lastIndexedAt: new Date(endTime * 1000), updatedAt: new Date() },
      });
      read += logs.length;
      start = end + 1n;
      startTime = endTime;
      if (this.chunk < MAX_CHUNK) this.chunk *= 2n;
    }

    // The pool and the vault at the block the swaps were read to.
    const [pool, supply] = [
      await this.client.poolState(meta.poolIdHex, head.number),
      await this.client.vaultSupply(meta.vault, head.number),
    ];

    // Keep the window, and say where the history now begins.
    const cutoff = new Date((head.timestamp - this.windowSeconds - 86_400) * 1000);
    await prisma.vaultSwap.deleteMany({ where: { poolId: meta.poolId, blockTime: { lt: cutoff } } });
    if (historyFromTime !== null && historyFromTime * 1000 < cutoff.getTime()) {
      historyFromTime = Math.floor(cutoff.getTime() / 1000);
    }

    const row = {
      vaultAddress: meta.vault.toLowerCase(),
      currency0: meta.currency0,
      currency1: meta.currency1,
      symbol0: meta.symbol0,
      symbol1: meta.symbol1,
      decimals0: meta.decimals0,
      decimals1: meta.decimals1,
      lpFeePips: meta.lpFeePips,
      blockNum: head.number,
      blockTime: new Date(head.timestamp * 1000),
      sqrtPrice: pool.sqrtPriceX96.toString(),
      tick: pool.tick,
      liquidity: pool.liquidity.toString(),
      vaultLiquidity: supply.toString(),
      feeGrowth0X128: pool.feeGrowth0X128.toString(),
      feeGrowth1X128: pool.feeGrowth1X128.toString(),
      historyFromBlock: historyFromBlock ?? from,
      historyFromTime: new Date((historyFromTime ?? fromTime) * 1000),
      updatedAt: new Date(),
    };
    await prisma.vaultPoolState.upsert({ where: { poolId: meta.poolId }, create: { poolId: meta.poolId, ...row }, update: row });
    if (!state) this.log(`vault watcher: ${meta.symbol0}/${meta.symbol1} vault ${meta.vault} — ${read} swaps read, live`);
  }
}

/** Swaps into vault_swaps, timestamps interpolated across the read range. */
async function writeSwaps(
  meta: VaultMeta,
  logs: RawSwap[],
  rangeStart: bigint,
  rangeStartTime: number,
  rangeEnd: bigint,
  rangeEndTime: number,
): Promise<void> {
  if (logs.length === 0) return;
  const rows = logs.map((l) => {
    const fee = lpFeeOfSwap(l.amount0, l.amount1, l.fee, meta.lpFeePips);
    return {
      poolId: meta.poolId,
      blockNum: l.blockNumber,
      logIndex: l.logIndex,
      txHash: l.txHash.toLowerCase(),
      blockTime: new Date(interpolateTime(l.blockNumber, rangeStart, rangeStartTime, rangeEnd, rangeEndTime) * 1000),
      amount0: l.amount0.toString(),
      amount1: l.amount1.toString(),
      sqrtPrice: l.sqrtPriceX96.toString(),
      liquidity: l.liquidity.toString(),
      tick: l.tick,
      swapFeePips: l.fee,
      lpFee: fee.lpFee.toString(),
      feeToken: fee.feeToken,
      amountIn: fee.amountIn.toString(),
      feeGrowthX128: feeGrowthStep(fee.lpFee, l.liquidity).toString(),
    };
  });
  // A re-read of the same blocks (the reorg re-scan) finds the rows there.
  for (let i = 0; i < rows.length; i += 1_000) {
    await prisma.vaultSwap.createMany({ data: rows.slice(i, i + 1_000), skipDuplicates: true });
  }
}

/** An error as one readable line: failover puts each endpoint's reason on its own line. */
function firstLine(error: unknown): string {
  const text = String((error as Error)?.message ?? error)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^(URL|Request body|Version|Details):/i.test(l))
    .join(' | ');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// A busy endpoint can also answer with a body that is not JSON-RPC at all,
// which viem reports as an unknown error: later, not no.
const RATE_LIMITED = /429|too many requests|rate limit|exceeded the rate|unknown RPC error|HTTP request failed|timed out/i;

/**
 * A chain read, waited out and retried when an endpoint says it is being
 * asked too often. Public endpoints answer 429 after a short burst — a
 * first backfill is a few hundred reads — and a 429 is "later", not "no".
 */
async function patiently<T>(fn: () => Promise<T>, attempts = 6, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i + 1 >= attempts || !RATE_LIMITED.test(String((error as Error)?.message ?? error))) throw error;
      await sleep(500 * 2 ** i);
    }
  }
}

/**
 * The watcher's own clients, one per configured endpoint, tried in order.
 * Not the indexer's (server/chain/client.ts): those send every call as a
 * JSON-RPC batch, and the chain's own endpoint, when busy, answers a batch
 * with a body viem cannot read. The watcher makes one call at a time.
 */
const watchClients: PublicClient[] = RPC_URLS.map(
  (url) =>
    createPublicClient({ chain: robinhoodChain, transport: http(url, { timeout: 20_000, retryCount: 2, retryDelay: 400 }) }) as PublicClient,
);
let preferred = 0;

async function rpc<T>(fn: (client: PublicClient) => Promise<T>, label: string): Promise<T> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < watchClients.length; attempt++) {
    const index = (preferred + attempt) % watchClients.length;
    try {
      const value = await fn(watchClients[index]);
      preferred = index;
      return value;
    } catch (error) {
      errors.push(`${RPC_URLS[index]}: ${String((error as Error)?.message ?? error).split('\n')[0]}`);
    }
  }
  throw new Error(`${label} failed on all ${watchClients.length} endpoints:\n  ${errors.join('\n  ')}`);
}

/** The watcher's chain, over the configured endpoints with failover. */
export function viemWatchClient(): WatchClient {
  const stateView = CONTRACTS.stateView as Address;
  const poolManager = CONTRACTS.poolManager as Address;
  return {
    head: async () => {
      const block = await patiently(() => rpc((c) => c.getBlock({ blockTag: 'latest' }), 'getBlock(latest)'));
      return { number: block.number, timestamp: Number(block.timestamp) };
    },
    blockTime: async (block) => {
      const b = await patiently(() => rpc((c) => c.getBlock({ blockNumber: block }), `getBlock(${block})`));
      return Number(b.timestamp);
    },
    swapLogs: async (poolId, fromBlock, toBlock) => {
      const logs = await patiently(() =>
        rpc(
          (c) => c.getLogs({ address: poolManager, event: SWAP_EVENT, args: { id: poolId }, fromBlock, toBlock }),
          `getLogs(Swap ${fromBlock}-${toBlock})`,
        ),
      );
      return logs.map((l) => ({
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        amount0: l.args.amount0 as bigint,
        amount1: l.args.amount1 as bigint,
        sqrtPriceX96: l.args.sqrtPriceX96 as bigint,
        liquidity: l.args.liquidity as bigint,
        tick: Number(l.args.tick),
        fee: Number(l.args.fee),
      }));
    },
    poolState: async (poolId, block) => {
      const read = <T>(functionName: 'getSlot0' | 'getLiquidity' | 'getFeeGrowthGlobals') =>
        patiently(() => rpc((c) => c.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName, args: [poolId], blockNumber: block }) as Promise<T>, functionName));
      const slot0 = await read<readonly [bigint, number, number, number]>('getSlot0');
      const liquidity = await read<bigint>('getLiquidity');
      const growth = await read<readonly [bigint, bigint]>('getFeeGrowthGlobals');
      return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity, feeGrowth0X128: growth[0], feeGrowth1X128: growth[1] };
    },
    vaultKey: async (vault) => {
      const key = await patiently(() => rpc((c) => c.readContract({ address: vault, abi: VAULT_ABI, functionName: 'poolKey' }), 'poolKey'));
      return { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee) };
    },
    vaultSupply: (vault, block) =>
      patiently(() => rpc((c) => c.readContract({ address: vault, abi: VAULT_ABI, functionName: 'totalSupply', blockNumber: block }), 'totalSupply')),
    token: async (address) => {
      const symbol = await patiently(() => rpc((c) => c.readContract({ address: address as Address, abi: ERC20_ABI, functionName: 'symbol' }), 'symbol'));
      const decimals = await patiently(() => rpc((c) => c.readContract({ address: address as Address, abi: ERC20_ABI, functionName: 'decimals' }), 'decimals'));
      return { symbol, decimals: Number(decimals) };
    },
  };
}
