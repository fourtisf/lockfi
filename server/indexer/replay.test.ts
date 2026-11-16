/**
 * §9's acceptance criterion for P1, as a test.
 *
 *   "P1 is done when re-running the indexer from block zero on a fresh
 *    database produces byte-identical `pool_fee_hourly` rows to the
 *    incremental run, and a forced 32-block reorg replay changes no row
 *    count."
 *
 * Both halves are checked against a real Postgres, through the real SQL, over
 * a deterministic fixture chain of ABI-encoded logs — the decoder, the ingest
 * planner and the aggregation are all on the path, none of them mocked.
 *
 * Byte-identical means byte-identical: every numeric column is compared as
 * text, because comparing Postgres `numeric` through a JavaScript float would
 * hide the drift this criterion exists to catch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN, CONTRACTS } from '../../lib/chain';
import { prisma } from '../db';
import {
  dumpFeeHours,
  dumpPoolState,
  isReachable,
  resetDatabase,
  type FeeHourRow,
} from '../test/db';
import {
  ABSURD_POOL_ID,
  FixtureLogSource,
  USDG,
  buildAbsurdPoolChain,
  buildFixtureChain,
  fixtureTokenReader,
} from '../test/fixture';
import { Poller } from './poller';

const chain = buildFixtureChain();

function poller(source: FixtureLogSource, blockRange: number): Poller {
  return new Poller({
    source,
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange,
    tokenReader: fixtureTokenReader,
  });
}

let reachable = false;

beforeAll(async () => {
  reachable = await isReachable();
  if (!reachable) {
    // Loud, not silent. A skipped acceptance test that looks like a pass is
    // worse than a failure.
    throw new Error(
      'The P1 acceptance test needs a Postgres at TEST_DATABASE_URL ' +
        '(default postgresql://postgres@127.0.0.1:5433/balast_test). ' +
        'See README, "Running the P1 tests".',
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('§9 — the indexer replays deterministically', () => {
  /**
   * Run A: one pass over the whole chain, on a fresh database.
   * Run B: the same chain, followed a range at a time as a poller would.
   */
  let runFromZero: FeeHourRow[];
  let runIncremental: FeeHourRow[];

  it('indexes the fixture chain from block zero', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    // A range wide enough to swallow the chain in one pass.
    await poller(source, chain.headBlock + 1).syncToHead();

    runFromZero = await dumpFeeHours();

    // A fixture that produced no rows would make every comparison below pass
    // vacuously, so assert it did real work first.
    expect(runFromZero.length).toBeGreaterThan(50);
    const swaps = await prisma.swapEvent.count();
    expect(swaps).toBeGreaterThan(500);
    expect(await prisma.pool.count()).toBe(4);
  });

  it('produces byte-identical fee hours when followed incrementally', async () => {
    await resetDatabase();
    // Head advances in steps, and each pass sees only the blocks up to it —
    // the poller following a live chain rather than reading all of history.
    const source = new FixtureLogSource(chain, 0);
    const p = poller(source, 500);
    for (let head = 500; head <= chain.headBlock; head += 500) {
      source.setHead(head);
      await p.syncToHead();
    }
    source.setHead(chain.headBlock);
    await p.syncToHead();

    runIncremental = await dumpFeeHours();

    expect(runIncremental.length).toBe(runFromZero.length);
    // Compared as whole rows so a mismatch names the pool and hour.
    expect(runIncremental).toEqual(runFromZero);
  });

  it('agrees on pool_state too, not just the fee table', async () => {
    // pool_state carries the TVL every yield is divided by, so the criterion
    // is worth nothing if the divisor drifts between runs.
    const incremental = await dumpPoolState();
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await poller(source, chain.headBlock + 1).syncToHead();
    expect(await dumpPoolState()).toEqual(incremental);
  });

  it('a forced 32-block reorg replay changes no row count', async () => {
    // Start from a fully indexed chain.
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await poller(source, chain.headBlock + 1).syncToHead();

    const before = await dumpFeeHours();
    const swapsBefore = await prisma.swapEvent.count();
    const liquidityBefore = await prisma.liquidityEvent.count();

    // Force the replay: rewind the cursor by exactly the reorg depth and run
    // again, which is what a shallow reorg makes the poller do (§4.1).
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { lastIndexedBlock: cursor.lastIndexedBlock - BigInt(CHAIN.reorgDepth) },
    });

    const replaySource = new FixtureLogSource(chain);
    await poller(replaySource, chain.headBlock + 1).syncToHead();

    // The re-scan has to have actually covered the rewound window, or this
    // test would pass by not replaying anything.
    const scanned = replaySource.calls[0];
    expect(scanned).toBeDefined();
    expect(Number(scanned.to - scanned.from)).toBeGreaterThanOrEqual(CHAIN.reorgDepth);

    expect(await prisma.swapEvent.count()).toBe(swapsBefore);
    expect(await prisma.liquidityEvent.count()).toBe(liquidityBefore);

    const after = await dumpFeeHours();
    expect(after.length).toBe(before.length);
    // Stronger than the criterion asks: not one row moved, not just the count.
    expect(after).toEqual(before);
  });

  it('replaying the same range ten times changes nothing', async () => {
    // The criterion names 32 blocks; the property it depends on is that an
    // upsert-and-rebuild pipeline is idempotent under any repetition.
    const before = await dumpFeeHours();
    for (let i = 0; i < 10; i++) {
      const cursor = await prisma.indexerCursor.findFirstOrThrow();
      await prisma.indexerCursor.update({
        where: { contract: cursor.contract },
        data: { lastIndexedBlock: cursor.lastIndexedBlock - 500n },
      });
      await poller(new FixtureLogSource(chain), chain.headBlock + 1).syncToHead();
    }
    expect(await dumpFeeHours()).toEqual(before);
  });

  it('re-scans the last 32 blocks on every pass', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain, 0);
    const p = poller(source, 200);

    source.setHead(400);
    await p.syncToHead();
    const firstCalls = source.calls.length;

    source.setHead(600);
    await p.syncToHead();

    const resumed = source.calls[firstCalls];
    expect(resumed).toBeDefined();
    // The pass after the cursor reached 400 must start 32 blocks behind it.
    expect(resumed.from).toBe(400n - BigInt(CHAIN.reorgDepth) + 1n);
  });
});

