import type { Metadata } from 'next';
import Link from 'next/link';
import { AuditNotice } from '@/components/wallet/Wallet';
import { DATA_SOURCE } from '@/lib/data';
import { WALLET, fetchShareCard, shortWallet, sinceLabel } from '@/lib/data/share';
import { usd, usdFee } from '@/lib/format';
import { BRAND } from '@/lib/site';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { address: string } }): Promise<Metadata> {
  const title = `Fees earned staking on ${BRAND}`;
  const description = `Real swap fees, worked out from the chain. No emissions, no lockup. Stake on ${BRAND}.`;
  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { card: 'summary_large_image', title, description },
    robots: WALLET.test(params.address) ? { index: false } : undefined,
  };
}

/**
 * The page a shared card links to (§32): the card itself, what it is made
 * of in words, and where to start. Every figure is worked out on the server
 * from the chain (server/api/share.ts), never taken from the link.
 */
export default async function SharePage({ params }: { params: { address: string } }) {
  const valid = WALLET.test(params.address);
  const card = valid ? await fetchShareCard(params.address) : null;
  const since = sinceLabel(card?.since ?? null);
  return (
    <section>
      <div className="head">
        <div>
          <h1>Fees earned staking</h1>
          <p className="lede">Real swap fees, worked out from the chain. No emissions, no lockup.</p>
        </div>
      </div>
      <div className="pg-stack">
        {valid && (
          <div className="card pg-card sh-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/share/${params.address}/opengraph-image`} alt="The share card" width={1200} height={630} />
          </div>
        )}
        <section className="card pg-card">
          {!valid ? (
            <p className="pg-note">That is not a wallet address.</p>
          ) : DATA_SOURCE !== 'live' ? (
            <p className="pg-note">This is a simulated build: share cards are worked out from the chain on the live site.</p>
          ) : card === null ? (
            <p className="pg-note">The vaults could not be read just now. Reload in a moment.</p>
          ) : (
            <dl className="pg-dl">
              <div>
                <dt>Fees earned</dt>
                <dd className="num">{card.feesEarnedUsd === null ? '—' : usdFee(card.feesEarnedUsd)}</dd>
                <span className="pg-sub">
                  claimed {card.claimedUsd === null ? '—' : usdFee(card.claimedUsd)} + claimable{' '}
                  {card.claimableUsd === null ? '—' : usdFee(card.claimableUsd)}, at today&rsquo;s prices
                </span>
              </div>
              <div>
                <dt>Staked now</dt>
                <dd className="num">{card.stakedUsd === null ? '—' : usd(card.stakedUsd)}</dd>
                <span className="pg-sub">{card.vaults.map((v) => v.label).join(', ') || 'nothing staked now'}</span>
              </div>
              <div>
                <dt>Wallet</dt>
                <dd className="num">{shortWallet(card.wallet)}</dd>
                <span className="pg-sub">{since ? `first stake ${since}` : 'no stake yet'}</span>
              </div>
            </dl>
          )}
          <p className="pg-note">
            Fees come from trades in the vaults&rsquo; Uniswap pools: if trading slows, so do fees. {BRAND} takes 10%
            of fees collected and nothing from deposits. Withdraw any time.
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <Link className="btn btn-brand" href="/stakes">
              Start earning
            </Link>
            <Link className="btn btn-quiet" href="/stats">
              See every vault&rsquo;s totals
            </Link>
          </div>
          <AuditNotice />
        </section>
      </div>
    </section>
  );
}
