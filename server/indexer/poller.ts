/**
 * The log poller (§4.1).
 *
 * Reads logs in ranges, writes raw rows, tracks `last_indexed_block` per
 * contract, and re-scans the last 32 blocks every pass because reorg depth on
 * an Orbit L2 is shallow but not zero. The re-scan is safe because every row
 * is upserted by `(txHash, logIndex)` and every aggregate is rebuilt rather
 * than incremented — see ingest.ts and aggregate.ts.
 *
 * The RPC layer is injectable. That is not for neatness: §9 requires proving
 * that a block-zero re-run and an incremental run produce identical rows, and
 * that is only testable against a log source you can replay exactly.
 */

import { CHAIN, CONTRACTS } from '../../lib/chain';
import { POOL_MANAGER_ABI, V3_POOL_ABI } from '../chain/abi';
import { env } from '../env';
import type { PriceAnchors } from './aggregate';
import { rebuildAggregates } from './aggregate';
import {
  classifyPools,
  ensureTokens,
  findAnchorPool,
  refreshSupplies,
  type TokenReader,
  adoptNativeEthPools,
} from './discovery';
import {
  decodePoolManagerLog,
  decodeV3FactoryLog,
  decodeV3PoolLog,
  sortEvents,
  type ChainEvent,
} from './events';
import { resolveUsdg } from './anchor';
import { planIngest } from './ingest';
import { refreshLogos } from './logos';
import { sweepLogos, type LogoSource } from './logo-sources';

/** How often the logo sweep may run. GeckoTerminal rate-limits a burst. */
const LOGO_SWEEP_MS = 30_000;
/**
 * How often, while backfilling, the steps whose cost grows with the WHOLE
 * dataset run: pool state (every pool's last swap, every flow hour), launchpad
 * classification and token supplies. They ran on every pass, and a first
 * sync runs thousands of passes, so each pass got slower as the tables grew
 * and the indexer crawled — the live site sat 130 days behind for a day. Once
 * caught up they run every pass again. All three are recomputed from the
 * tables, never incremented, so running them less often changes nothing
 * about what they produce (§9).
 */
const GLOBAL_EVERY_MS = 60_000;
/** The curated token list is re-read at least this often, caught up or not. */
const LIST_EVERY_MS = 5 * 60_000;
import {
  loadFeeTiers,
  loadKnownPools,
  loadPriceState,
  loadV3PoolAddresses,
  readCursor,
  writeCursor,
  writeLiquidity,
  writePools,
  writeSwaps,
} from './store';

/**
 * Logs in a pass above which the range is narrowed.
 *
 * Not about memory: it is the signal that the next window at this width would
 * likely be refused, and narrowing before that saves the wasted round trip.
 */
const BUSY_LOGS = 2_000;

/** The cursor key for the one v4 contract every pool lives in. */
export const POOL_MANAGER_CURSOR = `v4:${CONTRACTS.poolManager.toLowerCase()}`;

/**
 * What the poller needs from a chain. Satisfied by viem in production and by
 * a replayable fixture in the §9 test.
 */
