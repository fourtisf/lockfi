'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { usdExact } from '@/lib/format';

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
        <span className="num">{usdExact(payoutTotalUsd)}</span>
      </div>
      <div aria-live="off">
        {payouts.map((p) => {
          const pool = pools.find((x) => x.id === p.poolId);
          if (!pool) return null;
          return (
            <div className="lv" key={p.id}>
              <TokenBadge token={pool.token} />
              <span>{pool.token.symbol} / WETH</span>
              <span className="a num">+{p.weth.toFixed(3)} WETH</span>
              <span className="w num">{p.wallet}…</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
