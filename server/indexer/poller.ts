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
import { POOL_MANAGER_ABI, STRUCTURE_TOPICS, V3_POOL_ABI } from '../chain/abi';
import { prisma } from '../db';
import { env } from '../env';
import type { PriceAnchors } from './aggregate';
import { rebuildAggregates } from './aggregate';
import {
  classifyPools,
  ensureTokens,
  hydrateTokens,
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
import { ContractIndexer, type ContractsConfig } from './contracts';
import { sweepLogos, type LogoSource } from './logo-sources';

/**
 * How often the logo sweep may run: one GeckoTerminal call each, which stays
 * well inside its burst limit. Every 30s took most of an hour to get through
 * a first sync's two thousand tokens once; 15s halves that.
 */
const LOGO_SWEEP_MS = 15_000;
/** Pool state during the structure phase: often enough that a fix reaches the screen. */
const STRUCTURE_GLOBAL_EVERY_MS = 10 * 60_000;
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
 * Half the 10,000-log cap this chain's endpoints enforce: 2,000 halved the
 * window through every busy stretch, down to a few hundred blocks a pass,
 * while the endpoint would have answered five times that.
 */
const BUSY_LOGS = 5_000;
/** Logs in a pass below which the range may widen, as an empty one does. */
const CALM_LOGS = BUSY_LOGS / 4;
/** Calm passes in a row after which a ceiling learned from density is raised. */
const CALM_STREAK = 3;

/**
 * Whether a refusal is about the block SPAN asked for, rather than how many
 * logs matched.
 *
 * The two need different memories. A span cap is a fact about the endpoint
 * and holds everywhere; a log-count cap is a fact about the stretch of chain
 * the window landed in, and the next stretch may be empty. So only a refusal
 * that names a span — and no endpoint in it complained about the count —
 * caps the window for good. Anything else, including errors nobody
 * recognises, is treated as passing: wrongly capping a 100-million-block sync
 * at a few hundred blocks costs a day, wrongly probing a real cap costs one
 * refused call. The real endpoint's words for the count:
 * "logs matched by query exceeds limit of 10000".
 */
export function isSpanRefusal(message: string): boolean {
  return classifyRefusal(message) === 'span';
}

/**
 * What a refused `eth_getLogs` was refused for, from every endpoint's answer.
 *
 *   count  the window matched too many logs here: narrow it, for now
 *   rate   an endpoint is rate-limiting us: wait, and change nothing
 *   span   the window is wider than an endpoint will ever answer: cap it
 *   other  nothing recognisable: narrow it, for now
 *
 * The order matters. Failover joins every endpoint's error into one message,
 * so a rate-limited first endpoint and a range-capped fallback produce
 * "429 Too Many Requests … block range too large" — read as a span refusal,
 * that capped the window for the rest of the sync because one endpoint was
 * busy for a second.
 */
export function classifyRefusal(message: string): 'count' | 'rate' | 'span' | 'other' {
  if (/exceeds? (the )?limit|more than \d+ results|too many (results|logs)|response (size|too large)/i.test(message)) {
    return 'count';
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return 'rate';
  if (/block range|range (is )?too (large|wide|big)|block span|blocks? (limit|exceed|maximum)|max(imum)? (block )?range/i.test(message)) {
    return 'span';
  }
  return 'other';
}

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
    /** Only logs whose first topic is one of these. Absent: every log. */
    topics?: string[];
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
  /** The endpoint refused the window; nothing was read and the cursor did not move. */
  refused?: boolean;
  /** The range was older than the swap window: pools and liquidity only. */
  structureOnly?: boolean;
  /**
   * Milliseconds spent fetching logs, fetching block times, writing rows and
   * rebuilding aggregates. Printed with each progress line, so a slow pass
   * on the box says which part was slow instead of leaving it to be guessed.
   */
  timings?: { logs: number; times: number; write: number; aggregate: number; contracts?: number };
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
  /**
   * Swaps older than this many seconds behind head are not read: ranges that
   * old are fetched for pool structure only — Initialize and liquidity
   * events — which is all depth needs (TVL is valued from positions, see
   * aggregate.ts). Null reads every swap from the start block, as §9's
   * replay criterion is stated.
   */
  swapWindowSeconds?: number | null;
  /** Where token symbol/name/decimals come from. Defaults to the token contract. */
  tokenReader?: TokenReader;
  /**
   * External logo sources (logo-sources.ts). Opt-in: the real indexer passes
   * them, a test does not, so no test ever reaches the network.
   */
  logoSources?: LogoSource[];
  /**
   * Tidewell's own contracts: deployed vaults and the router factory
   * (contracts.ts). Read every pass on cursors of their own, so stakes,
   * claims and a router's last observation are current even while pools are
   * still being backfilled.
   * Absent or empty: nothing is read and nothing is queried.
   */
  contracts?: ContractsConfig;
  /** Least milliseconds between contract passes once they reach head. Tests pass 0. */
  contractEveryMs?: number;
  /**
   * Reuse a resolved USDG anchor for this long before resolving it again. 0
   * (the default, and what every test uses) resolves it on every call, as
   * before; the indexer's entry point passes ten minutes.
   */
  anchorRefreshMs?: number;
  /** With no new vault event, rebuild vault rows at most this often. 0 (default): every contract pass. */
  vaultRebuildEveryMs?: number;
  log?: (message: string) => void;
}

export class Poller {
  private readonly source: LogSource;
  private readonly usdgAddress: string | null;
  /** Last resolution, so a change of anchor can be logged once rather than every pass. */
  private lastAnchorNote = '';
  /**
   * The anchor, resolved at most every ANCHOR_REFRESH_MS. Discovery scans the
   * pools table — a million rows on this chain, with no index a lower()
   * comparison can use — and it ran on every contract pass, which follows
   * every pool pass: on the box that was 8–11 s of a 12 s pass, untimed, and
   * the reason "anchor: Discovered USDG" printed every twenty seconds.
   */
  private anchorCache: { value: PriceAnchors | null; at: number } | null = null;
  private readonly anchorRefreshMs: number;
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
  /** The window once following head, and the floor for ordinary narrowing. */
  private readonly minRange: bigint;
  /**
   * Learned from refusals. Starts optimistic. A block-span refusal lowers it
   * for good; a log-count refusal lowers it until the chain calms down.
   */
  private maxRange: bigint;
  private readonly configuredMax: bigint;
  private readonly swapWindowSeconds: number | null;
  /** Set by a block-span refusal: never asked above again. */
  private hardCap: bigint | null = null;
  private calmPasses = 0;
  /**
   * The ceiling for structure passes, which match one log in a few hundred:
   * their window is limited by the endpoint's log cap, not the configured
   * maximum, so it may grow to ten times that.
   */
  private structureMax: bigint;
  /** The last structure pass's end, whose time starts the next one. */
  private lastStructureEnd: { block: bigint; time: Date } | null = null;
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
  private readonly contracts: ContractIndexer | null;

  constructor(options: PollerOptions) {
    this.source = options.source;
    this.usdgAddress = options.usdgAddress?.toLowerCase() ?? null;
    this.startBlock = options.startBlock ?? env.startBlock;
    this.minRange = BigInt(options.blockRange ?? env.blockRange);
    this.blockRange = this.minRange;
    // 50k is above what most public endpoints allow, deliberately: the first
    // refusal teaches the real ceiling, and one wasted call is worth hours.
    this.maxRange = BigInt(options.maxBlockRange ?? env.maxBlockRange);
    this.configuredMax = this.maxRange;
    this.structureMax = this.maxRange * 10n;
    this.swapWindowSeconds = options.swapWindowSeconds ?? null;
    this.anchorRefreshMs = options.anchorRefreshMs ?? 0;
    this.reorgDepth = BigInt(options.reorgDepth ?? CHAIN.reorgDepth);
    this.v3Pools = (options.v3Pools ?? []).map((a) => a.toLowerCase());
    this.v3Factory = options.v3Factory?.toLowerCase() ?? null;
    this.tokenReader = options.tokenReader;
    this.logoSources = options.logoSources ?? null;
    this.log = options.log ?? (() => {});
    const contracts = options.contracts;
    this.contracts =
      contracts && (contracts.vaults.length > 0 || contracts.routerFactory)
        ? new ContractIndexer({
            source: this.source,
            config: contracts,
            reorgDepth: this.reorgDepth,
            startRange: this.maxRange,
            everyMs: options.contractEveryMs ?? 5_000,
            rebuildEveryMs: options.vaultRebuildEveryMs ?? 0,
            log: this.log,
          })
        : null;
  }

  /**
   * Read Tidewell's contracts to head. Never fails the pass: a vault's events
   * being a pass late is far smaller than every pool's data stopping, and
   * the contract cursors do not move on a failure, so nothing is skipped.
   */
  private async indexContracts(head: { number: bigint; timestamp: Date }): Promise<void> {
    if (!this.contracts?.due()) return;
    try {
      const anchors = this.contracts.hasVaults ? await this.anchors() : null;
      const result = await this.contracts.pass(head, anchors);
      if (result && result.written > 0) {
        this.log(
          `  contracts: blocks ${result.fromBlock}-${result.toBlock}, +${result.written} event(s)` +
            (this.contracts.hasVaults ? `, ${result.vaultsWritten} vault(s) rebuilt` : ''),
        );
      }
    } catch (error) {
      this.log(`  contract pass failed: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  private async refreshList(): Promise<number> {
    this.lastListAt = Date.now();
    return refreshLogos({ chainId: CHAIN.id, log: this.log });
  }

  /**
   * Fill in missing logos, at most every 15 seconds, in the background.
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
    const now = Date.now();
    if (this.anchorCache && now - this.anchorCache.at < this.anchorRefreshMs) return this.anchorCache.value;
    const resolved = await resolveUsdg(this.usdgAddress);
    if (resolved.note !== this.lastAnchorNote) {
      this.log(`  anchor: ${resolved.note}`);
      this.lastAnchorNote = resolved.note;
    }
    const value: PriceAnchors | null = resolved.address
      ? {
          weth: CONTRACTS.weth.toLowerCase(),
          usdg: resolved.address,
          wethDecimals: 18,
          usdgDecimals: 6,
          anchorPoolId: await findAnchorPool(resolved.address),
        }
      : null;
    // No anchor yet is never cached: the pass that first finds USDG should
    // price everything as soon as it can (§17).
    this.anchorCache = value ? { value, at: now } : null;
    return value;
  }

  /**
   * One pass: fetch a range, ingest it, rebuild the aggregates it touched,
   * move the cursor.
   *
   * The cursor is advanced only after the aggregates are rebuilt. A crash
   * between the two therefore re-does the range rather than skipping it,
   * which the upserts make harmless.
   */
  /**
   * After passes that failed outright (not a refused range — an exception),
   * try a narrower window: if one stretch of chain is what fails, halving
   * isolates it to a few blocks and the log names it. Never below twice the
   * re-scan, which still moves the cursor. Returns the new width.
   */
  narrowAfterFailure(): number {
    const floor = this.reorgDepth * 2n > 1n ? this.reorgDepth * 2n : 2n;
    this.blockRange = max(floor, this.blockRange / 2n);
    this.calmPasses = 0;
    return Number(this.blockRange);
  }

  async runPass(): Promise<PassResult> {
    const head = await this.source.getHeadBlock();
    let result: PassResult | undefined;
    try {
      result = await this.poolPass(head);
      return result;
    } finally {
      // After the pool pass, so a vault is valued at this pass's pool state,
      // and strictly after it: ViemLogSource times the blocks of the logs it
      // was last asked for, so the two reads must not interleave. In a
      // `finally`, so a pool pass that fails — and is retried — does not
      // also freeze every vault's stakes and every router's observations.
      const tContracts = Date.now();
      await this.indexContracts(head);
      if (result?.timings) result.timings.contracts = Date.now() - tContracts;
    }
  }

  private async poolPass(head: { number: bigint; timestamp: Date }): Promise<PassResult> {
    // v3 pools discovered on an earlier run have to be followed again after a
    // restart, or the process would stop indexing them without saying so.
    if (!this.v3Loaded) {
      this.followV3Pools(await loadV3PoolAddresses());
      this.v3Loaded = true;
    }

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
    let to = min(head.number, from + this.blockRange - 1n);

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

    // Older than the swap window: read the pools and their liquidity, not
    // their trades. On this chain that is the difference between some two
    // hundred million logs and well under a million, and between the site
    // showing today in hours or in days.
    let structureOnly = false;
    let toTime: Date | undefined;
    if (this.swapWindowSeconds !== null && to < head.number) {
      toTime = (await this.source.getBlockTimes(to, to)).get(to);
      structureOnly =
        toTime !== undefined && (head.timestamp.getTime() - toTime.getTime()) / 1000 > this.swapWindowSeconds;
      // Out of the structure phase, a window grown on one-in-300 logs would be
      // refused on every log: start from the full-pass ceiling instead.
      if (!structureOnly && this.blockRange > this.maxRange) {
        this.blockRange = this.maxRange;
        to = min(head.number, from + this.blockRange - 1n);
        toTime = undefined;
      }
    }

    const tLogs = Date.now();
    let logs;
    try {
      logs = await this.source.getLogs({
        address: addresses,
        fromBlock: from,
        toBlock: to,
        ...(structureOnly ? { topics: STRUCTURE_TOPICS } : {}),
      });
    } catch (error) {
      // Almost always the endpoint refusing the width — "logs matched by
      // query exceeds limit of 10000", "block range too large". Endpoints
      // differ and none announce their cap, so it is found by hitting it:
      // halve, record the ceiling, and let the next pass retry the same range
      // narrower. The cursor does not move, so nothing is skipped.
      //
      // The halving used to stop at the configured window (2,000 blocks). At
      // block 4,408,304 one launch was swapped 6,158 times in 1,000 blocks, so
      // 2,000 blocks held more than 10,000 logs, every pass was refused at
      // exactly that width, and the indexer retried one range for a day while
      // reporting itself online. It may go as low as twice the re-scan now,
      // which still moves the cursor forward.
      const width = to - from + 1n;
      // Classified on every endpoint's answer; the first line alone is just
      // "getLogs(a-b) failed on all 4 endpoints:", which says neither.
      const full = (error as Error).message;
      const message = full.split('\n')[0];
      const kind = classifyRefusal(full);
      if (kind === 'rate') {
        // Busy, not too wide: the same window again after a breath.
        this.log(`  endpoints rate-limiting (${width} blocks) — retrying the same window`);
        await new Promise((r) => setTimeout(r, 1_500));
        return {
          fromBlock: from, toBlock: cursor ?? from, headBlock: head.number, events: 0, swapsWritten: 0,
          liquidityWritten: 0, poolsFound: 0, tokensFound: 0, suppliesRefreshed: 0, logosFound: 0,
          lagSeconds: 0, caughtUp: false, blockRange: Number(this.blockRange), refused: true,
        };
      }
      const floor = this.reorgDepth * 2n > 1n ? this.reorgDepth * 2n : 2n;
      if (structureOnly) {
        this.structureMax = max(floor, width / 2n);
        if (kind === 'span') this.hardCap = this.structureMax;
        this.blockRange = this.structureMax;
      } else {
        this.maxRange = max(floor, width / 2n);
        if (kind === 'span') this.hardCap = this.maxRange;
        this.blockRange = this.maxRange;
      }
      this.calmPasses = 0;
      const reason = full.match(/exceeds? limit of \d+|more than \d+ results|block range[^\n]*|too many[^\n]*/i)?.[0];
      this.log(`  endpoint refused ${width} blocks (${reason ?? message}) — range now ${this.blockRange}`);
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
        refused: true,
      };
    }
    const tTimes = Date.now();
    const blockTimes = structureOnly
      ? await this.coarseTimes(logs.map((l) => l.blockNumber), from, to, toTime!)
      : await this.source.getBlockTimes(from, to);

    const tWrite = Date.now();
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
    const tokensFound = await ensureTokens(tokenAddresses, head.timestamp, this.tokenReader, { lazy: structureOnly });
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
    const withBackfill = backfilled.length > 0 ? sortEvents([...ordered, ...backfilled]) : ordered;
    const touched = [...new Set(withBackfill.map((e) => e.poolId))];
    const known = await loadKnownPools(touched);
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

    // A token recorded lazily in a structure pass is read the first time a
    // swap needs it, before anything is valued in it.
    if (!structureOnly) {
      const swapped = [...new Set(usable.filter((e) => e.kind === 'swap').map((e) => e.poolId))];
      if (swapped.length > 0) {
        const rows = await prisma.pool.findMany({ where: { id: { in: swapped } }, select: { token0: true, token1: true } });
        await hydrateTokens(rows.flatMap((r) => [r.token0, r.token1]), this.tokenReader);
      }
    }

    const plan = planIngest(usable, {
      chainId: CHAIN.id,
      sqrtPriceByPool: await loadPriceState(from, touched),
      feePipsByPool: await loadFeeTiers(touched),
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
    // A structure pass changes nothing an aggregate reads: it has no swaps,
    // so no fee hour, anchor price or pool price moves, and pool state counts
    // liquidity only up to the last swap read (aggregate.ts). Skipping the
    // whole step is what lets it cross 100 million blocks in an hour instead
    // of fighting the database for each one.
    //
    // Except pool state, every ten minutes and on the first pass after a
    // start: skipping it entirely left whatever the previous code had written
    // on screen for the whole structure phase — the live site kept showing a
    // $1.76T TVL the fix for it had already made impossible, because nothing
    // ran the fixed rebuild.
    const tAggregate = Date.now();
    const caughtUpNow = to >= head.number;
    const globalEvery = structureOnly ? STRUCTURE_GLOBAL_EVERY_MS : GLOBAL_EVERY_MS;
    const globalDue = caughtUpNow || Date.now() - this.lastGlobalAt >= globalEvery;
    const anchors = structureOnly && !globalDue ? null : await this.anchors();
    // Supplies first: the FDV figure in pool_state is computed from them, so
    // refreshing after the rebuild would leave it a pass behind.
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
    const tEnd = Date.now();

    // Adapt for the next pass. Only while backfilling: once the indexer is
    // following head there is nothing to gain from a wider window and a
    // narrow one keeps latency low.
    const behind = head.number - to;
    // Ordinary narrowing stops at the configured window, or at the learned
    // ceiling where that is lower — snapping back above it would only be
    // refused again.
    const ceiling = structureOnly ? this.structureMax : this.maxRange;
    const floor = min(this.minRange, ceiling);
    // A structure pass's cost is per pass more than per log, so it widens
    // until it is half full; a full pass widens only when nearly empty.
    const calmLogs = structureOnly ? BUSY_LOGS / 2 : CALM_LOGS;
    if (logs.length < calmLogs) {
      this.calmPasses++;
      // A ceiling learned from a dense stretch is not a fact about the
      // endpoint. After a run of quiet passes it is allowed back up, or one
      // busy launch would cap the rest of a 100-million-block sync.
      if (structureOnly) {
        const top = this.hardCap ?? this.configuredMax * 10n;
        if (this.calmPasses >= CALM_STREAK && this.structureMax < top) {
          this.structureMax = min(top, this.structureMax * 2n);
          this.calmPasses = 0;
        }
      } else if (this.calmPasses >= CALM_STREAK && this.maxRange < (this.hardCap ?? this.configuredMax)) {
        this.maxRange = min(this.hardCap ?? this.configuredMax, this.maxRange * 2n);
        this.calmPasses = 0;
      }
    } else {
      this.calmPasses = 0;
    }
    if (behind > this.blockRange) {
      if (logs.length < calmLogs) {
        // Empty or nearly. This is the case that matters — most of the chain
        // is quiet, and doubling turns tens of thousands of passes into
        // hundreds.
        this.blockRange = min(structureOnly ? this.structureMax : this.maxRange, this.blockRange * 2n);
      } else if (logs.length > BUSY_LOGS) {
        // Dense enough that the next window risks a refusal.
        this.blockRange = max(floor, this.blockRange / 2n);
      }
    } else {
      this.blockRange = floor;
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
        // Not on every new pool in a structure pass: there it is nearly every
        // pass, and those tokens are recorded lazily and shown nowhere yet.
        (initializePlan.pools.length > 0 && !structureOnly) || Date.now() - this.lastListAt >= LIST_EVERY_MS
          ? await this.refreshList()
          : 0,
      lagSeconds,
      caughtUp: to >= head.number,
      blockRange: Number(to - from + 1n),
      structureOnly,
      timings: { logs: tTimes - tLogs, times: tWrite - tTimes, write: tAggregate - tWrite, aggregate: tEnd - tAggregate },
    };
  }

  /**
   * Times for a structure-only range: interpolated between the range's two
   * ends rather than fetched per block. What they date — a pool's creation, a
   * liquidity change more than a week old — needs days of precision, not
   * seconds; per-block timestamps for half a million such events would be
   * most of a day of rate-limited requests. Nothing exact is derived from
   * them: fees come only from swaps, and swaps are only read inside the
   * window, with real times.
   */
  private async coarseTimes(blocks: bigint[], from: bigint, to: bigint, toTime: Date): Promise<Map<bigint, Date>> {
    // The start of this range is the end of the last one, give or take the
    // 32-block re-scan, and its time is already recorded: reuse it rather
    // than ask a rate-limited endpoint again (one such wait cost 16 seconds).
    const recorded = this.lastStructureEnd && this.lastStructureEnd.block >= from && this.lastStructureEnd.block <= from + this.reorgDepth
      ? this.lastStructureEnd.time
      : undefined;
    const fromTime = recorded ?? (await this.source.getBlockTimes(from, from)).get(from) ?? toTime;
    this.lastStructureEnd = { block: to, time: toTime };
    const span = Number(to - from) || 1;
    const out = new Map<bigint, Date>([[to, toTime]]);
    for (const block of blocks) {
      const f = Number(block - from) / span;
      const ms = fromTime.getTime() + (toTime.getTime() - fromTime.getTime()) * f;
      out.set(block, new Date(Math.floor(ms / 1000) * 1000));
    }
    return out;
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
      // Our own contracts too: a router announced in the last range is read
      // from its creation block on the next pass.
      if (result.caughtUp && !this.contracts?.isBehind) break;
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
