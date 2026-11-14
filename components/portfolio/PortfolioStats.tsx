'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { signedPct, signedUsd, tone, usdExact, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';

/** A share card needs a wallet to describe, which arrives with P2. */
export function ShareCardButton() {
  const { act } = useUi();
  const { portfolio } = useMarket();
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
  const { portfolio } = useMarket();
  const net = portfolio.netChangeUsd;
  const wow = weekOverWeek(portfolio.dailyFeesWeth);

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
