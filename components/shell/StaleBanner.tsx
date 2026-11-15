'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { DATA_SOURCE } from '@/lib/data';
import { lagLabel } from '@/lib/format';

/** Past this the figures are not "a little behind": they describe another day. */
export const STALE_BANNER_SECONDS = 6 * 3600;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "8 Jul 2026", in UTC, by hand: the server and the browser must print the same string. */
export function asOfDate(lagSeconds: number, now = Date.now()): string {
  const d = new Date(now - lagSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * §7: never render stale numbers as if they were live. The top bar's
 * "Indexer 130d behind" chip said it, and still the owner read CASHCAT's
 * +992% — a day four months old — as today's move. When the data is a day or
 * more behind, the page says so in a sentence, with the date it is from.
 */
export function StaleBanner() {
  const { indexerLagSeconds } = useMarket();
  if (DATA_SOURCE !== 'live' || indexerLagSeconds < STALE_BANNER_SECONDS) return null;
  return (
    <div className="stale" role="status">
      <b>These figures are from {asOfDate(indexerLagSeconds)}, not today.</b> The indexer is still
      catching up with the chain ({lagLabel(Math.round(indexerLagSeconds))} behind), so every price, 24h
      change, volume and yield on the site is from that day. They move to today as it catches up.
    </div>
  );
}
