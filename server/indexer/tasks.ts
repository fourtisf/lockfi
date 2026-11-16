/**
 * One-off work a migration leaves for the indexer, in `indexer_tasks` (§31).
 *
 * A correction to stored rows cannot always be a migration: deploy.sh runs
 * `prisma migrate deploy` while the OLD indexer is still running and reloads
 * it afterwards, so rows the old code writes during and after the migration
 * would escape the correction. A startup task runs in the new process before
 * its first pass, when every row it corrects was written by the old code.
 */

import { prisma } from '../db';

/**
 * v4's Swap event carries the swapper's signs; swap_events holds the pool's
 * (positive = entered the pool, as v3 emits it). Flip the v4 rows written
 * before the fix, and recompute the fee side and the LPs' fee on the amount
 * that entered:
 *   static-fee pools: the key's fee (the LPs' part; Uniswap's protocol fee is
 *   on top of it and is not the LPs');
 *   dynamic-fee pools (fee_tier carries 0x800000): what was charged is not
 *   stored, so the old fee is moved from the output side to the input side in
 *   proportion, which is what the charge was, applied to the input.
 * Every SET expression reads the row as it was before this UPDATE. Not
 * idempotent: it must run exactly once, which the task row guarantees.
 */
export const FIX_V4_SWAP_SIGNS_SQL = `
UPDATE swap_events s
SET amount0 = -s.amount0,
    amount1 = -s.amount1,
    fee_token = CASE
      WHEN s.amount0 < 0 AND s.amount1 >= 0 THEN 0
      WHEN s.amount1 < 0 AND s.amount0 >= 0 THEN 1
      ELSE -1
    END,
    fee_amount = CASE
      WHEN s.amount0 < 0 AND s.amount1 >= 0 THEN
        CASE
          WHEN p.fee_tier > 0 AND p.fee_tier < 1000000 THEN floor((-s.amount0) * p.fee_tier / 1000000.0)
          WHEN s.amount1 > 0 THEN round(s.fee_amount * (-s.amount0) / s.amount1)
          ELSE 0
        END
      WHEN s.amount1 < 0 AND s.amount0 >= 0 THEN
        CASE
          WHEN p.fee_tier > 0 AND p.fee_tier < 1000000 THEN floor((-s.amount1) * p.fee_tier / 1000000.0)
          WHEN s.amount0 > 0 THEN round(s.fee_amount * (-s.amount1) / s.amount0)
          ELSE 0
        END
      ELSE 0
    END
FROM pools p
WHERE p.id = s.pool_id
  AND p.protocol = 'v4'`;

/**
 * Run the startup tasks that are pending. Returns what was done, for the log.
 * Each correction runs in one transaction with the deletion of its task row,
 * so a crash leaves it either undone and pending, or done and gone — never
 * done twice. A correction that changes rows the fee hours sum leaves
 * `rebuild-fee-hours` behind, which the first global pass runs.
 */
export async function runStartupTasks(log: (msg: string) => void = () => {}): Promise<string[]> {
  const pending = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM indexer_tasks WHERE name = 'fix-v4-swap-signs'`,
  );
  if (pending.length === 0) return [];
  log('  correcting stored v4 swaps to the pool\'s signs and fee, once (this can take a few minutes)…');
  const t = Date.now();
  const guard = `EXISTS (SELECT 1 FROM indexer_tasks WHERE name = 'fix-v4-swap-signs')`;
  const [flipped] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`${FIX_V4_SWAP_SIGNS_SQL} AND ${guard}`),
    prisma.$executeRawUnsafe(
      `INSERT INTO indexer_tasks (name) SELECT 'rebuild-fee-hours' WHERE ${guard} ON CONFLICT (name) DO NOTHING`,
    ),
    prisma.$executeRawUnsafe(`DELETE FROM indexer_tasks WHERE name = 'fix-v4-swap-signs'`),
  ]);
  return [`v4 swaps corrected to the pool's signs and fee: ${flipped} rows (${((Date.now() - t) / 1000).toFixed(1)}s)`];
}
