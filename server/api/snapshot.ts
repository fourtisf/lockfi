/**
 * SQL to `MarketSnapshot`. The one place the database meets the UI's contract.
 *
 * Two rules from the handoff shape everything here.
 *
 * §4.2 — fee yield is computed in SQL, never in a component. The arithmetic
 * below is `fees_window / tvl_now * (365*24 / window_hours) * 100`, done in
 * Postgres. What stays in TypeScript is only the *classification* into §7's
 * three states, and it reuses `lib/yield.ts` so the live boards and the
 * simulator cannot drift apart. There is a test asserting the SQL and
 * `computeFeeYield` agree.
 *
 * §7 — the trailing window ends at the last block we have indexed, not at
 * wall-clock now. If the indexer is an hour behind, wall-clock would count
 * that hour as zero fees and quietly deflate every yield on the board. So the
 * window is honest and the lag is reported separately, which is what the top
 * bar shows.
 *
 * Anything P1 genuinely cannot know is zero or empty, never invented. There
 * are no vault contracts until P2, so there are no stakes, no positions and
 * no harvest payouts — the components already have empty states for that.
 */

import { CONTRACTS, PROTOCOL_FEE_BPS, REWARD_WINDOW_SECONDS } from '../../lib/chain';
import type {
  FeeYield,
  MarketSnapshot,
  Pool,
  Portfolio,
  Quote,
  RouterPlan,
  Vault,
} from '../../lib/data/types';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS } from '../../lib/yield';
import { prisma } from '../db';
import { resolveUsdg } from '../indexer/anchor';
import { tradedSide } from '../indexer/aggregate';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';

/** Buckets in a row's fee sparkline, and therefore hours per bucket. */
const SPARK_BUCKETS = 14;
const SPARK_BUCKET_HOURS = YIELD_WINDOW_HOURS / SPARK_BUCKETS; // 12h

export interface SnapshotOptions {
  /** Wallet to build the portfolio for. Without one the portfolio is empty. */
  wallet?: string | null;
  /**
   * USDG's address. Optional: when absent it is discovered from the chain's
   * own tokens, the same way the indexer does it.
   */
  usdgAddress?: string | null;
}

interface PoolQueryRow {
  id: string;
  address: string;
  protocol: string;
  fee_tier: number;
  stakeable: boolean;
  token_address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_color: string | null;
  logo_url: string | null;
  launchpad: string | null;
  quote_symbol: string | null;
  age_hours: number;
  tvl_usd: number;
  price_usd: number;
  mc_usd: number;
  change_24h_pct: number | null;
  fees_24h_usd: number;
  fees_window_usd: number;
  window_hours: number;
  volume_24h_usd: number;
  trades_24h: number;
  /** Computed in SQL (§4.2). Null when there is no depth to divide by. */
  fee_yield_pct: number | null;
  spark: number[];
}

/**
 * The main query.
 *
 * `as_of` is the chain time of the last block indexed. Everything trailing is
 * measured back from it, so the figures describe a consistent moment rather
 * than a mixture of chain time and wall time.
 */
