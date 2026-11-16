-- swap_events by time alone: the fee-hour and anchor rebuilds select the rows
-- of the hours a pass touched, and with no index whose leading column is
-- block_time that was a scan of every swap ever read, on every pass. The swap
-- window adds millions of rows, so the scan grew with each pass.
CREATE INDEX IF NOT EXISTS "swap_events_block_time_idx" ON "swap_events"("block_time");
