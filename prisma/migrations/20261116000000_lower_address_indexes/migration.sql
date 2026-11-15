-- Expression indexes for the lower(address) comparisons the indexer and the
-- snapshot make everywhere. Without them every such join scanned the whole
-- table: with a million pools and as many tokens, rebuilding the two vault
-- rows took 2.4 s and resolving the USDG anchor 0.9 s, on every pass, which
-- is most of why the box crossed history at ~1,000 blocks a second. Measured
-- on a million-pool database: 2,400 ms -> 20 ms and 900 ms -> 50 ms; building
-- the three indexes took 1.2 s.
--
-- Not expressible in schema.prisma (Prisma has no expression indexes); they
-- live here, and `prisma migrate deploy` is what the box runs.
CREATE INDEX IF NOT EXISTS "tokens_address_lower_idx" ON "tokens" (lower("address"));
CREATE INDEX IF NOT EXISTS "pools_token0_lower_idx" ON "pools" (lower("token0"));
CREATE INDEX IF NOT EXISTS "pools_token1_lower_idx" ON "pools" (lower("token1"));