async function queryPools(usdg: string, asOf: Date): Promise<PoolQueryRow[]> {
  const weth = CONTRACTS.weth.toLowerCase();
  const usdgLower = usdg.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdgLower)) {
    throw new Error(`USDG_ADDRESS is not an address: ${JSON.stringify(usdg)}`);
  }

  /** Pick a column from whichever side of the pool is the traded one. */
  const side = (whenToken0: string, whenToken1: string): string =>
    tradedSide({
      addr0: 'p.token0',
      addr1: 'p.token1',
      weth,
      usdg: usdgLower,
      whenToken0,
      whenToken1,
      // A pool with neither quote is filtered out by the WHERE below, so this
      // branch is unreachable; token0 keeps the column non-null regardless.
      otherwise: whenToken0,
    });

  // Built as a string rather than a tagged template, because the traded-side
  // rule above is SQL, and a tagged template would bind it as a text
  // parameter instead of injecting it. `asOf` stays a real bound parameter;
  // the two addresses are regex-checked before they reach the string.
  const sql = `
    WITH params AS (
      SELECT
        $1::timestamp                                       AS as_of,
        $1::timestamp - interval '24 hours'                 AS since_24h,
        $1::timestamp - (${YIELD_WINDOW_HOURS} * interval '1 hour') AS since_window
    ),

    -- The anchor's price at two moments, for an honest 24h change (§4.3).
    anchor_pool AS (
      SELECT p.id, p.token0, p.token1
      FROM pools p
      LEFT JOIN pool_state ps ON ps.pool_id = p.id
      WHERE (lower(p.token0) = '${weth}' AND lower(p.token1) = '${usdgLower}')
         OR (lower(p.token0) = '${usdgLower}' AND lower(p.token1) = '${weth}')
      ORDER BY COALESCE(ps.liquidity, 0) DESC, p.created_block ASC
      LIMIT 1
    ),

    moments AS (
      SELECT as_of AS moment FROM params
      UNION ALL
      SELECT since_24h FROM params
    ),

    -- Last swap in a pool at or before a moment: its price at that moment.
    ratio_at AS (
      SELECT
        p.id AS pool_id,
        m.moment,
        (SELECT (power(sw.sqrt_price_x96::numeric, 2)
                   * power(10::numeric, GREATEST(t0.decimals - t1.decimals, 0)))
                / power(2::numeric, 192)
                / power(10::numeric, GREATEST(t1.decimals - t0.decimals, 0))
         FROM swap_events sw
         WHERE sw.pool_id = p.id AND sw.block_time <= m.moment
         ORDER BY sw.block_num DESC, sw.log_index DESC
         LIMIT 1) AS ratio
      FROM pools p
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      CROSS JOIN moments m
    ),

    -- WETH in USD at each moment, from the anchor pool and nothing else.
    anchor_usd AS (
      SELECT r.moment,
        CASE
          WHEN lower(ap.token1) = '${usdgLower}' THEN r.ratio
          WHEN lower(ap.token0) = '${usdgLower}' THEN 1 / NULLIF(r.ratio, 0)
          ELSE NULL
        END AS weth_usd
      FROM anchor_pool ap
      JOIN ratio_at r ON r.pool_id = ap.id
    ),

    -- Each pool's traded-side USD price at both moments, through the one
    -- allowed path and the one traded-side rule.
    priced AS (
      SELECT
        p.id AS pool_id,
        r.moment,
        ${tradedSide({
          addr0: 'p.token0',
          addr1: 'p.token1',
          weth,
          usdg: usdgLower,
          // token0 is traded: the ratio already reads in quote terms.
          whenToken0: `r.ratio * (CASE WHEN lower(p.token1) = '${usdgLower}' THEN 1 ELSE au.weth_usd END)`,
          // token1 is traded: invert the ratio first.
          whenToken1: `(CASE WHEN lower(p.token0) = '${usdgLower}' THEN 1 ELSE au.weth_usd END) / NULLIF(r.ratio, 0)`,
        })} AS price_usd
      FROM pools p
      JOIN ratio_at r ON r.pool_id = p.id
      LEFT JOIN anchor_usd au ON au.moment = r.moment
    ),

    -- A pool with no trade before the window still has a 24h move: from its
    -- FIRST trade inside the window to now. Most new pools are exactly that,
    -- and they all read 0.0% when the move was computed only from a price
    -- 24h ago that did not exist. Valued with WETH/USD at the hour of that
    -- trade, from the same anchor series, so the ratio stays honest.
    first_trade AS (
      SELECT p.id AS pool_id, ft.block_time,
        (power(ft.sqrt_price_x96::numeric, 2)
           * power(10::numeric, GREATEST(t0.decimals - t1.decimals, 0)))
          / power(2::numeric, 192)
          / power(10::numeric, GREATEST(t1.decimals - t0.decimals, 0)) AS ratio
      FROM pools p
      CROSS JOIN params pr
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      CROSS JOIN LATERAL (
        SELECT sw.block_time, sw.sqrt_price_x96
        FROM swap_events sw
        WHERE sw.pool_id = p.id AND sw.block_time > pr.since_24h AND sw.block_time <= pr.as_of
        ORDER BY sw.block_num ASC, sw.log_index ASC
        LIMIT 1
      ) ft
    ),

    first_priced AS (
      SELECT
        p.id AS pool_id,
        ${tradedSide({
          addr0: 'p.token0',
          addr1: 'p.token1',
          weth,
          usdg: usdgLower,
          whenToken0: `ft.ratio * (CASE WHEN lower(p.token1) = '${usdgLower}' THEN 1 ELSE wh.weth_usd END)`,
          whenToken1: `(CASE WHEN lower(p.token0) = '${usdgLower}' THEN 1 ELSE wh.weth_usd END) / NULLIF(ft.ratio, 0)`,
        })} AS price_usd
      FROM first_trade ft
      JOIN pools p ON p.id = ft.pool_id
      LEFT JOIN LATERAL (
        SELECT w.weth_usd FROM weth_usd_hourly w
        WHERE w.hour <= ft.block_time
        ORDER BY w.hour DESC
        LIMIT 1
      ) wh ON true
    ),

    -- Trailing sums straight out of pool_fee_hourly (§4.2).
    fees AS (
      SELECT
        p.id AS pool_id,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.fees_usd END), 0)    AS fees_24h_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_window THEN f.fees_usd END), 0) AS fees_window_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.volume_usd END), 0)  AS volume_24h_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.swaps END), 0)::int  AS trades_24h
      FROM pools p
      CROSS JOIN params pr
      LEFT JOIN pool_fee_hourly f ON f.pool_id = p.id AND f.hour >= pr.since_window
      GROUP BY p.id
    ),

    -- 14 buckets of 12 hours across the trailing window, for the sparkline.
    spark AS (
      SELECT p.id AS pool_id,
        array_agg(COALESCE(b.total, 0)::float8 ORDER BY b.bucket) AS spark
      FROM pools p
      CROSS JOIN params pr
      CROSS JOIN LATERAL (
        SELECT g.bucket,
          (SELECT SUM(f.fees_usd) FROM pool_fee_hourly f
            WHERE f.pool_id = p.id
              AND f.hour >= pr.as_of - ((${SPARK_BUCKETS} - g.bucket) * ${SPARK_BUCKET_HOURS} * interval '1 hour')
              AND f.hour <  pr.as_of - ((${SPARK_BUCKETS} - g.bucket - 1) * ${SPARK_BUCKET_HOURS} * interval '1 hour')
          ) AS total
        FROM generate_series(0, ${SPARK_BUCKETS - 1}) AS g(bucket)
      ) b
      GROUP BY p.id
    )

    SELECT
      p.id,
      p.address,
      p.protocol,
      p.fee_tier,
      p.stakeable,
      -- The traded side, by the one rule in aggregate.ts. Using a different
      -- rule here is how the WETH/USDG row once read "WETH · $1.00".
      ${side('t0.address', 't1.address')}       AS token_address,
      ${side('t0.symbol', 't1.symbol')}         AS symbol,
      ${side('t0.name', 't1.name')}             AS name,
      ${side('t0.decimals', 't1.decimals')}     AS decimals,
      ${side('t0.logo_color', 't1.logo_color')} AS logo_color,
      ${side('t0.logo_url', 't1.logo_url')}     AS logo_url,
      ${side('t0.launchpad', 't1.launchpad')}   AS launchpad,
      -- USDG outranks WETH as the quote, matching the rule above.
      CASE
        WHEN lower(p.token0) = '${usdgLower}' OR lower(p.token1) = '${usdgLower}' THEN 'USDG'
        WHEN lower(p.token0) = '${weth}'      OR lower(p.token1) = '${weth}'      THEN 'ETH'
        ELSE NULL
      END AS quote_symbol,

      GREATEST(0, EXTRACT(EPOCH FROM (pr.as_of - p.created_at)) / 3600)::float8 AS age_hours,
      COALESCE(ps.tvl_usd, 0)::float8   AS tvl_usd,
      COALESCE(ps.price_usd, 0)::float8 AS price_usd,
      COALESCE(ps.mc_usd, 0)::float8    AS mc_usd,

      -- 24h move, both prices through the same path so the ratio is honest.
      -- The reference is the last price before the window, or failing that
      -- the first trade inside it. Neither: unknown, never 0%.
      CASE
        WHEN pnow.price_usd IS NULL
          OR COALESCE(pthen.price_usd, pfirst.price_usd) IS NULL
          OR COALESCE(pthen.price_usd, pfirst.price_usd) = 0 THEN NULL
        ELSE ((pnow.price_usd / COALESCE(pthen.price_usd, pfirst.price_usd)) - 1) * 100
      END::float8 AS change_24h_pct,

      f.fees_24h_usd::float8    AS fees_24h_usd,
      f.fees_window_usd::float8 AS fees_window_usd,
      -- The window is capped at the pool's own age: a 30-hour-old pool is
      -- annualised over 30 hours, not over 168 it never had (§7).
      LEAST(
        ${YIELD_WINDOW_HOURS}::numeric,
        GREATEST(1, EXTRACT(EPOCH FROM (pr.as_of - p.created_at)) / 3600)
      )::float8 AS window_hours,
      f.volume_24h_usd::float8  AS volume_24h_usd,
      f.trades_24h,

      -- §4.2: the yield arithmetic, in SQL.
      CASE
        WHEN COALESCE(ps.tvl_usd, 0) <= 0 THEN NULL
        ELSE (
          f.fees_window_usd / ps.tvl_usd
          * ((365 * 24)::numeric / LEAST(
              ${YIELD_WINDOW_HOURS}::numeric,
              GREATEST(1, EXTRACT(EPOCH FROM (pr.as_of - p.created_at)) / 3600)))
          * 100
        )
      END::float8 AS fee_yield_pct,

      s.spark
    FROM pools p
    CROSS JOIN params pr
    JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
    JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
    LEFT JOIN pool_state ps ON ps.pool_id = p.id
    LEFT JOIN fees  f ON f.pool_id = p.id
    LEFT JOIN spark s ON s.pool_id = p.id
    LEFT JOIN priced pnow  ON pnow.pool_id  = p.id AND pnow.moment  = pr.as_of
    LEFT JOIN priced pthen ON pthen.pool_id = p.id AND pthen.moment = pr.since_24h
    LEFT JOIN first_priced pfirst ON pfirst.pool_id = p.id
    -- A pool with neither WETH nor USDG on a side cannot be priced through
    -- the one allowed path, so it is not listed rather than listed at zero.
    WHERE lower(p.token0) IN ('${weth}', '${usdgLower}')
       OR lower(p.token1) IN ('${weth}', '${usdgLower}')
    ORDER BY COALESCE(ps.tvl_usd, 0) DESC
  `;

  return prisma.$queryRawUnsafe<PoolQueryRow[]>(sql, asOf);
}