describe('the fixture chain produces honest numbers', () => {
  beforeAll(async () => {
    await resetDatabase();
    await poller(new FixtureLogSource(chain), chain.headBlock + 1).syncToHead();
  });

  it('prices everything through the one WETH/USDG anchor', async () => {
    // §4.3 allows one anchor and one path. If the anchor were not found, every
    // USD figure would be zero — which is the honest failure, and exactly what
    // this asserts is NOT happening.
    const rows = await prisma.$queryRaw<{ pool_id: string; tvl_usd: string; price_usd: string }[]>`
      SELECT pool_id, tvl_usd::text, price_usd::text FROM pool_state ORDER BY pool_id
    `;
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(Number(row.price_usd)).toBeGreaterThan(0);
    }
    const totalTvl = rows.reduce((a, r) => a + Number(r.tvl_usd), 0);
    expect(totalTvl).toBeGreaterThan(0);
  });

  it('attributes a fee to every swap it could read, and none to those it could not', async () => {
    const [row] = await prisma.$queryRaw<
      { attributed: number; unreadable: number; zero_fee: number }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE fee_token IN (0, 1))::int AS attributed,
        COUNT(*) FILTER (WHERE fee_token = -1)::int      AS unreadable,
        COUNT(*) FILTER (WHERE fee_token IN (0, 1) AND fee_amount = 0)::int AS zero_fee
      FROM swap_events
    `;
    expect(row.attributed).toBeGreaterThan(500);
    // A swap whose direction could not be read must carry no fee rather than
    // a guessed one (§7).
    expect(row.unreadable).toBe(0);
    expect(row.zero_fee).toBe(0);
  });

  it('never records a negative fee or a negative hour', async () => {
    const [row] = await prisma.$queryRaw<{ bad: number }[]>`
      SELECT COUNT(*)::int AS bad FROM pool_fee_hourly
      WHERE fees_token0 < 0 OR fees_token1 < 0 OR fees_usd < 0 OR volume_usd < 0 OR swaps <= 0
    `;
    expect(row.bad).toBe(0);
  });

  it('buckets every fee into the hour its block was mined in', async () => {
    // The aggregate and the raw rows must agree exactly, per pool per hour.
    const [row] = await prisma.$queryRaw<{ mismatches: number }[]>`
      WITH direct AS (
        SELECT pool_id, date_trunc('hour', block_time) AS hour,
               SUM(CASE WHEN fee_token = 0 THEN fee_amount ELSE 0 END) AS f0,
               SUM(CASE WHEN fee_token = 1 THEN fee_amount ELSE 0 END) AS f1,
               COUNT(*)::int AS n
        FROM swap_events GROUP BY 1, 2
      )
      SELECT COUNT(*)::int AS mismatches
      FROM direct d
      FULL OUTER JOIN pool_fee_hourly f ON f.pool_id = d.pool_id AND f.hour = d.hour
      WHERE d.f0 IS DISTINCT FROM f.fees_token0
         OR d.f1 IS DISTINCT FROM f.fees_token1
         OR d.n  IS DISTINCT FROM f.swaps
    `;
    expect(row.mismatches).toBe(0);
  });
});

describe('a pool at an absurd tick does not stop the indexer', () => {
  /**
   * The regression that found the bug. A pool whose derived price is around
   * 1e24 USD used to overflow `numeric(38,18)`, which threw inside the
   * aggregation and stopped the pass — freezing every OTHER pool's data as
   * collateral. Nothing prevents such a pool existing on the real chain.
   */
  beforeAll(async () => {
    await resetDatabase();
    const chain = buildAbsurdPoolChain();
    const source = new FixtureLogSource(chain);
    // If this throws, the regression is back.
    await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
  });

  it('still indexes the sane pool alongside it', async () => {
    expect(await prisma.pool.count()).toBe(2);
    expect(await prisma.poolFeeHourly.count()).toBeGreaterThan(0);
  });

  it('leaves the absurd pool unpriced rather than astronomically valued', async () => {
    // Unpriced, not clamped. A clamped figure would render as a real TVL of
    // a quadrillion dollars, which is worse than showing nothing (§7).
    const [row] = await prisma.$queryRaw<{ tvl_usd: string; price_usd: string }[]>`
      SELECT tvl_usd::text, price_usd::text FROM pool_state WHERE pool_id = ${ABSURD_POOL_ID}
    `;
    expect(row).toBeDefined();
    expect(Number(row.tvl_usd)).toBe(0);
    expect(Number(row.price_usd)).toBe(0);
  });

  it('keeps every USD figure inside the sane bound', async () => {
    const [row] = await prisma.$queryRaw<{ bad: number }[]>`
      SELECT (
        (SELECT COUNT(*) FROM pool_state WHERE tvl_usd >= 1e15 OR price_usd >= 1e12)
        + (SELECT COUNT(*) FROM pool_fee_hourly WHERE fees_usd >= 1e15 OR volume_usd >= 1e15)
      )::int AS bad
    `;
    expect(row.bad).toBe(0);
  });

  it('and the sane pool in the same batch is priced normally', async () => {
    const [row] = await prisma.$queryRaw<{ price_usd: string }[]>`
      SELECT ps.price_usd::text
      FROM pool_state ps
      WHERE ps.pool_id <> ${ABSURD_POOL_ID}
      LIMIT 1
    `;
    // The other pool is the WETH/USDG anchor. USDG outranks WETH as a quote,
    // so its traded side is WETH and this figure is WETH in USD — which is
    // the assertion that caught the two files disagreeing about which side of
    // a pool is the token.
    expect(Number(row.price_usd)).toBeGreaterThan(100);
    expect(Number(row.price_usd)).toBeLessThan(100_000);
  });
});

describe('a pool whose initial mint predates START_BLOCK', () => {
  /**
   * A real and easily-hit case: START_BLOCK is set above a pool's creation
   * block, so the indexer sees that pool's outflows without the mint that
   * funded them and its derived reserves go negative.
   *
   * The pool's depth is then UNKNOWN, not zero — and the one thing that must
   * not happen is a yield figure divided by a divisor we know is wrong. §7
   * calls for the em dash, so that is what has to come out.
   */
  beforeAll(async () => {
    await resetDatabase();
    // Start well after every pool was created and liquidity was seeded.
    const source = new FixtureLogSource(chain);
    await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 6_000n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
  });

  it('indexes nothing, because a pool is only discovered by its Initialize', async () => {
    // Every Initialize is below the start block, so no pool exists and the
    // swaps have nowhere to attach. The poller logs how many it dropped.
    expect(await prisma.pool.count()).toBe(0);
    expect(await prisma.swapEvent.count()).toBe(0);
  });

  it('reports no pools rather than pools with invented depth', async () => {
    const snapshotRows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pool_state
    `;
    expect(snapshotRows[0].n).toBe(0);
  });
});

