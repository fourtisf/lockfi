'use client';

import { useUi } from '@/components/providers/UiProvider';
import { usePortfolio } from '@/hooks/usePortfolio';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { signedPct, signedUsd, tone, usdExact, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';
import { claimableLabel } from '@/lib/wallet/portfolio';

/** A share card is a preview: nothing renders or posts one yet. */
export function ShareCardButton() {
  const { act } = useUi();
  const { portfolio } = usePortfolio();
  // Nothing to share is not a card worth offering.
  const empty = portfolio.stakes.length === 0 && portfolio.positions.length === 0;
  return (
    <button
      className="btn btn-quiet"
      disabled={empty}
      title={empty ? 'Nothing staked or minted yet' : undefined}
      onClick={() => act('Sharing a PnL card')}
    >
      Share PnL card
    </button>
  );
}

export function PortfolioBody() {
  const { portfolio, source } = usePortfolio();
  const net = portfolio.netChangeUsd;
  const wow = weekOverWeek(portfolio.dailyFeesWeth);
  // A connected wallet is read from the chain: what it holds and can claim
  // now is known; its deposit and payout history is not read yet, so the
  // figures built on that history are unknown rather than zero (§7).
  const fromWallet = source === 'wallet';
  if (fromWallet) return <WalletPortfolio />;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{usdExact(portfolio.netValueUsd)}</div>
          {/* The sign and the colour come from the number itself; zero has neither. */}
          <div className={`d num ${tone(net)}`}>
            {signedUsd(net)} · {signedPct(portfolio.netChangePct)} all time
          </div>
        </div>
        <div className="card stat">
          <div className="k">Fees earned</div>
          <div className="v num">{weth(portfolio.feesEarnedWeth)}</div>
          <div className="d num">{usdExact(portfolio.feesEarnedUsd)}</div>
        </div>
        <div className="card stat">
          {/* Impermanent loss, under the name that tells the truth (§7). */}
          <div className="k">Price impact on holdings</div>
          <div className={`v num ${tone(-Math.abs(portfolio.priceImpactUsd))}`}>
            {signedUsd(-Math.abs(portfolio.priceImpactUsd))}
          </div>
          <div className="d">vs holding the tokens</div>
        </div>
        <div className="card stat">
          <div className="k">Fees · last 7d</div>
          <div className={`v num ${tone(portfolio.fees7dUsd)}`}>{usdExact(portfolio.fees7dUsd)}</div>
          {wow.isBest ? (
            <div className="d up">Best week so far</div>
          ) : wow.changePct !== null ? (
            <div className={`d num ${tone(wow.changePct, 1)}`}>
              {signedPct(wow.changePct)} vs the week before
            </div>
          ) : (
            <div className="d">{weth(wow.lastWeek)} this week</div>
          )}
        </div>
      </div>

      <div className="grid g2">
        <div className="card panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <h2 className="sect-h">Daily fees · 8 weeks</h2>
            <span className="muted" style={{ fontSize: 12.5 }}>
              darker = more WETH
            </span>
          </div>
          <FeeHeatmap values={portfolio.dailyFeesWeth} />
        </div>
        <PositionList />
      </div>
    </>
  );
}

/**
 * The portfolio of a connected wallet, read from the chain in this browser.
 * Net value and claimable WETH are what the vaults say now. Net change, price
 * impact and the fee history need the wallet's deposits and payouts, which
 * nothing reads yet: each is shown as unknown, with the reason, never as $0.
 */
function WalletPortfolio() {
  const { portfolio, stakes } = usePortfolio();
  const known = (n: number) => Number.isFinite(n);

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{known(portfolio.netValueUsd) ? usdExact(portfolio.netValueUsd) : '—'}</div>
          <div className="d">
            {known(portfolio.netValueUsd) ? 'staked plus claimable, at current prices' : 'a pool is not priced yet'}
          </div>
        </div>
        <div className="card stat">
          <div className="k">Claimable fees</div>
          {/* Paid in both of each pool's tokens; the total is their dollar value. */}
          <div className="v num">{known(portfolio.feesEarnedUsd) ? usdExact(portfolio.feesEarnedUsd, 2) : '—'}</div>
          <div className="d num">
            {stakes.length === 1 ? claimableLabel(stakes[0]) : `in both tokens of ${stakes.length} pools`}
          </div>
        </div>
        <div className="card stat">
          {/* Impermanent loss, under the name that tells the truth (§7). */}
          <div className="k">Price impact on holdings</div>
          <div className="v num muted">—</div>
          <div className="d">needs your deposit history, not read yet</div>
        </div>
        <div className="card stat">
          <div className="k">Fees · last 7d</div>
          <div className="v num muted">—</div>
          <div className="d">payout history is not read yet</div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <h2 className="sect-h">Daily fees · 8 weeks</h2>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Your daily payouts appear here once the indexer reads vault payouts for your wallet.
            Until then there is no history to draw, so nothing is drawn.
          </p>
        </div>
        <PositionList />
      </div>
    </>
  );
}
