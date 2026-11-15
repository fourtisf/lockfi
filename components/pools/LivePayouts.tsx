'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { tone, usdExact } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { pairLabel } from '@/lib/pair';

/** Real harvest payouts, newest first. Fees only — there are no emissions. */
export function LivePayouts() {
  const { payouts, payoutTotalUsd, pools } = useMarket();

  return (
    <div className="card live">
      <div className="live-h">
        <h2 className="sect-h">
          <i className="dot" aria-hidden="true" />
          Fees paid out just now
        </h2>
        <span className={`num ${tone(payoutTotalUsd)}`}>{usdExact(payoutTotalUsd)}</span>
      </div>
      {payouts.length === 0 && (
        // Payouts come from vault harvests. With no vault there are none, and
        // an empty panel under a green "$0" read as a feed that had stalled.
        <div className="empty">
          <b>No payouts yet</b>
          Payouts start when {BRAND}&rsquo;s vaults begin harvesting fees.
        </div>
      )}
      <div aria-live="off">
        {payouts.map((p) => {
          const pool = pools.find((x) => x.id === p.poolId);
          if (!pool) return null;
          return (
            <div className="lv" key={p.id}>
              <TokenBadge token={pool.token} />
              <span>{pairLabel(pool)}</span>
              <span className="a num">+{p.weth.toFixed(3)} WETH</span>
              <span className="w num">{p.wallet}…</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
