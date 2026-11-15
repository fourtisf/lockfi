-- CreateTable
CREATE TABLE "token_logos" (
    "address" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "origin" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_logos_pkey" PRIMARY KEY ("address")
);

-- AddForeignKey
ALTER TABLE "token_logos" ADD CONSTRAINT "token_logos_address_fkey" FOREIGN KEY ("address") REFERENCES "tokens"("address") ON DELETE CASCADE ON UPDATE CASCADE;


-- A new logo source (the launchpad's own on-chain logo) arrives with this
-- table. Tokens an earlier sweep found no logo for are due again now rather
-- than a day from their last look; impostors stay excluded.
UPDATE "tokens"
SET "logo_retry_at" = NULL
WHERE "logo_url" IS NULL
  AND "logo_source" IS DISTINCT FROM 'impostor';
