/**
 * Each vault's live figures, from what the vault watcher read off the chain
 * (server/keeper/vault-watch.ts): its pool's swaps over the trailing window
 * and its state at the last block read.
 *
 * Sums are taken in SQL, exactly, as integers; turning them into dollars and
 * a yield is done here, server-side, by the pure functions in
 * keeper/vault-math.ts — never in a component (§4.2's rule is about where the
 * arithmetic lives, and it lives with the data). The yield is the full-range
 * rate, which needs no depth figure: see vault-math.ts for why that is the
 * vault's honest number and the pool average is not.
 */

import { zeroAddress } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import type { FeeYield, VaultCurrency, VaultLive } from '../../lib/data/types';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS } from '../../lib/yield';
import { prisma } from '../db';
import { fullRangeAmounts, fullRangeReturn, priceOf0In1 } from '../keeper/vault-math';

const BUCKETS = 14;
const BUCKET_HOURS = YIELD_WINDOW_HOURS / BUCKETS;

export interface VaultLiveRow {
  pool_id: string;
  currency0: string;
  currency1: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  block_num: string;
  block_time: Date;
  sqrt_price_x96: string;
  /** The pool's price at its last swap 24h before the read; null without one. */
  sqrt_24h: string | null;
  vault_liquidity: string;
  /** When the figures may begin: the later of the history's start and the pool's creation. */
  window_from: Date;
  fee0_24h: string;
  fee1_24h: string;
  in0_24h: string;
  in1_24h: string;
  swaps_24h: number;
  g0: string;
  g1: string;
}

export interface BucketRow {
  pool_id: string;
  bucket: number;
  fee0: string;
  fee1: string;
}

const WETH = CONTRACTS.weth.toLowerCase();
const isEth = (c: string) => c === zeroAddress || c === WETH;