describe('reserves that go negative leave the depth unknown', () => {
  /**
   * The same failure one step further in: the pool IS known (its Initialize
   * was indexed) but its funding mint was not, so the flow sums negative.
   * Constructed directly, because the poller cannot produce it without also
   * dropping the pool.
   */
  beforeAll(async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    // Delete the seeding mint for one pool, then rebuild the aggregates.
    const target = await prisma.pool.findFirstOrThrow({
      where: { id: { not: ABSURD_POOL_ID } },
      orderBy: { id: 'asc' },
    });
    await prisma.liquidityEvent.deleteMany({ where: { poolId: target.id } });
    const { rebuildAggregates } = await import('./aggregate');
    const { findAnchorPool } = await import('./discovery');
    await rebuildAggregates(
      {
        weth: CONTRACTS.weth.toLowerCase(),
        usdg: USDG.toLowerCase(),
        wethDecimals: 18,
        usdgDecimals: 6,
        anchorPoolId: await findAnchorPool(USDG),
      },
      undefined,
      // The flows are no longer rebuilt per pass; this test reads them.
      { flows: true },
    );
  });

  it('records zero depth rather than a negative or a guess', async () => {
    const rows = await prisma.$queryRaw<{ pool_id: string; tvl_usd: string }[]>`
      SELECT ps.pool_id, ps.tvl_usd::text
      FROM pool_state ps
      JOIN (
        SELECT pool_id, SUM(delta0) AS r0, SUM(delta1) AS r1
        FROM pool_flow_hourly GROUP BY pool_id
      ) f ON f.pool_id = ps.pool_id
      WHERE f.r0 < 0 OR f.r1 < 0
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.tvl_usd)).toBe(0);
    }
  });

  it('and therefore shows no yield figure at all for it', async () => {
    const { buildSnapshot } = await import('../api/snapshot');
    const snapshot = await buildSnapshot({ usdgAddress: USDG });
    expect(snapshot).not.toBeNull();
    const unknown = snapshot!.pools.filter((p) => p.tvlUsd === 0);
    expect(unknown.length).toBeGreaterThan(0);
    for (const pool of unknown) {
      // The em dash, not a number over a divisor we know is wrong (§7).
      expect(pool.feeYield.basis).toBe('insufficient');
    }
  });
});
