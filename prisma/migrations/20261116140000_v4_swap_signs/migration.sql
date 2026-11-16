-- v4's Swap event carries the SWAPPER's signs (negative = paid into the pool),
-- the opposite of the pool perspective swap_events documents and every reader
-- assumes. Rows ingested before the fix kept the swapper's signs: their fee was
-- taken on the token that LEFT the pool, at the whole charge including
-- Uniswap's protocol fee, and their volume was counted on the output side.
--
-- The correction is NOT made here. deploy.sh migrates while the old indexer is
-- still running and reloads it afterwards, so rows the old code writes during
-- and after this migration would keep the wrong signs. The indexer makes the
-- correction itself (server/indexer/tasks.ts), once, at startup and before
-- its first pass, when every v4 row in the table was written by the old code.
-- This leaves the task for it.
CREATE TABLE IF NOT EXISTS indexer_tasks (
  name       TEXT PRIMARY KEY,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO indexer_tasks (name) VALUES ('fix-v4-swap-signs') ON CONFLICT (name) DO NOTHING;