/** Raw integer units of a token as a number of whole tokens. */
function whole(raw: string | bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Dollar prices for a pool's two tokens from its own price: USDG is the one
 * dollar anchor (§4.3); ETH is priced by a pool pairing it with USDG, or by
 * `ethUsd` when this pool does not.
 */
export function priceSides(
  row: Pick<VaultLiveRow, 'currency0' | 'currency1' | 'decimals0' | 'decimals1' | 'sqrt_price_x96'>,
  usdg: string | null,
  ethUsd: number | null,
): [number | null, number | null] {
  const p = priceOf0In1(BigInt(row.sqrt_price_x96), row.decimals0, row.decimals1);
  if (!(p > 0) || !Number.isFinite(p)) return [null, null];
  const c0 = row.currency0.toLowerCase();
  const c1 = row.currency1.toLowerCase();
  const u = usdg?.toLowerCase() ?? null;
  if (u && c1 === u) return [p, 1];
  if (u && c0 === u) return [1, 1 / p];
  if (ethUsd !== null && ethUsd > 0 && isEth(c0)) return [ethUsd, ethUsd / p];
  if (ethUsd !== null && ethUsd > 0 && isEth(c1)) return [p * ethUsd, ethUsd];
  return [null, null];
}

/** §7's three states for a full-range yield over `hours` of history. */
export function classifyLiveYield(pct: number, hours: number): FeeYield {
  if (hours < MIN_DATA_HOURS) return { basis: 'insufficient', reason: 'young' };
  if (hours < YIELD_WINDOW_HOURS - 0.5) return { basis: 'estimate', pct, windowHours: hours };
  return { basis: 'trailing7d', pct };
}

/** One vault's live figures from its summed rows. Pure. */
export function vaultLiveFrom(
  row: VaultLiveRow,
  buckets: BucketRow[],
  usdg: string | null,
  ethUsd: number | null,
): VaultLive {
  const [price0, price1] = priceSides(row, usdg, ethUsd);
  const priced = price0 !== null && price1 !== null;
  const usd = (raw0: string | bigint, raw1: string | bigint) =>
    priced ? whole(raw0, row.decimals0) * price0 + whole(raw1, row.decimals1) * price1 : 0;

  const asOf = row.block_time.getTime();
  const from = Math.max(row.window_from.getTime(), asOf - YIELD_WINDOW_HOURS * 3_600_000);
  const historyHours = Math.max(0, Math.min(YIELD_WINDOW_HOURS, (asOf - from) / 3_600_000));
  const sqrtPriceX96 = BigInt(row.sqrt_price_x96);
  const ret = fullRangeReturn(BigInt(row.g0), BigInt(row.g1), sqrtPriceX96);
  const pct = historyHours > 0 ? ret * ((365 * 24) / historyHours) * 100 : 0;

  const history = new Array(BUCKETS).fill(0);
  for (const b of buckets) {
    if (b.bucket >= 0 && b.bucket < BUCKETS) history[b.bucket] += usd(b.fee0, b.fee1);
  }

  const [held0, held1] = fullRangeAmounts(BigInt(row.vault_liquidity), sqrtPriceX96, row.decimals0, row.decimals1);
  const currency = (i: 0 | 1): VaultCurrency => ({
    address: (i === 0 ? row.currency0 : row.currency1).toLowerCase(),
    symbol: i === 0 ? row.symbol0 : row.symbol1,
    decimals: i === 0 ? row.decimals0 : row.decimals1,
    priceUsd: i === 0 ? price0 : price1,
  });
  const then = row.sqrt_24h ? Number(BigInt(row.sqrt_24h)) : 0;
  const nowSqrt = Number(sqrtPriceX96);
  // Prices are squares of sqrt prices: the ratio of squares is the move.
  const change24hPct = then > 0 && nowSqrt > 0 ? ((nowSqrt / then) ** 2 - 1) * 100 : null;
  const u = usdg?.toLowerCase();
  const ethUsdg =
    (isEth(row.currency0.toLowerCase()) && row.currency1.toLowerCase() === u) ||
    (isEth(row.currency1.toLowerCase()) && row.currency0.toLowerCase() === u);

  return {
    asOf: row.block_time.toISOString(),
    blockNumber: Number(row.block_num),
    currencies: [currency(0), currency(1)],
    ethPriceUsd: ethUsdg ? (isEth(row.currency0.toLowerCase()) ? price0 : price1) : null,
    change24hPct,
    stakedUsd: priced ? held0 * price0 + held1 * price1 : null,
    fees24hUsd: usd(row.fee0_24h, row.fee1_24h),
    volume24hUsd: usd(row.in0_24h, row.in1_24h),
    trades24h: Number(row.swaps_24h),
    feeHistory: history,
    historyHours,
    fullRangeYield: classifyLiveYield(pct, historyHours),
  };
}

/**
 * Every watched vault's live figures, keyed by pool id. Empty until the
 * watcher has read a vault — the pages then fall back to the pool's row and
 * say it is the pool's average.
 *
 * @param fallbackEthUsd ETH's price for a pool that pairs ETH with neither
 *        USDG nor anything a live pool prices — the indexer's anchor.
 */
export async function queryVaultLive(usdg: string | null, fallbackEthUsd: number | null): Promise<Map<string, VaultLive>> {
  const rows = await prisma.$queryRaw<VaultLiveRow[]>`
    SELECT
      st.pool_id, st.currency0, st.currency1, st.symbol0, st.symbol1, st.decimals0, st.decimals1,
      st.block_num::text AS block_num, st.block_time,
      st.sqrt_price_x96::text AS sqrt_price_x96, st.vault_liquidity::text AS vault_liquidity,
      (SELECT s2.sqrt_price_x96::text FROM vault_swaps s2
        WHERE s2.pool_id = st.pool_id AND s2.block_time <= st.block_time - interval '24 hours'
        ORDER BY s2.block_num DESC, s2.log_index DESC LIMIT 1) AS sqrt_24h,
      GREATEST(st.history_from_time, COALESCE(p.created_at, st.history_from_time)) AS window_from,
      COALESCE(SUM(s.lp_fee) FILTER (WHERE s.fee_token = 0 AND s.block_time > st.block_time - interval '24 hours'), 0)::text AS fee0_24h,
      COALESCE(SUM(s.lp_fee) FILTER (WHERE s.fee_token = 1 AND s.block_time > st.block_time - interval '24 hours'), 0)::text AS fee1_24h,
      COALESCE(SUM(s.amount_in) FILTER (WHERE s.fee_token = 0 AND s.block_time > st.block_time - interval '24 hours'), 0)::text AS in0_24h,
      COALESCE(SUM(s.amount_in) FILTER (WHERE s.fee_token = 1 AND s.block_time > st.block_time - interval '24 hours'), 0)::text AS in1_24h,
      (COUNT(s.block_num) FILTER (WHERE s.block_time > st.block_time - interval '24 hours'))::int AS swaps_24h,
      COALESCE(SUM(s.fee_growth_x128) FILTER (WHERE s.fee_token = 0), 0)::text AS g0,
      COALESCE(SUM(s.fee_growth_x128) FILTER (WHERE s.fee_token = 1), 0)::text AS g1
    FROM vault_pool_state st
    LEFT JOIN pools p ON p.id = st.pool_id
    LEFT JOIN vault_swaps s
      ON s.pool_id = st.pool_id
     AND s.block_time > st.block_time - (${YIELD_WINDOW_HOURS} * interval '1 hour')
     AND s.block_num <= st.block_num
    GROUP BY st.pool_id, p.created_at
  `;
  if (rows.length === 0) return new Map();

  const buckets = await prisma.$queryRaw<BucketRow[]>`
    SELECT s.pool_id,
      (${BUCKETS - 1} - floor(EXTRACT(EPOCH FROM (st.block_time - s.block_time)) / (${BUCKET_HOURS} * 3600)))::int AS bucket,
      COALESCE(SUM(s.lp_fee) FILTER (WHERE s.fee_token = 0), 0)::text AS fee0,
      COALESCE(SUM(s.lp_fee) FILTER (WHERE s.fee_token = 1), 0)::text AS fee1
    FROM vault_swaps s
    JOIN vault_pool_state st ON st.pool_id = s.pool_id
    WHERE s.block_time > st.block_time - (${YIELD_WINDOW_HOURS} * interval '1 hour')
      AND s.block_num <= st.block_num
    GROUP BY s.pool_id, 2
  `;

  // ETH's dollar price from the deepest live pool pairing it with USDG — the
  // same anchor rule the indexer uses (§4.3), applied to live state.
  const u = usdg?.toLowerCase() ?? null;
  const ethPools = rows
    .filter((r) => u && ((isEth(r.currency0) && r.currency1 === u) || (isEth(r.currency1) && r.currency0 === u)))
    // The busiest one: its last trade is the most recent price.
    .sort((a, b) => b.swaps_24h - a.swaps_24h || (a.pool_id < b.pool_id ? -1 : 1));
  let ethUsd: number | null = fallbackEthUsd !== null && fallbackEthUsd > 0 ? fallbackEthUsd : null;
  for (const r of ethPools) {
    const [p0, p1] = priceSides(r, usdg, null);
    const eth = isEth(r.currency0) ? p0 : p1;
    if (eth !== null && eth > 0) {
      ethUsd = eth;
      break;
    }
  }

  const out = new Map<string, VaultLive>();
  for (const row of rows) {
    out.set(
      row.pool_id.toLowerCase(),
      vaultLiveFrom(
        row,
        buckets.filter((b) => b.pool_id === row.pool_id),
        usdg,
        ethUsd,
      ),
    );
  }
  return out;
}
