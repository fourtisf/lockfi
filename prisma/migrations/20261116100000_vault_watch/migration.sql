-- The vault watcher (server/keeper/vault-watch.ts): each deployed vault's
-- pool, read live from the chain, independent of the pool indexer's cursor.
--
-- The pool indexer is crossing months of history and the site's boards are
-- as of the last swap it read. A vault is where money goes in, so its figures
-- cannot wait for that: its pool's swaps for the trailing eight days and its
-- current state are read straight from the chain every minute.

-- Every swap in a vault's pool over the trailing window, as emitted. Kept for
-- eight days and pruned after; keyed by log coordinates, so a re-read of the
-- same blocks changes nothing.
CREATE TABLE "vault_swaps" (
    "pool_id" TEXT NOT NULL,
    "block_num" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "block_time" TIMESTAMP(3) NOT NULL,
    "amount0" DECIMAL(78,0) NOT NULL,
    "amount1" DECIMAL(78,0) NOT NULL,
    "sqrt_price_x96" DECIMAL(78,0) NOT NULL,
    "liquidity" DECIMAL(78,0) NOT NULL,
    "tick" INTEGER NOT NULL,
    "swap_fee_pips" INTEGER NOT NULL,
    "lp_fee" DECIMAL(78,0) NOT NULL,
    "fee_token" SMALLINT NOT NULL,
    "amount_in" DECIMAL(78,0) NOT NULL,
    "fee_growth_x128" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "vault_swaps_pkey" PRIMARY KEY ("pool_id", "block_num", "log_index")
);
CREATE INDEX "vault_swaps_pool_id_block_time_idx" ON "vault_swaps"("pool_id", "block_time");

-- One row per vault: its pool's state at the last block read, and how far
-- the swap history reaches.
CREATE TABLE "vault_pool_state" (
    "pool_id" TEXT NOT NULL,
    "vault_address" TEXT NOT NULL,
    "currency0" TEXT NOT NULL,
    "currency1" TEXT NOT NULL,
    "symbol0" TEXT NOT NULL,
    "symbol1" TEXT NOT NULL,
    "decimals0" INTEGER NOT NULL,
    "decimals1" INTEGER NOT NULL,
    "lp_fee_pips" INTEGER NOT NULL,
    "block_num" BIGINT NOT NULL,
    "block_time" TIMESTAMP(3) NOT NULL,
    "sqrt_price_x96" DECIMAL(78,0) NOT NULL,
    "tick" INTEGER NOT NULL,
    "liquidity" DECIMAL(78,0) NOT NULL,
    "vault_liquidity" DECIMAL(78,0) NOT NULL,
    "fee_growth0_x128" DECIMAL(78,0) NOT NULL,
    "fee_growth1_x128" DECIMAL(78,0) NOT NULL,
    "history_from_block" BIGINT NOT NULL,
    "history_from_time" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_pool_state_pkey" PRIMARY KEY ("pool_id")
);
