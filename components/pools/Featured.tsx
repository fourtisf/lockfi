'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { AreaChart, Spark } from '@/components/ui/Sparkline';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { count, usd, usdExact } from '@/lib/format';
import { yieldPct } from '@/lib/yield';

/** The history is 14 buckets of 12 hours: the trailing week. */
const BUCKET_HOURS = 12;

/**
 * The protocol at a glance: the headline is fees paid to LPs, because fee
 * yield — not volume — is what §1 makes the headline metric.
 */
export function Featured() {
  const { featured, pools } = useMarket();
  const n = featured.history.length;

  return (
    <div className="card feat">
      <div className="fh">
        <div>
          <div className="k">Fees paid to LPs · 24h</div>
          <div className="big num">{usdExact(featured.fees24hUsd)}</div>
          <div className="fsub">
            across {pools.length} pools · paid in WETH, never in emissions
          </div>
        </div>
        <div className="fg">
          <div>
            <div className="k">Liquidity</div>
            <div className="v num">{usd(featured.liquidityUsd)}</div>
          </div>
          <div>
            <div className="k">Volume 24h</div>
            <div className="v num">{usd(featured.volume24hUsd)}</div>
          </div>
          <div>
            <div className="k">Stakers</div>
            <div className="v num">{count(featured.stakers)}</div>
          </div>
        </div>
      </div>
      <AreaChart
        values={featured.history}
        caption="Fees paid per 12 hours, last 7 days"
        axis={['7 days ago', '5d', '3d', '1d', 'now']}
        formatValue={(v) => `${usd(v)} / 12h`}
        pointLabel={(i) => {
          const ago = (n - 1 - i) * BUCKET_HOURS;
          return ago === 0 ? 'latest' : `${ago}h ago`;
        }}
      />
    </div>
  );
}

/** Most traded and highest fee yield — both open the stake drawer. */
export function MiniCards() {
  const { pools } = useMarket();
  const { openStake } = useUi();

  // No pools is a real state, not an error: an indexer still reading the
  // blocks before the PoolManager existed has found none yet. reduce() with no
  // seed threw on it and took the whole page down.
  const mostTraded = pools.length
    ? pools.reduce((a, b) => (b.volume24hUsd > a.volume24hUsd ? b : a))
    : null;
  const ranked = pools.filter((p) => p.feeYield.basis === 'trailing7d');
  const bestYield = ranked.length
    ? ranked.reduce((a, b) => (yieldPct(b.feeYield) > yieldPct(a.feeYield) ? b : a))
    : null;

  if (!mostTraded) {
    return (
      <div className="mini-cards">
        <div className="card mc" style={{ cursor: 'default' }}>
          <div className="lab">No pools indexed yet</div>
          <p className="hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
            The indexer is still reading the chain. Pools appear here as it finds them, with their
            real fees.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mini-cards">
      <button className="card mc" onClick={() => openStake(mostTraded.id)}>
        <div className="lab">Most traded · 24h</div>
        <TokenBadge token={mostTraded.token} className="logo l" />
        <div>
          <div className="n">{mostTraded.token.symbol}</div>
          <div className="sub">
            <b>{count(mostTraded.trades24h)}</b> trades
          </div>
        </div>
        <Spark values={mostTraded.feeHistory} w={84} h={30} />
      </button>

      {bestYield && (
        <button className="card mc" onClick={() => openStake(bestYield.id)}>
          <div className="lab">Highest fee yield · trailing 7d</div>
          <TokenBadge token={bestYield.token} className="logo l" />
          <div>
            <div className="n">{bestYield.token.symbol}</div>
            <div className="sub">
              <b className="up">{yieldPct(bestYield.feeYield).toFixed(0)}%</b> ·{' '}
              {usd(bestYield.fees24hUsd)} fees 24h
            </div>
          </div>
          <Spark values={bestYield.feeHistory} w={84} h={30} />
        </button>
      )}
    </div>
  );
}
