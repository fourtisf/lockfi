/**
 * Writing an ingest plan to Postgres.
 *
 * Every write is an upsert keyed by `(tx_hash, log_index)`, which is what
 * lets §4.1's "re-scan the last 32 blocks each pass" cost nothing and change
 * nothing. There is no INSERT here that could fail on a second pass, and no
 * UPDATE that adds to an existing value.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { IngestPlan } from './ingest';

/** Chunked so a large first sync does not build a single enormous statement. */
const CHUNK = 500;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** bigint to a Prisma Decimal, exactly — never through a float. */
function dec(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

export async function writePools(plan: IngestPlan): Promise<void> {
  // One INSERT per 500 pools, not one upsert per pool. On the live box a
  // structure pass met 300-500 new pools and spent most of its time here,
  // one round trip each. A pool's facts come from its Initialize log and
  // never change, so a pool already written is skipped rather than rewritten:
  // a re-scan of the same log would write the same values. `stakeable` is not
  // written either way — discovery sets it from the pool's hook, and a
  // re-scan must not reset it.
  for (const batch of chunk(plan.pools)) {
    await prisma.pool.createMany({
      data: batch.map((pool) => ({
        id: pool.id,
        address: pool.address,
        chainId: pool.chainId,
        token0: pool.token0,
        token1: pool.token1,
        feeTier: pool.feeTier,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
        protocol: pool.protocol,
        createdBlock: pool.createdBlock,
        createdAt: pool.createdAt,
        initSqrtPrice: dec(pool.initSqrtPrice),
        initTick: pool.initTick,
      })),
      skipDuplicates: true,
    });
  }
}

export async function writeSwaps(plan: IngestPlan): Promise<number> {
  let written = 0;
  for (const batch of chunk(plan.swaps)) {
    const rows = batch.map((s) => ({
      txHash: s.txHash,
      logIndex: s.logIndex,
      poolId: s.poolId,
      blockNum: s.blockNum,
      blockTime: s.blockTime,
      amount0: dec(s.amount0),
      amount1: dec(s.amount1),
      sqrtPrice: dec(s.sqrtPrice),
      liquidity: dec(s.liquidity),
      tick: s.tick,
      feeAmount: dec(s.feeAmount),
      feeToken: s.feeToken,
      sender: s.sender,
    }));
    // createMany + skipDuplicates is the right shape here: the primary key is
    // the log's own coordinates, so a duplicate is by definition the identical
    // row. Skipping it is not lossy, and it keeps the re-scan cheap.
    const result = await prisma.swapEvent.createMany({ data: rows, skipDuplicates: true });
    written += result.count;
  }
  return written;
}

export async function writeLiquidity(plan: IngestPlan): Promise<number> {
  let written = 0;
  for (const batch of chunk(plan.liquidity)) {
    const rows = batch.map((l) => ({
      txHash: l.txHash,
      logIndex: l.logIndex,
      poolId: l.poolId,
      blockNum: l.blockNum,
      blockTime: l.blockTime,
      tickLower: l.tickLower,
      tickUpper: l.tickUpper,
      liquidityDelta: dec(l.liquidityDelta),
      amount0: dec(l.amount0),
      amount1: dec(l.amount1),
      owner: l.owner,
    }));
    const result = await prisma.liquidityEvent.createMany({ data: rows, skipDuplicates: true });
    written += result.count;
  }
  return written;
}

/** Where the poller resumes from, per contract. */
export async function readCursor(contract: string): Promise<bigint | null> {
  const row = await prisma.indexerCursor.findUnique({ where: { contract } });
  return row?.lastIndexedBlock ?? null;
}

export async function writeCursor(
  contract: string,
  block: bigint,
  blockTime: Date,
): Promise<void> {
  await prisma.indexerCursor.upsert({
    where: { contract },
    create: {
      contract,
      lastIndexedBlock: block,
      lastIndexedAt: blockTime,
      updatedAt: new Date(),
    },
    update: { lastIndexedBlock: block, lastIndexedAt: blockTime, updatedAt: new Date() },
  });
}

/**
 * The sqrtPrice each pool was last seen at, at or before a given block.
 *
 * Loaded from the database rather than carried in memory, so a restart
 * mid-chain resumes with exactly the state a full replay would have reached —
 * which is half of why §9's two runs agree. The other half is that the query
 * is ordered by the same `(block, logIndex)` total order the ingest uses.
 */
export async function loadPriceState(
  beforeBlock: bigint,
  /**
   * Only these pools. Every pass used to load every pool's last price — on a
   * chain with a million launches that is a full scan per pass, and passes
   * slowed down as the tables grew. A pass needs the pools its own events
   * touch.
   */
  poolIds?: string[],
): Promise<Map<string, bigint>> {
  if (poolIds && poolIds.length === 0) return new Map();
  const rows = poolIds
    ? await prisma.$queryRaw<{ pool_id: string; sqrt_price_x96: string }[]>`
        SELECT DISTINCT ON (pool_id) pool_id, sqrt_price_x96::text
        FROM swap_events
        WHERE block_num < ${beforeBlock} AND pool_id = ANY(${poolIds})
        ORDER BY pool_id, block_num DESC, log_index DESC
      `
    : await prisma.$queryRaw<{ pool_id: string; sqrt_price_x96: string }[]>`
        SELECT DISTINCT ON (pool_id) pool_id, sqrt_price_x96::text
        FROM swap_events
        WHERE block_num < ${beforeBlock}
        ORDER BY pool_id, block_num DESC, log_index DESC
      `;
  const map = new Map<string, bigint>();
  for (const row of rows) map.set(row.pool_id, BigInt(row.sqrt_price_x96));

  // A pool that has never traded still has the price its Initialize set, and
  // a ModifyLiquidity before the first swap has to be valued at it.
  //
  // Read from the POOL row, not from pool_state. pool_state takes its price
  // from the pool's last swap, so a pool that has not swapped has zero there
  // and was filtered out — which is what left a freshly created pool with no
  // price at all and halted the indexer. The pool row carries the Initialize
  // price directly, which is the value an in-memory replay would have had.
  const created = await prisma.pool.findMany({
    where: {
      initSqrtPrice: { gt: 0 },
      ...(poolIds ? { id: { in: poolIds } } : {}),
    },
    select: { id: true, initSqrtPrice: true },
  });
  for (const row of created) {
    if (!map.has(row.id) && row.initSqrtPrice) map.set(row.id, BigInt(row.initSqrtPrice.toFixed(0)));
  }
  return map;
}

/** Fee tier per pool, for v3 swaps whose event carries no fee (§4). */
export async function loadFeeTiers(poolIds?: string[]): Promise<Map<string, number>> {
  const rows = await prisma.pool.findMany({
    ...(poolIds ? { where: { id: { in: poolIds } } } : {}),
    select: { id: true, feeTier: true },
  });
  return new Map(rows.map((r) => [r.id, r.feeTier]));
}

/** Which of these pools are known, so a batch can skip events for unknown ones. */
export async function loadKnownPools(poolIds?: string[]): Promise<Set<string>> {
  const rows = await prisma.pool.findMany({
    ...(poolIds ? { where: { id: { in: poolIds } } } : {}),
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Addresses of the v3 pools we already know about.
 *
 * v3 emits from each pool's own contract, so the poller has to name every one
 * of them in its log filter. Loading them from the database on startup is
 * what stops a restart quietly ceasing to index pools it discovered earlier.
 */
export async function loadV3PoolAddresses(): Promise<string[]> {
  const rows = await prisma.pool.findMany({
    where: { protocol: 'v3' },
    select: { address: true },
  });
  return rows.map((r) => r.address.toLowerCase());
}
