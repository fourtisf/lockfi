'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { signedPct, usdExact, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';

/** A share card needs a wallet to describe, which arrives with P2. */
export function ShareCardButton() {
  const { act } = useUi();
  return (
    <button className="btn btn-quiet" onClick={() => act('Sharing a PnL card')}>
      Share PnL card
    </button>
  );
}

/** "+$1,204" / "−$812": the sign and the colour come from the number itself. */
function signedUsd(n: number): string {
  return `${n >= 0 ? '+' : '−'}${usdExact(Math.abs(n))}`;
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
          <div className={`d num ${net >= 0 ? 'up' : 'down'}`}>
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
          <div className="v num down">−{usdExact(Math.abs(portfolio.priceImpactUsd))}</div>
          <div className="d">vs holding the tokens</div>
        </div>
        <div className="card stat">
          <div className="k">Fees · last 7d</div>
          <div className="v num up">{usdExact(portfolio.fees7dUsd)}</div>
          {wow.isBest ? (
            <div className="d up">Best week so far</div>
          ) : wow.changePct !== null ? (
            <div className={`d num ${wow.changePct >= 0 ? 'up' : 'down'}`}>
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
