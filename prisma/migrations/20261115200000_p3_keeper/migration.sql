-- P3: the keeper, and the server side of P2.
--
-- contract_events holds the raw logs of Tidewell's own contracts (vaults, the
-- router factory, routers), keyed by log coordinates like swap_events, so the
-- 32-block re-scan (§4.1) changes nothing. `vaults` and `stakes` are rebuilt
-- from it every pass, never incremented (§14).
--
-- The vault credits fees per share the moment it collects them and pays them
-- in the pool's own two tokens, so it has no reward stream, no harvest and no
-- keeper: reward_rate and period_finish go, and the vault and stake rows carry
-- fees collected, the protocol's cut and claims, per token, instead.
--
-- keeper_runs records the keeper's attempts on routers — routes, and pokes
-- that failed or were refused — with why, so a keeper that is up but not
-- routing shows in /api/health instead of only in a log (§8, P3).

-- Both tables are rebuilt from contract_events on every indexer pass, and
-- nothing is deployed yet, so emptying them loses nothing — and it means the
-- NOT NULL columns below cannot fail on a table that somehow has rows.
DELETE FROM "stakes";
DELETE FROM "vaults";

-- AlterTable
ALTER TABLE "vaults" DROP COLUMN "period_finish",
DROP COLUMN "reward_rate",
ADD COLUMN     "claimed0" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "claimed1" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "deposits_open" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fees_collected0" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "fees_collected1" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "last_collected_at" TIMESTAMP(3),
ADD COLUMN     "protocol_cut0" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "protocol_cut1" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "protocol_paid0" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "protocol_paid1" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "staked_since" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stakes" DROP COLUMN "claimed_weth",
ADD COLUMN     "claimed0" DECIMAL(78,0) NOT NULL,
ADD COLUMN     "claimed1" DECIMAL(78,0) NOT NULL;

-- CreateTable
CREATE TABLE "contract_events" (
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "block_num" BIGINT NOT NULL,
    "block_time" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "account" TEXT,
    "args" JSONB NOT NULL,

    CONSTRAINT "contract_events_pkey" PRIMARY KEY ("tx_hash","log_index")
);

-- CreateTable
CREATE TABLE "keeper_runs" (
    "id" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "tx_hash" TEXT,
    "signer" TEXT,
    "reason" TEXT,
    "details" JSONB,

    CONSTRAINT "keeper_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_events_contract_kind_block_num_idx" ON "contract_events"("contract", "kind", "block_num");

-- CreateIndex
CREATE INDEX "keeper_runs_contract_started_at_idx" ON "keeper_runs"("contract", "started_at");