/**
 * §7's three states, from the SQL figure.
 *
 * The thresholds are `lib/yield.ts`'s, not copies of them, so the live boards
 * and the simulator can never disagree about when a number is honest.
 */
export function classifyYield(row: {
  fee_yield_pct: number | null;
  age_hours: number;
  window_hours: number;
  tvl_usd: number;
}): FeeYield {
  if (row.fee_yield_pct === null || row.age_hours < MIN_DATA_HOURS || row.tvl_usd <= 0) {
    return { basis: 'insufficient' };
  }
  if (row.age_hours < YIELD_WINDOW_HOURS) {
    return { basis: 'estimate', pct: row.fee_yield_pct, windowHours: row.window_hours };
  }
  return { basis: 'trailing7d', pct: row.fee_yield_pct };
}

function toPool(row: PoolQueryRow): Pool {
  return {
    id: row.id,
    address: row.address,
    token: {
      address: row.token_address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      logoColor: row.logo_color ?? 'var(--fg-3)',
      logoUrl: row.logo_url ?? undefined,
      launchpad: row.launchpad ?? undefined,
    },
    quote: (row.quote_symbol ?? 'ETH') as Quote,
    // Pool fees are in hundredths of a bip on chain; the UI wants bips.
    feeTierBps: Math.round(row.fee_tier / 100),
    protocol: row.protocol === 'v3' ? 'v3' : 'v4',
    stakeable: row.stakeable,
    ageHours: row.age_hours,
    priceUsd: row.price_usd,
    // totalSupply x price. That is fully diluted value, not market cap, and
    // it is flagged so the row can say which it is (§7). Zero means no supply
    // has been read yet, and the column renders an em dash.
    marketCapUsd: row.mc_usd,
    marketCapIsFdv: row.mc_usd > 0,
    tvlUsd: row.tvl_usd,
    // Unknown stays unknown: null renders as an em dash, never as 0.0%.
    change24hPct: row.change_24h_pct ?? null,
    fees24hUsd: row.fees_24h_usd,
    feesWindowUsd: row.fees_window_usd,
    feeWindowHours: row.window_hours,
    volume24hUsd: row.volume_24h_usd,
    trades24h: row.trades_24h,
    feeHistory: row.spark.length > 0 ? row.spark : new Array(SPARK_BUCKETS).fill(0),
    feeYield: classifyYield(row),
  };
}

