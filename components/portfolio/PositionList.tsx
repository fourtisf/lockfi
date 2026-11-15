'use client';

import { useRouter } from 'next/navigation';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useWallet } from '@/hooks/useWallet';
import { countdown, shortWallet, signOf, tone, usdExact } from '@/lib/format';
import { SHAPES } from '@/lib/shapes';
import { BRAND } from '@/lib/site';
import { claimableLabel, hasClaimable } from '@/lib/wallet/portfolio';
import { pairLabel } from '@/lib/pair';

export function PositionList() {
  const { pools } = useMarket();
  const { portfolio, source, stakes: walletStakes } = usePortfolio();
  const { status } = useWallet();
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
                <div className="n">{pairLabel(pool)}</div>
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
              <div className={`num ${tone(position.feesWeth, 2)}`} style={{ fontSize: 12 }}>
                {signOf(position.feesWeth, 2) > 0 ? '+' : ''}
                {position.feesWeth.toFixed(2)} WETH fees
              </div>
            </div>
          </div>
        );
      })}

      {stakes.map((stake) => {
        const pool = pools.find((p) => p.id === stake.poolId);
        const live = walletStakes.find((s) => s.vaultId === stake.vaultId);
        if (!pool && !live) return null;
        const digits = 2;
        return (
          <div className="pnl-row" key={stake.vaultId}>
            <div className="tok">
              {pool && <TokenBadge token={pool.token} />}
              <div>
                <div className="n">{pool ? pool.token.symbol : `Vault ${shortWallet(live!.vault)}`} stake</div>
                <div className="s">
                  {live
                    ? 'Fees credited the moment they’re earned'
                    : <>Streaming · {countdown(stake.streamRemainingSeconds)}</>}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontWeight: 600 }}>
                {Number.isFinite(stake.stakedUsd) ? usdExact(stake.stakedUsd) : '—'}
              </div>
              {live ? (
                // Two tokens, as the vault pays them.
                <div className={`num ${hasClaimable(live) ? 'up' : ''}`} style={{ fontSize: 12 }}>
                  {claimableLabel(live)} claimable
                </div>
              ) : (
                <div className={`num ${tone(stake.earnedWeth, digits)}`} style={{ fontSize: 12 }}>
                  {signOf(stake.earnedWeth, digits) > 0 ? '+' : ''}
                  {stake.earnedWeth.toFixed(digits)} WETH fees
                </div>
              )}
            </div>
          </div>
        );
      })}

      {portfolio.positions.length === 0 && portfolio.stakes.length === 0 ? (
        // An empty portfolio, not a search that hid it. The live site has no
        // wallet and no vault until P2, so this is what is true there.
        <div className="empty">
          <b>Nothing here yet</b>
          {source === 'wallet'
            ? `This wallet has no stake in a ${BRAND} vault. Positions minted with the shape builder are Uniswap v4 NFTs in your wallet; listing them here comes with the indexer.`
            : status === 'disconnected' || status === 'connecting'
              ? 'Connect a wallet to see its stakes and positions.'
              : 'Stakes and positions appear here once they can be read for this wallet.'}
        </div>
      ) : (
        positions.length === 0 &&
        stakes.length === 0 && (
          <div className="empty">
            <b>No match</b>Nothing in your portfolio matches that search.
          </div>
        )
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
