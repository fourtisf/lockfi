/**
 * Test-database helpers.
 *
 * `resetDatabase` truncates rather than dropping, so the schema survives and
 * each test starts from the same empty state — which is what "on a fresh
 * database" in §9 means.
 */

import { prisma } from '../db';

const TABLES = [
  'keeper_runs',
  'contract_events',
  'router_routes',
  'router_configs',
  'positions',
  'stakes',
  'vaults',
  'pool_fee_hourly',
  'pool_flow_hourly',
  'weth_usd_hourly',
  'pool_state',
  'swap_events',
  'liquidity_events',
  'indexer_cursors',
  'pools',
  'token_logos',
  'tokens',
];

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export async function isReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Every `pool_fee_hourly` row, as text, ordered.
 *
 * Text, not numbers: §9 says byte-identical, and comparing Postgres `numeric`
 * through a JavaScript float would hide exactly the drift the criterion is
 * there to catch.
 */
export interface FeeHourRow {
  pool_id: string;
  hour: string;
  fees_token0: string;
  fees_token1: string;
  fees_usd: string;
  volume_usd: string;
  swaps: number;
}

export async function dumpFeeHours(): Promise<FeeHourRow[]> {
  return prisma.$queryRaw<FeeHourRow[]>`
    SELECT pool_id,
           to_char(hour, 'YYYY-MM-DD HH24:MI:SS') AS hour,
           fees_token0::text,
           fees_token1::text,
           fees_usd::text,
           volume_usd::text,
           swaps
    FROM pool_fee_hourly
    ORDER BY pool_id, hour
  `;
}

export interface PoolStateRow {
  pool_id: string;
  tvl_usd: string;
  price_usd: string;
  sqrt_price_x96: string;
  tick: number;
  liquidity: string;
}

export async function dumpPoolState(): Promise<PoolStateRow[]> {
  return prisma.$queryRaw<PoolStateRow[]>`
    SELECT pool_id, tvl_usd::text, price_usd::text, sqrt_price_x96::text, tick, liquidity::text
    FROM pool_state
    ORDER BY pool_id
  `;
}