/** Vaults, once P2 deploys them. Until then this is empty and honest. */
async function queryVaults(): Promise<Vault[]> {
  const rows = await prisma.vault.findMany({
    include: { pool: { select: { id: true } } },
  });
  const now = Date.now();
  return rows.map((v) => ({
    id: `vault-${v.poolId}`,
    poolId: v.poolId,
    address: v.address,
    totalStakedUsd: Number(v.totalStakedUsd),
    stakers: v.stakers,
    rewardRate: Number(v.rewardRate) / 1e18,
    nextHarvestInSeconds: Math.max(0, (v.periodFinish.getTime() - now) / 1000),
    protocolFeeBps: v.protocolFeeBps,
  }));
}

/**
 * The connected wallet's portfolio.
 *
 * There is no wallet connector and no vault until P2, so this is zeros and
 * empty lists. The components have empty states for exactly this; inventing a
 * position would be the dishonest alternative.
 */
async function queryPortfolio(wallet: string | null): Promise<Portfolio> {
  const empty: Portfolio = {
    netValueUsd: 0,
    netChangeUsd: 0,
    netChangePct: 0,
    feesEarnedWeth: 0,
    feesEarnedUsd: 0,
    priceImpactUsd: 0,
    fees7dUsd: 0,
    dailyFeesWeth: new Array(56).fill(0),
    stakes: [],
    positions: [],
    claimableWeth: 0,
    // No wallet connector until P2, so no balance to read.
    walletBalanceEth: null,
  };
  if (!wallet) return empty;

  const [stakes, positions] = await Promise.all([
    prisma.stake.findMany({
      where: { wallet: wallet.toLowerCase() },
      include: { vault: true },
    }),
    prisma.position.findMany({ where: { wallet: wallet.toLowerCase() } }),
  ]);

  const now = Date.now();
  return {
    ...empty,
    stakes: stakes.map((s) => {
      const remaining = Math.max(0, (s.vault.periodFinish.getTime() - now) / 1000);
      return {
        vaultId: `vault-${s.vaultId}`,
        poolId: s.vaultId,
        stakedUsd: 0,
        earnedWeth: 0,
        streamProgressPct: 100 - (remaining / REWARD_WINDOW_SECONDS) * 100,
        streamRemainingSeconds: remaining,
      };
    }),
    positions: positions.map((p) => ({
      tokenId: p.tokenId,
      poolId: p.poolId,
      shape: (p.shape as 'spot' | 'curve' | 'bidask') ?? 'spot',
      rangePct: 0,
      inRange: p.status === 'in-range',
      valueUsd: 0,
      feesWeth: 0,
    })),
  };
}

