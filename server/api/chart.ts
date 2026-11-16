/**
 * A pool's price over time, for the token page (§32): the close of each hour
 * — the last swap in it — in dollars, from the indexer's own swap rows and
 * through the one allowed path to a dollar (§4.3: the pool's ratio, then WETH
 * at that hour from `weth_usd_hourly`, or USDG at $1). No third-party price,
 * no averaging across pools.
 *
 * Ends where every other figure on the site ends: at the last swap the
 * indexer read (snapshot.ts), not at wall-clock now, so a chart from an
 * indexer that is behind is the chart of the days it has read, with the lag
 * in the top bar — never a flat line drawn across hours nobody read.
 *
 * Hours without a trade have no point: the price did not move, and a point
 * would claim a trade that did not happen. The chart draws straight between.
 */

import { CONTRACTS } from '../../lib/chain';
import { prisma } from '../db';
import { tradedSide } from '../indexer/aggregate';

export interface PricePoint {
  /** The hour's start, ISO. */
  t: string;
  /** Dollars per whole token at the hour's last trade. */
  p: number;
}

export interface PoolChart {
  poolId: string;
  hours: number;
  /** The moment the chart ends: the last swap read. Null when none is. */
  asOf: string | null;
  points: PricePoint[];
}

export const CHART_HOURS = [24, 168] as const;
const POOL_ID = /^v[34]:0x[0-9a-fA-F]{40,64}$/;
const TTL_MS = 60_000;
const MAX_CACHED = 500;

export function isPoolId(id: string): boolean {
  return POOL_ID.test(id);
}

export async function queryPoolChart(poolId: string, usdg: string, hours: number): Promise<PoolChart> {
  const weth = CONTRACTS.weth.toLowerCase();
  const u = usdg.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(u)) throw new Error('the USD anchor is not an address');
  const sql = `
    WITH mark AS (
      SELECT block_time AS as_of FROM swap_events ORDER BY block_num DESC LIMIT 1
    ),
    pool AS (
      SELECT p.id, p.token0, p.token1, t0.decimals AS d0, t1.decimals AS d1
      FROM pools p
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      -- Nothing values a token whose decimals are not read yet (§19).
      WHERE p.id = $1 AND t0.decimals >= 0 AND t1.decimals >= 0
    ),
    closes AS (
      SELECT DISTINCT ON (date_trunc('hour', sw.block_time))
        date_trunc('hour', sw.block_time) AS hour, sw.sqrt_price_x96
      FROM swap_events sw, mark
      WHERE sw.pool_id = $1
        AND sw.block_time >  mark.as_of - ($2 * interval '1 hour')
        AND sw.block_time <= mark.as_of
      ORDER BY date_trunc('hour', sw.block_time), sw.block_time DESC, sw.block_num DESC, sw.log_index DESC
    ),
    ratios AS (
      SELECT c.hour,
        (power(c.sqrt_price_x96::numeric, 2) * power(10::numeric, GREATEST(pl.d0 - pl.d1, 0)))
          / power(2::numeric, 192)
          / power(10::numeric, GREATEST(pl.d1 - pl.d0, 0)) AS ratio,
        pl.token0, pl.token1
      FROM closes c CROSS JOIN pool pl
    )
    SELECT r.hour,
      (${tradedSide({
        addr0: 'r.token0',
        addr1: 'r.token1',
        weth,
        usdg: u,
        whenToken0: `r.ratio * (CASE WHEN lower(r.token1) = '${u}' THEN 1 ELSE wh.weth_usd END)`,
        whenToken1: `(CASE WHEN lower(r.token0) = '${u}' THEN 1 ELSE wh.weth_usd END) / NULLIF(r.ratio, 0)`,
      })})::float8 AS price_usd,
      (SELECT as_of FROM mark) AS as_of
    FROM ratios r
    LEFT JOIN LATERAL (
      SELECT w.weth_usd FROM weth_usd_hourly w WHERE w.hour <= r.hour ORDER BY w.hour DESC LIMIT 1
    ) wh ON true
    ORDER BY r.hour`;
  const rows = await prisma.$queryRawUnsafe<{ hour: Date; price_usd: number | null; as_of: Date | null }[]>(sql, poolId, hours);
  const [mark] = rows.length > 0 ? [] : await prisma.$queryRaw<{ block_time: Date }[]>`
    SELECT block_time FROM swap_events ORDER BY block_num DESC LIMIT 1
  `;
  const asOf = rows[0]?.as_of ?? mark?.block_time ?? null;
  return {
    poolId,
    hours,
    asOf: asOf ? asOf.toISOString() : null,
    // A price that is not a finite positive number is not a price (an
    // unpriced hour before the anchor existed): left out, never drawn at 0.
    points: rows
      .filter((r) => r.price_usd !== null && Number.isFinite(r.price_usd) && r.price_usd > 0)
      .map((r) => ({ t: r.hour.toISOString(), p: r.price_usd as number })),
  };
}

/** Charts for a minute: a token page is opened by many people at once, and the hour's close moves slowly. */
export function createChartCache(ttlMs = TTL_MS) {
  const memo = new Map<string, { at: number; value: Promise<PoolChart> }>();
  return (poolId: string, usdg: string, hours: number): Promise<PoolChart> => {
    const key = `${poolId.toLowerCase()}:${hours}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = queryPoolChart(poolId, usdg, hours);
    // A failure is not remembered: the next request asks again.
    value.catch(() => memo.delete(key));
    if (memo.size >= MAX_CACHED) memo.delete(memo.keys().next().value as string);
    memo.set(key, { at: Date.now(), value });
    return value;
  };
}
