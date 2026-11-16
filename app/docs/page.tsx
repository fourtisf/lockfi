import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND, DOMAIN, TELEGRAM_LABEL, TELEGRAM_URL, X_HANDLE, X_URL } from '@/lib/site';

export const metadata: Metadata = { title: `Docs — ${BRAND}` };

/**
 * How Tidewell works, on the site (§31): the launch article's text
 * (docs/articles/introducing-tidewell.md), every claim a property of the
 * contracts and the site as built, no yield figure, and the audit status said
 * plainly.
 */
export default function DocsPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Docs</h1>
          <p className="lede">What {BRAND} is, how staking and positions work, and what to know before you deposit.</p>
        </div>
      </div>

      <article className="card pg-card pg-doc">
        <p>
          {BRAND} is a liquidity layer for Robinhood Chain. Liquidity providers deposit into Uniswap v4 pools through {BRAND}{' '}
          and earn a proportional share of the trading fees those pools generate. There are no token emissions and no incentive
          programs: every dollar of yield is a fee that a trader paid.
        </p>

        <h2>Why real fees matter</h2>
        <p>
          Much of the yield in DeFi is funded by issuing new tokens. It looks attractive while the issuance lasts and fades once
          it stops. {BRAND}&rsquo;s returns come only from swap fees, so they follow trading activity: they rise when markets are
          busy and slow when markets are quiet, and every figure on the site can be traced to fees paid on chain.
        </p>

        <h2>Stakes: passive liquidity</h2>
        <p>
          A stake is a deposit into a {BRAND} vault. Each vault serves a single pool and holds its liquidity across the full price
          range, so it earns on every trade and never falls out of range.
        </p>
        <ul>
          <li>
            <b>Flexible deposits.</b> Deposit ETH, the pool&rsquo;s other token, or both, from $10. A single-token deposit is
            balanced within the same transaction; depositing both tokens avoids the swap entirely.
          </li>
          <li>
            <b>Fees as they are earned.</b> Your share of fees is credited as the vault collects them. Claim at any time in the
            pool&rsquo;s own tokens, or compound them back into your stake.
          </li>
          <li>
            <b>No lockup.</b> Withdraw at any time, with no exit fee. Leaving never forfeits fees you have already earned.
          </li>
          <li>
            <b>A fixed protocol fee.</b> {BRAND} retains 10% of the fees a vault collects and never takes from deposits. The fee
            is capped at 20% when each vault is created, and the cap cannot be raised.
          </li>
        </ul>

        <h2>Positions: concentrated liquidity</h2>
        <p>Positions are for liquidity providers who want to decide where their liquidity sits.</p>
        <ul>
          <li>
            <b>Shaped in one transaction.</b> Choose a price range and a shape (spot, curve or bid-ask). {BRAND} splits it across
            up to 60 bins and mints them in a single transaction from one ETH deposit.
          </li>
          <li>
            <b>Held in your wallet.</b> Each bin is a Uniswap v4 position NFT minted directly to you. {BRAND} charges no fee on
            positions.
          </li>
          <li>
            <b>Clear range status.</b> Concentrated liquidity earns more per dollar while the price is inside your range and
            nothing while it is outside. Your portfolio shows which, for every position, and offers a rebalance when one is out
            of range.
          </li>
          <li>
            <b>Full control.</b> Collect fees or withdraw at any time, across every bin in one transaction.
          </li>
        </ul>

        <h2>How the numbers are made</h2>
        <ul>
          <li>Yield is fee yield over the trailing 7 days. It is never presented as APY and never projected forward.</li>
          <li>Pools younger than 7 days are marked as estimates. With less than 24 hours of data, no figure is shown.</li>
          <li>Vaults show what a full-range position actually earned, not the pool average.</li>
          <li>Market capitalisation is shown as fully diluted value (price × total supply) and labelled as such.</li>
          <li>Your portfolio shows price impact on holdings (impermanent loss) next to the fees you have earned.</li>
          <li>If the data falls behind the chain, the top bar says how far.</li>
        </ul>

        <h2>Non-custodial</h2>
        <p>
          Only the wallet that made a deposit can withdraw it. There is no admin withdrawal function, no pause that can lock
          funds, and no upgradeable proxy on the vaults. The owner can close new deposits; withdrawals and claims stay open at
          all times. Every address is on the <Link href="/contracts">Contracts</Link> page.
        </p>

        <h2>Risks</h2>
        <p>
          <b>{BRAND} has not yet been independently audited.</b> Use it at your own risk and only with funds you can afford to
          lose. Providing liquidity also carries market risk: if a token&rsquo;s price falls, the value of your position falls
          with it. Fees offset this risk; they do not remove it.
        </p>

        <h2>Getting started</h2>
        <ol>
          <li>Visit {DOMAIN} and connect your wallet on Robinhood Chain.</li>
          <li>
            To stake, open <Link href="/stakes">Stakes</Link>, choose a vault, select ETH, USDG or both, and confirm.
          </li>
          <li>
            To provide concentrated liquidity, open <Link href="/positions">Positions</Link>, choose a token, set your range and
            shape, and mint.
          </li>
          <li>
            Track everything in <Link href="/portfolio">Portfolio</Link>: holdings, fees earned, claims and withdrawals.
          </li>
        </ol>

        <h2>Official links</h2>
        <p>
          {DOMAIN} is the only official website. Announcements come from{' '}
          <a href={X_URL} target="_blank" rel="noopener noreferrer">
            {X_HANDLE}
          </a>{' '}
          on X and{' '}
          <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
            {TELEGRAM_LABEL}
          </a>{' '}
          on Telegram. Never share your seed phrase.
        </p>
      </article>
    </section>
  );
}