/**
 * The router plan.
 *
 * `TidewellRouter` is P4, so nothing has accrued and nothing has been routed.
 * The current depth is real — it is the pool's own — and everything that
 * depends on a fee stream is zero.
 */
async function queryRouter(pools: Pool[]): Promise<RouterPlan> {
  const config = await prisma.routerConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  const target = pools.find((p) => p.stakeable) ?? pools[0];

  return {
    tokenSymbol: target?.token.symbol ?? '—',
    feeSourceAddress: config?.feeSource ?? '—',
    accruedWeth: 0,
    accruedUsd: 0,
    currentDepthUsd: target?.tvlUsd ?? 0,
    projectedDepthUsd: target?.tvlUsd ?? 0,
    slippageNowPct: 0,
    slippageLaterPct: 0,
    firstRouteWeth: 0,
    firstRouteDepthUsd: 0,
    twapMinutes: 30,
    // Nothing verifies a deployer until the router ships.
    deployerVerified: false,
  };
}

let revision = 0;

/**
 * Build the whole snapshot.
 *
 * Returns null when there is nothing honest to render yet — no indexed blocks
 * at all. The `DataProvider` interface has always allowed that ("null if none
 * has arrived yet"); this is the case that produces it.
 */
export async function buildSnapshot(
  options: SnapshotOptions,
): Promise<MarketSnapshot | null> {
  const cursor = await prisma.indexerCursor.findUnique({
    where: { contract: POOL_MANAGER_CURSOR },
  });
  if (!cursor) return null;

  // The anchor: pinned by configuration, or discovered from indexed tokens.
  // Without one nothing has a dollar figure, so there is nothing honest to
  // render — the same null the UI already handles.
  const anchor = await resolveUsdg(options.usdgAddress);
  if (!anchor.address) return null;

  const asOf = cursor.lastIndexedAt;
  const [rows, vaults, portfolio] = await Promise.all([
    queryPools(anchor.address, asOf),
    queryVaults(),
    queryPortfolio(options.wallet ?? null),
  ]);

  const pools = rows.map(toPool);
  const router = await queryRouter(pools);

  // Every figure that can be summed from the pools is summed from them, so
  // the top bar cannot contradict the table beneath it (§12).
  const tvlUsd = pools.reduce((a, p) => a + p.tvlUsd, 0);
  const fees24hUsd = pools.reduce((a, p) => a + p.fees24hUsd, 0);
  const volume24hUsd = pools.reduce((a, p) => a + p.volume24hUsd, 0);
  const stakers = vaults.reduce((a, v) => a + v.stakers, 0);
  // Depth-weighted, over the pools that HAVE a 24h figure — a pool with none
  // is left out of both sides, not counted as having moved 0%.
  const moved = pools.filter((p) => p.change24hPct !== null);
  const movedTvl = moved.reduce((a, p) => a + p.tvlUsd, 0);
  const change24hPct =
    movedTvl > 0 ? moved.reduce((a, p) => a + (p.change24hPct ?? 0) * p.tvlUsd, 0) / movedTvl : 0;

  const [totals] = await prisma.$queryRaw<{ fees_usd: number; positions: number }[]>`
    SELECT
      COALESCE((SELECT SUM(fees_usd) FROM pool_fee_hourly), 0)::float8 AS fees_usd,
      COALESCE((SELECT COUNT(*) FROM positions), 0)::int              AS positions
  `;

  // ETH in USD: the latest row of the anchor series, and nothing else (§4.3).
  //
  // Not "the deepest pool containing WETH", which is what this used to read.
  // `pool_state.price_usd` is the TRADED side's price, so the deepest
  // WETH pool — NVDA/WETH — reported NVDA's price as the price of ether.
  // `weth_usd_hourly` exists precisely so there is one answer to this.
  const [ethRow] = await prisma.$queryRaw<{ price_usd: number }[]>`
    SELECT COALESCE(weth_usd, 0)::float8 AS price_usd
    FROM weth_usd_hourly
    ORDER BY hour DESC
    LIMIT 1
  `;

  // Chain share needs the chain's total liquidity, and the PoolManager is the
  // chain's v4 liquidity — so our share of what we index is 100% and
  // meaningless. It stays at zero until there is a figure to compare against.
  const featuredHistory = bucketSum(pools.map((p) => p.feeHistory));

  return {
    pools,
    vaults,
    portfolio,
    global: {
      totalPositions: totals?.positions ?? 0,
      totalFeesUsd: totals?.fees_usd ?? 0,
      tvlUsd,
      ethPriceUsd: ethRow?.price_usd ?? 0,
    },
    featured: {
      fees24hUsd,
      change24hPct,
      volume24hUsd,
      liquidityUsd: tvlUsd,
      stakers,
      chainSharePct: 0,
      history: featuredHistory,
    },
    router,
    // Harvest payouts need a vault (P2). No invented feed.
    payouts: [],
    payoutTotalUsd: 0,
    indexerLagSeconds: Math.max(0, (Date.now() - asOf.getTime()) / 1000),
    revision: ++revision,
  };
}

/** Element-wise sum of equal-length series, for the featured chart. */
function bucketSum(series: number[][]): number[] {
  const out = new Array(SPARK_BUCKETS).fill(0);
  for (const row of series) {
    for (let i = 0; i < Math.min(row.length, SPARK_BUCKETS); i++) out[i] += row[i];
  }
  return out;
}