export interface LogSource {
  getHeadBlock(): Promise<{ number: bigint; timestamp: Date }>;
  /** Block timestamps for a range, so an event carries chain time not wall time. */
  getBlockTimes(from: bigint, to: bigint): Promise<Map<bigint, Date>>;
  getLogs(args: {
    address: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    {
      address: string;
      topics: string[];
      data: string;
      blockNumber: bigint;
      logIndex: number;
      transactionHash: string;
    }[]
  >;
}

export interface PassResult {
  fromBlock: bigint;
  toBlock: bigint;
  headBlock: bigint;
  events: number;
  swapsWritten: number;
  liquidityWritten: number;
  poolsFound: number;
  tokensFound: number;
  /** Token supplies re-read this pass, for the fully diluted figure. */
  suppliesRefreshed: number;
  /** Token logos picked up from the token list, if one is configured. */
  logosFound: number;
  /** Blocks this pass covered. Visible so the adaptation is observable. */
  blockRange: number;
  /** Seconds between the last indexed block's time and head's. Shown in the top bar (§7). */
  lagSeconds: number;
  caughtUp: boolean;
}

export interface PollerOptions {
  source: LogSource;
  /**
   * USDG's address, if someone pinned one. Optional: when it is absent the
   * anchor is discovered from the chain's own tokens (see anchor.ts), so the
   * indexer starts and indexes rather than waiting on a human.
   */
  usdgAddress?: string | null;
  /**
   * v3 pool addresses to follow. Usually empty: pools discovered through the
   * factory are followed automatically and reloaded from the database on
   * restart. Use it only to follow a pool whose `PoolCreated` predates
   * START_BLOCK.
   */
  v3Pools?: string[];
  /**
   * The v3 factory. Without it, v3 pools are only those listed above — and
   * §4 says some older pools on this chain are v3, so a hand-list silently
   * omits real ones.
   */
  v3Factory?: string | null;
  startBlock?: bigint;
  blockRange?: number;
  /** Override for tests; production uses §2's 32. */
  reorgDepth?: number;
  /** Ceiling for the adaptive range. Lowered on the first refusal. */
  maxBlockRange?: number;
  /** Where token symbol/name/decimals come from. Defaults to the token contract. */
  tokenReader?: TokenReader;
  /**
   * External logo sources (logo-sources.ts). Opt-in: the real indexer passes
   * them, a test does not, so no test ever reaches the network.
   */
  logoSources?: LogoSource[];
  log?: (message: string) => void;
}

export class Poller {
  private readonly source: LogSource;
  private readonly usdgAddress: string | null;
  /** Last resolution, so a change of anchor can be logged once rather than every pass. */
  private lastAnchorNote = '';
  private readonly startBlock: bigint;
  /**
   * Blocks per pass, which ADAPTS as it goes.
   *
   * A fixed 2,000 is right once the indexer is following head and wrong by
   * four orders of magnitude during a first sync: this chain is 62 million
   * blocks deep and almost all of it is empty, so a fixed window meant some
   * thirty thousand round trips — about thirty-four hours — before reaching
   * anything worth indexing.
   *
   * Empty ranges widen, busy ranges narrow, and a range the endpoint refuses
   * lowers a learned ceiling. That last part is why this is adaptive rather
   * than just "set it larger": every endpoint caps `eth_getLogs` differently
   * and none of them say so up front, so the poller finds the cap by hitting
   * it once and then stays under it.
   */
  private blockRange: bigint;
  /** Never go below this: a busy range still has to make progress. */
  private readonly minRange: bigint;
  /** Learned from refusals. Starts optimistic and only ever comes down. */
  private maxRange: bigint;
  private readonly reorgDepth: bigint;
  private readonly log: (message: string) => void;
  private readonly tokenReader?: TokenReader;
  private readonly v3Factory: string | null;
  private v3Pools: string[];
  /** Set once the known v3 pools have been loaded from the database. */
  private v3Loaded = false;
  private readonly logoSources: LogoSource[] | null;
  private lastLogoSweep = 0;
  private sweeping = false;
  private lastGlobalAt = 0;
  private lastListAt = 0;
  /** Pools stored before native ETH was understood get corrected once a run. */
  private nativeAdopted = false;

  constructor(options: PollerOptions) {
    this.source = options.source;
    this.usdgAddress = options.usdgAddress?.toLowerCase() ?? null;
    this.startBlock = options.startBlock ?? env.startBlock;
    this.minRange = BigInt(options.blockRange ?? env.blockRange);
    this.blockRange = this.minRange;
    // 50k is above what most public endpoints allow, deliberately: the first
    // refusal teaches the real ceiling, and one wasted call is worth hours.
    this.maxRange = BigInt(options.maxBlockRange ?? env.maxBlockRange);
    this.reorgDepth = BigInt(options.reorgDepth ?? CHAIN.reorgDepth);
    this.v3Pools = (options.v3Pools ?? []).map((a) => a.toLowerCase());
    this.v3Factory = options.v3Factory?.toLowerCase() ?? null;
    this.tokenReader = options.tokenReader;
    this.logoSources = options.logoSources ?? null;
    this.log = options.log ?? (() => {});
  }

  private async refreshList(): Promise<number> {
    this.lastListAt = Date.now();
    return refreshLogos({ chainId: CHAIN.id, log: this.log });
  }

  /**
   * Fill in missing logos, at most every 30 seconds, in the background.
   *
   * Never awaited by the pass: a logo is decoration, and a slow or
   * rate-limited image service must not delay one block of indexing. Never
   * two at once, and never throws into the pass.
   */
  private maybeSweepLogos(): void {
    if (!this.logoSources || this.sweeping) return;
    const now = Date.now();
    if (now - this.lastLogoSweep < LOGO_SWEEP_MS) return;
    this.sweeping = true;
    this.lastLogoSweep = now;
    void sweepLogos({ sources: this.logoSources, log: this.log })
      .catch((error) => this.log(`  logo sweep failed: ${(error as Error).message}`))
      .finally(() => {
        this.sweeping = false;
      });
  }

  /**
   * Anchors for the SQL aggregation, resolved fresh each pass.
   *
   * Fresh, not cached, because on a first sync the anchor does not exist yet:
   * the indexer writes raw rows with no dollar figures, discovers USDG a few
   * passes later, and the next rebuild prices everything retroactively. That
   * only works because aggregates are rebuilt rather than incremented.
   */
  private async anchors(): Promise<PriceAnchors | null> {
    const resolved = await resolveUsdg(this.usdgAddress);
    if (resolved.note !== this.lastAnchorNote) {
      this.log(`  anchor: ${resolved.note}`);
      this.lastAnchorNote = resolved.note;
    }
    if (!resolved.address) return null;
    return {
      weth: CONTRACTS.weth.toLowerCase(),
      usdg: resolved.address,
      wethDecimals: 18,
      usdgDecimals: 6,
      anchorPoolId: await findAnchorPool(resolved.address),
    };
  }

  /**
   * One pass: fetch a range, ingest it, rebuild the aggregates it touched,
   * move the cursor.
   *
   * The cursor is advanced only after the aggregates are rebuilt. A crash
   * between the two therefore re-does the range rather than skipping it,
   * which the upserts make harmless.
   */
  async runPass(): Promise<PassResult> {
    // v3 pools discovered on an earlier run have to be followed again after a
    // restart, or the process would stop indexing them without saying so.
    if (!this.v3Loaded) {
      this.followV3Pools(await loadV3PoolAddresses());
      this.v3Loaded = true;
    }

    const head = await this.source.getHeadBlock();
    const cursor = await readCursor(POOL_MANAGER_CURSOR);
    this.maybeSweepLogos();

    if (!this.nativeAdopted) {
      const adopted = await adoptNativeEthPools(head.timestamp, this.tokenReader);
      if (adopted > 0) this.log(`  ${adopted} native-ETH pool(s) recorded as WETH pools, so they can be priced`);
      this.nativeAdopted = true;
    }

    // Re-scan the last 32 blocks (§4.1). On the very first pass there is
    // nothing to re-scan, so start where configured.
    const from =
      cursor === null
        ? this.startBlock
        : max(this.startBlock, cursor - this.reorgDepth + 1n);
    const to = min(head.number, from + this.blockRange - 1n);

    if (to < from) {
      // Head has not moved past what we already have.
      return {
        fromBlock: from,
        toBlock: cursor ?? from,
        headBlock: head.number,
        events: 0,
        swapsWritten: 0,
        liquidityWritten: 0,
        poolsFound: 0,
        tokensFound: 0,
        // Caught up is exactly when there is room to spend an RPC call on
        // something other than logs.
        suppliesRefreshed: await refreshSupplies(head.timestamp, { read: this.tokenReader }),
        // Caught up is the only time there is room to fetch a token list.
        // It is also the only network call in this process that is not to a
        // node, and it is allowed to fail silently (§4 permits logos from
        // external sources; a missing one changes no number).
        logosFound: await this.refreshList(),
        lagSeconds: 0,
        caughtUp: true,
        blockRange: Number(this.blockRange),
      };
    }

    const managerAddress = CONTRACTS.poolManager.toLowerCase();
    const addresses = [
      managerAddress,
      ...(this.v3Factory ? [this.v3Factory] : []),
      ...this.v3Pools,
    ];
    let logs;
    try {
      logs = await this.source.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    } catch (error) {
      // Almost always the endpoint refusing the width — "query returned more
      // than N results", "block range too large". Endpoints differ and none
      // announce their cap, so it is found by hitting it once: halve, record
      // the ceiling, and let the next pass retry the same range narrower. The
      // cursor does not move, so nothing is skipped.
      const width = to - from + 1n;
      this.maxRange = max(this.minRange, width / 2n);
      this.blockRange = this.maxRange;
      this.log(
        `  endpoint refused ${width} blocks (${(error as Error).message.split('\n')[0]}) — ` +
          `range now ${this.blockRange}`,
      );
      return {
        fromBlock: from,
        toBlock: cursor ?? from,
        headBlock: head.number,
        events: 0,
        swapsWritten: 0,
        liquidityWritten: 0,
        poolsFound: 0,
        tokensFound: 0,
        suppliesRefreshed: 0,
        logosFound: 0,
        lagSeconds: 0,
        caughtUp: false,
        blockRange: Number(this.blockRange),
      };
    }
    const blockTimes = await this.source.getBlockTimes(from, to);

    const events: ChainEvent[] = [];
    for (const raw of logs) {
      const blockTime = blockTimes.get(raw.blockNumber);
      if (!blockTime) continue; // A block we could not time is a block we skip.
      const log = {
        ...raw,
        address: raw.address as `0x${string}`,
        topics: raw.topics as [] | [`0x${string}`, ...`0x${string}`[]],
        data: raw.data as `0x${string}`,
        transactionHash: raw.transactionHash as `0x${string}`,
      };
      const source = raw.address.toLowerCase();
      const decoded =
        source === managerAddress
          ? decodePoolManagerLog(log as never, blockTime)
          : source === this.v3Factory
            ? decodeV3FactoryLog(log as never, blockTime)
            : decodeV3PoolLog(log as never, blockTime);
      if (decoded) events.push(decoded);
    }

    const ordered = sortEvents(events);

    // Pools first: a swap row has a foreign key to its pool, and a pool
    // discovered in this very range has to exist before its swaps are written.
    const initializePlan = planIngest(
      ordered.filter((e) => e.kind === 'initialize'),
      { chainId: CHAIN.id, sqrtPriceByPool: new Map(), feePipsByPool: new Map() },
    );
    const tokenAddresses = initializePlan.pools.flatMap((p) => [p.token0, p.token1]);
    const tokensFound = await ensureTokens(tokenAddresses, head.timestamp, this.tokenReader);
    await writePools(initializePlan);

    // A v3 pool announced by the factory in THIS range emits everything else
    // from its own address, which we were not watching when the logs above
    // were fetched — so its first mint and its early swaps are in blocks we
    // have already read past.
    //
    // The 32-block re-scan does NOT cover this. A pool created at block 20
    // whose Mint lands at block 30 is behind the next pass's window, and that
    // mint is a pool's entire starting liquidity: miss it and the pool's
    // reserves are negative and its depth unknown for good. So the range is
    // re-fetched for exactly those addresses, from each pool's own creation
    // block, in this same pass.
    const newV3 = initializePlan.pools.filter((p) => p.protocol === 'v3');
    let backfilled: ChainEvent[] = [];
    if (newV3.length > 0) {
      this.followV3Pools(newV3.map((p) => p.address));
      const earliest = newV3.reduce(
        (acc, p) => (p.createdBlock < acc ? p.createdBlock : acc),
        newV3[0].createdBlock,
      );
      backfilled = await this.backfillV3(
        newV3.map((p) => p.address),
        earliest,
        to,
        blockTimes,
      );
      this.log(
        `  discovered ${newV3.length} v3 pool(s); backfilled ${backfilled.length} ` +
          `event(s) from block ${earliest}`,
      );
    }

    // Then the rest, with the carried price state loaded from the database so
    // a restart mid-chain resumes exactly where a full replay would be.
    const known = await loadKnownPools();
    const withBackfill = backfilled.length > 0 ? sortEvents([...ordered, ...backfilled]) : ordered;
    const usable = withBackfill.filter((e) => known.has(e.poolId));
    const skipped = withBackfill.length - usable.length;
    if (skipped > 0) {
      // Events for a pool whose Initialize predates our start block. Counting
      // their fees would attribute them to a pool that does not exist in our
      // tables; dropping them understates that pool. Say so rather than
      // silently doing either.
      this.log(
        `  ${skipped} event(s) for pools created before block ${this.startBlock} — ` +
          'lower START_BLOCK to include them',
      );
    }

    const plan = planIngest(usable, {
      chainId: CHAIN.id,
      sqrtPriceByPool: await loadPriceState(from),
      feePipsByPool: await loadFeeTiers(),
    });

    if (plan.unpriced.length > 0) {
      // Should not happen now the Initialize price is stored on the pool row.
      // If it does, the pool's depth reads as unknown rather than wrong, and
      // this is how anyone finds out — it used to be a thrown error that
      // stopped the indexer on every pass instead.
      const pools = [...new Set(plan.unpriced.map((u) => u.poolId))];
      this.log(
        `  ${plan.unpriced.length} liquidity event(s) unvalued across ${pools.length} ` +
          `pool(s) — no price known at that point: ${pools.slice(0, 3).join(', ')}`,
      );
    }

    const swapsWritten = await writeSwaps(plan);
    const liquidityWritten = await writeLiquidity(plan);

    // Aggregates, in dependency order: the anchor price series, the staged
    // token flow, the fee hours valued through the anchor, then pool state
    // built on the flow. Scoped to the hours this range touched.
    const anchors = await this.anchors();
    // Supplies first: the FDV figure in pool_state is computed from them, so
    // refreshing after the rebuild would leave it a pass behind.
    const caughtUpNow = to >= head.number;
    const globalDue = caughtUpNow || Date.now() - this.lastGlobalAt >= GLOBAL_EVERY_MS;
    const suppliesRefreshed = globalDue
      ? await refreshSupplies(head.timestamp, { read: this.tokenReader })
      : 0;
    // No anchor yet means no dollar figure is derivable — the raw rows above
    // are still written, and the rebuild that prices them happens on whatever
    // pass first finds USDG. Skipping the aggregation here is not data loss.
    if (anchors) {
      await rebuildAggregates(anchors, { fromBlock: from, toBlock: to }, { poolState: globalDue });
    }
    if (globalDue) {
      await classifyPools();
      this.lastGlobalAt = Date.now();
    }

    const lastBlockTime = blockTimes.get(to) ?? head.timestamp;
    await writeCursor(POOL_MANAGER_CURSOR, to, lastBlockTime);

    // Adapt for the next pass. Only while backfilling: once the indexer is
    // following head there is nothing to gain from a wider window and a
    // narrow one keeps latency low.
    const behind = head.number - to;
    if (behind > this.blockRange) {
      if (logs.length === 0) {
        // Empty. This is the case that matters — most of a 62-million-block
        // chain is empty, and doubling turns tens of thousands of passes into
        // hundreds.
        this.blockRange = min(this.maxRange, this.blockRange * 2n);
      } else if (logs.length > BUSY_LOGS) {
        // Dense enough that the next window risks a refusal, and each pass is
        // doing real work anyway.
        this.blockRange = max(this.minRange, this.blockRange / 2n);
      }
    } else {
      this.blockRange = this.minRange;
    }

    const lagSeconds = Math.max(
      0,
      (head.timestamp.getTime() - lastBlockTime.getTime()) / 1000,
    );

    return {
      fromBlock: from,
      toBlock: to,
      headBlock: head.number,
      events: withBackfill.length,
      swapsWritten,
      liquidityWritten,
      poolsFound: initializePlan.pools.length,
      tokensFound,
      suppliesRefreshed,
      // Only when a pool was discovered: a logo list does not change between
      // blocks, and this is the one call in here that leaves the chain.
      logosFound:
        // New pools bring new tokens the list may cover; and the list itself
        // is re-read every few minutes regardless, because a token it covers
        // can be discovered on a pass that found no new pool.
        initializePlan.pools.length > 0 || Date.now() - this.lastListAt >= LIST_EVERY_MS
          ? await this.refreshList()
          : 0,
      lagSeconds,
      caughtUp: to >= head.number,
      blockRange: Number(to - from + 1n),
    };
  }

  /**
   * Re-read a newly discovered v3 pool's own logs from its creation block.
   *
   * Block times are reused from the pass where possible and fetched for the
   * rest, because an event has to carry chain time rather than the time we
   * happened to read it (§7).
   */
  private async backfillV3(
    addresses: string[],
    fromBlock: bigint,
    toBlock: bigint,
    known: Map<bigint, Date>,
  ): Promise<ChainEvent[]> {
    if (addresses.length === 0 || fromBlock > toBlock) return [];
    const logs = await this.source.getLogs({ address: addresses, fromBlock, toBlock });
    if (logs.length === 0) return [];

    const times = new Map(known);
    const missing = [...new Set(logs.map((l) => l.blockNumber))].filter((b) => !times.has(b));
    if (missing.length > 0) {
      const lo = missing.reduce((a, b) => (b < a ? b : a), missing[0]);
      const hi = missing.reduce((a, b) => (b > a ? b : a), missing[0]);
      for (const [block, time] of await this.source.getBlockTimes(lo, hi)) {
        times.set(block, time);
      }
    }

    const events: ChainEvent[] = [];
    for (const raw of logs) {
      const blockTime = times.get(raw.blockNumber);
      if (!blockTime) continue;
      const decoded = decodeV3PoolLog(
        {
          ...raw,
          address: raw.address as `0x${string}`,
          topics: raw.topics as [] | [`0x${string}`, ...`0x${string}`[]],
          data: raw.data as `0x${string}`,
          transactionHash: raw.transactionHash as `0x${string}`,
        } as never,
        blockTime,
      );
      if (decoded) events.push(decoded);
    }
    return events;
  }

  /** Run passes until caught up to head. Returns the passes it took. */
  async syncToHead(maxPasses = 100_000): Promise<PassResult[]> {
    const results: PassResult[] = [];
    for (let i = 0; i < maxPasses; i++) {
      const result = await this.runPass();
      results.push(result);
      if (result.caughtUp) break;
    }
    return results;
  }

  /** Add v3 pools to follow. v3 has one contract per pool, so this grows. */
  followV3Pools(addresses: string[]): void {
    const set = new Set(this.v3Pools);
    for (const a of addresses) set.add(a.toLowerCase());
    this.v3Pools = [...set];
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Topics the poller cares about, for an RPC that supports topic filters. */
export const WATCHED_TOPICS = { POOL_MANAGER_ABI, V3_POOL_ABI };
