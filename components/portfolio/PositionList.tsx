'use client';

import { useRouter } from 'next/navigation';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { countdown, usdExact } from '@/lib/format';
import { SHAPES } from '@/lib/shapes';

export function PositionList() {
  const { portfolio, pools } = useMarket();
  const { query } = useUi();
  const router = useRouter();

  const q = query.trim().toLowerCase();
  const matches = (poolId: string) => {
    if (q === '') return true;
    const pool = pools.find((p) => p.id === poolId);
    if (!pool) return false;
    return (
      pool.token.symbol.toLowerCase().includes(q) || pool.token.name.toLowerCase().includes(q)
    );
  };
  const positions = portfolio.positions.filter((p) => matches(p.poolId));
  const stakes = portfolio.stakes.filter((s) => matches(s.poolId));
  const stranded = portfolio.positions.find((p) => !p.inRange);
  const strandedPool = pools.find((p) => p.id === stranded?.poolId);

  return (
    <div className="card panel">
      <h2 className="sect-h" style={{ marginBottom: 4 }}>
        Positions and stakes
      </h2>

      {positions.map((position) => {
        const pool = pools.find((p) => p.id === position.poolId);
        if (!pool) return null;
        const shape = SHAPES.find((s) => s.id === position.shape)!;
        return (
          <div className="pnl-row" key={position.tokenId}>
            <div className="tok">
              <TokenBadge token={pool.token} />
              <div>
                <div className="n">{pool.token.symbol} / WETH</div>
                <div className="s">
                  {shape.label} · ±{position.rangePct}% ·{' '}
                  {position.inRange ? (
                    'in range'
                  ) : (
                    // §7: out of range earns nothing. Say exactly that, in red.
                    <span className="down">out of range — earning nothing</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontWeight: 600 }}>
                {usdExact(position.valueUsd)}
              </div>
              <div className="up num" style={{ fontSize: 12 }}>
                +{position.feesWeth.toFixed(2)} WETH fees
              </div>
            </div>
          </div>
        );
      })}

      {stakes.map((stake) => {
        const pool = pools.find((p) => p.id === stake.poolId);
        if (!pool) return null;
        return (
          <div className="pnl-row" key={stake.vaultId}>
            <div className="tok">
              <TokenBadge token={pool.token} />
              <div>
                <div className="n">{pool.token.symbol} stake</div>
                <div className="s">
                  Streaming · {countdown(stake.streamRemainingSeconds)}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontWeight: 600 }}>
                {usdExact(stake.stakedUsd)}
              </div>
              <div className="up num" style={{ fontSize: 12 }}>
                +{stake.earnedWeth.toFixed(2)} WETH fees
              </div>
            </div>
          </div>
        );
      })}

      {positions.length === 0 && stakes.length === 0 && (
        <div className="empty">
          <b>No match</b>Nothing in your portfolio matches that search.
        </div>
      )}

      {stranded && strandedPool && matches(stranded.poolId) && (
        <div className="alert">
          {strandedPool.token.symbol} left its range {stranded.outOfRangeSinceHours}h ago and has
          earned nothing since.{' '}
          <button className="link" onClick={() => router.push('/positions')}>
            Rebalance
          </button>{' '}
          to start earning again.
        </div>
      )}
    </div>
  );
}
