'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useWalletHistory } from '@/hooks/useWalletHistory';
import { Activity } from '@/components/portfolio/Activity';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { WalletPositions } from '@/components/portfolio/WalletPositions';
import { useWalletPositions } from '@/hooks/useWalletPositions';
import { MyStakes } from '@/components/stakes/MyStakes';
import { FEE_DIGITS, signedPct, signedUsd, tone, usdExact, usdFee, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';
import { claimableLabel, walletTotals } from '@/lib/wallet/portfolio';

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
  // The live site with no wallet: there is no portfolio to show, and zeros
  // would claim one that earned nothing.
  if (source === 'snapshot') return <NoWallet />;

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

      <MyStakes />

      <div className="grid g2" style={{ marginTop: 20 }}>
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
 *
 * What it holds and can claim is read from each vault every 15 seconds; what
 * it deposited, withdrew and claimed comes from the vaults' own events
 * (/api/wallet/:address). Everything is valued at today's prices from the
 * vaults' live pool reads. A figure that needs something not yet known is
 * an em dash with the reason, never $0 (§7).
 */
function WalletPortfolio() {
  const { portfolio, stakes } = usePortfolio();
  const { vaults } = useMarket();
  const { history, failed } = useWalletHistory();
  const known = (n: number) => Number.isFinite(n);
  const currencies = new Map(vaults.filter((v) => v.live).map((v) => [v.poolId.toLowerCase(), v.live!.currencies]));
  const totals = history ? walletTotals(history.vaults, stakes, currencies) : null;
  const waiting = history === null ? (failed ? 'history could not be read — retrying' : 'reading your history…') : 'a pool is not priced yet';
  // Minted positions count toward what the wallet holds here, at today's
  // prices; a position nobody can price makes the total unknown, not smaller.
  const { positions } = useWalletPositions();
  const positionsUsd = positions.reduce((a, p) => a + (p.valueUsd ?? Number.NaN) + (p.feesUsd ?? Number.NaN), 0);
  const netValueUsd = portfolio.netValueUsd + positionsUsd;
  // What was deposited is known for stakes only (their vaults' events), so
  // "vs deposited" is said only when stakes are all there is.
  const stakesOnly = positions.length === 0;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{known(netValueUsd) ? usdExact(netValueUsd) : '—'}</div>
          {stakesOnly && totals && known(totals.netChangeUsd) && totals.depositedUsd > 0 ? (
            // The sign and the colour come from the number itself; zero has neither.
            <div className={`d num ${tone(totals.netChangeUsd)}`}>
              {signedUsd(totals.netChangeUsd)} · {signedPct(totals.netChangePct)} vs deposited
            </div>
          ) : (
            <div className="d">
              {!known(netValueUsd)
                ? 'a pool is not priced yet'
                : stakesOnly
                  ? 'staked plus claimable, at current prices'
                  : 'stakes, positions and their fees, at current prices'}
            </div>
          )}
        </div>
        <div className="card stat">
          <div className="k">Fees earned</div>
          <div className={`v num ${totals && known(totals.feesEarnedUsd) ? tone(totals.feesEarnedUsd, FEE_DIGITS) : 'muted'}`}>
            {totals && known(totals.feesEarnedUsd) ? usdFee(totals.feesEarnedUsd) : '—'}
          </div>
          <div className="d">
            {totals && known(totals.feesEarnedUsd)
              ? stakesOnly
                ? 'claimed plus claimable, all time'
                : 'from stakes; positions’ fees are listed with them below'
              : waiting}
          </div>
        </div>
        <div className="card stat">
          {/* Impermanent loss, under the name that tells the truth (§7). */}
          <div className="k">Price impact on holdings</div>
          <div className={`v num ${totals && known(totals.priceImpactUsd) ? tone(totals.priceImpactUsd, 2) : 'muted'}`}>
            {totals && known(totals.priceImpactUsd) ? signedUsd(totals.priceImpactUsd) : '—'}
          </div>
          <div className="d">
            {totals && known(totals.priceImpactUsd)
              ? stakesOnly
                ? 'vs holding the tokens you deposited'
                : 'of stakes, vs holding the tokens deposited'
              : waiting}
          </div>
        </div>
        <div className="card stat">
          <div className="k">Claimable now</div>
          {/* Paid in both of each pool's tokens; the total is their dollar value. */}
          <div className="v num">{known(portfolio.feesEarnedUsd) ? usdFee(portfolio.feesEarnedUsd) : '—'}</div>
          <div className="d num">
            {stakes.length === 0 ? 'nothing staked yet' : stakes.length === 1 ? claimableLabel(stakes[0]) : `in both tokens of ${stakes.length} pools`}
          </div>
        </div>
      </div>

      {/* Every stake with what it holds and can claim, refreshed from the
          chain, and Withdraw / Claim / Compound right here. */}
      <MyStakes />

      {/* Positions minted with the shape builder, read from the chain, with
          Collect fees and Remove right here. */}
      <WalletPositions />

      <div style={{ marginTop: 20 }}>
        <Activity />
      </div>
    </>
  );
}

/** The live portfolio before a wallet is connected. */
function NoWallet() {
  return (
    <>
      <div className="card empty" style={{ marginBottom: 20 }}>
        <b>Connect a wallet to see your portfolio</b>
        Your stakes, what each is worth now, the fees they earned and what you can claim are read from the
        chain for the wallet you connect. You can withdraw any time from here.
      </div>
      <MyStakes />
    </>
  );
}
