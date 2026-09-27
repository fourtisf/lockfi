import type { Metadata } from 'next';
import Link from 'next/link';
import { AskPanel } from '@/components/ask/AskPanel';
import { Masthead } from '@/components/shell/Masthead';
import { CONTRACTS, EXPLORER_URL } from '@/lib/chain';

export const metadata: Metadata = {
  title: 'Learn',
  description: 'How providing liquidity through LockFi works, what it earns, and what can go wrong.',
};

/**
 * How it works and what can go wrong, in one page, before anyone signs.
 *
 * §7's rules are about numbers; this is the same honesty about the product.
 * Every risk is named here in the words a person would use, not buried in a
 * docs site, and every claim is one the site's own code keeps.
 */
const SECTIONS: { id: string; q: string; a: React.ReactNode }[] = [
  {
    id: 'what',
    q: 'What does LockFi do?',
    a: (
      <>
        It helps you provide liquidity to Uniswap pools on Robinhood Chain. You choose a pool and how to spread your
        deposit; LockFi builds the transaction; <b>Uniswap&rsquo;s own contracts</b> create the position and mint it to
        your wallet. Every swap through the pool pays a fee, and your position earns its share of the fees paid while the
        price is inside its range.
      </>
    ),
  },
  {
    id: 'custody',
    q: 'Who holds my money?',
    a: (
      <>
        You do. LockFi deploys no contract of its own. Your position is an NFT in your wallet, created by Uniswap&rsquo;s{' '}
        <a href={`${EXPLORER_URL}/address/${CONTRACTS.positionManager}`} target="_blank" rel="noopener noreferrer">
          PositionManager
        </a>{' '}
        (v4) or NonfungiblePositionManager (v3). Only the wallet holding it can collect its fees or withdraw it. There is
        no lockup, and LockFi takes no fee.
      </>
    ),
  },
  {
    id: 'nft',
    q: 'Do I need an NFT to start?',
    a: (
      <>
        No. The NFT is the receipt, not a ticket: the transaction that creates your position mints it to your wallet. Keep
        it in the wallet you used — whoever holds the NFT owns the position.
      </>
    ),
  },
  {
    id: 'one-token',
    q: 'Do I need to hold both tokens?',
    a: (
      <>
        No. A position always holds two tokens, but if your wallet has only ETH (or USDG, or only the token), the builder
        does it in two steps: <b>step 1</b> swaps part of what you hold for the other side in the same pool, through
        Uniswap&rsquo;s router, with a minimum it will not go below; <b>step 2</b> mints the position with what the swap
        delivered. The swap pays the pool&rsquo;s fee and some price impact — the builder shows both before you sign, and
        will not offer a swap that loses more than 5%.
      </>
    ),
  },
  {
    id: 'full-range',
    q: 'Full range or a shape?',
    a: (
      <>
        <b>Full range</b> (a stake) spreads your deposit across every possible price. It never goes out of range and needs
        no attention, but it earns the least per dollar. <b>A shape</b> puts your deposit between two prices you choose,
        split into bins: more of it works where the trading is, so it earns more per dollar while the price stays inside,
        and nothing once it leaves.
      </>
    ),
  },
  {
    id: 'shapes',
    q: 'Spot, curve, bid-ask?',
    a: (
      <>
        Only the bin holding the current price earns. <b>Spot</b> puts the same amount in every bin. <b>Curve</b> puts
        most at the price — the most earnings while the price sits still, the least once it wanders. <b>Bid-ask</b> puts
        most at the edges: a ladder that buys the token as it falls and sells it as it rises, earning little at the price
        itself.
      </>
    ),
  },
  {
    id: 'yield',
    q: 'What does the fee yield mean?',
    a: (
      <>
        It is what the pool actually paid its liquidity, measured over the last 24 hours and shown per year, or over a
        trailing seven days where labelled. It is <b>not a promise</b>: if trading slows, it falls. The builder&rsquo;s
        estimate for your position is today&rsquo;s fees times your share of the liquidity at the current price, and says
        so. A pool younger than a week is marked <i>est.</i>, and under a day of data shows a dash.
      </>
    ),
  },
  {
    id: 'impact',
    q: 'Can I lose money?',
    a: (
      <>
        Yes, in three ways. <b>Price impact on holdings</b> (often called impermanent loss): as the price moves, the pool
        sells the side that is rising and buys the side that is falling, so your position can end up worth less than
        simply holding the two tokens. Fees may or may not make up the difference; the Portfolio page shows both, side by
        side. <b>The token itself</b> can fall — providing liquidity does not protect you from that; you hold it. And{' '}
        <b>smart-contract risk</b>: Uniswap&rsquo;s contracts are audited and widely used, but no contract is risk-free.
      </>
    ),
  },
  {
    id: 'out-of-range',
    q: 'What does “out of range” mean?',
    a: (
      <>
        A shaped position earns only while the price is inside its range. Once the price leaves, the position holds one
        token only and <b>earns nothing</b> until the price comes back. The Portfolio page marks it in red, and the
        navigation counts how many of yours are out. <b>Rebalance</b> withdraws it and opens the builder on the same pool
        and width, around today&rsquo;s price.
      </>
    ),
  },
  {
    id: 'hooks',
    q: 'Why can I not stake every pool?',
    a: (
      <>
        Uniswap v4 pools can run a <i>hook</i> — extra code the pool calls on every trade and deposit. A hook can take a
        fee of its own or refuse outside liquidity. LockFi offers a hooked pool only once its hook has been looked at and
        allowed; until then its button reads View. Launchpad pools before graduation are listed but not stakeable.
      </>
    ),
  },
  {
    id: 'numbers',
    q: 'Where do the numbers come from?',
    a: (
      <>
        From the chain: every swap and liquidity event, read by LockFi&rsquo;s own indexer, priced through one path —
        ether through the ETH/USDG pool, everything else through ether. Today&rsquo;s volume may come from DexScreener or
        GeckoTerminal where the row says <i>live</i>. If the indexer is behind, the top bar says by how much. Nothing is
        projected or subsidised; there are no token emissions.
      </>
    ),
  },
  {
    id: 'first',
    q: 'Anything to know before the first deposit?',
    a: (
      <>
        Start small, and check the transaction on the{' '}
        <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">
          explorer
        </a>
        . Every transaction is checked by the network before your wallet asks you to sign — if it would fail, the site
        says why instead. Keep a little ETH for gas. LockFi&rsquo;s token contract address is the one shown at the top of
        this site. Any other address circulating as &ldquo;LockFi&rsquo;s token&rdquo; is not ours.
      </>
    ),
  },
];

export default function LearnPage() {
  return (
    <section>
      <Masthead
        eyebrow="Learn"
        title="How LockFi works"
        lede="Twelve short answers to read before you sign anything, including what can go wrong."
      />
      <div className="card learn">
        <nav aria-label="On this page" className="learn-toc">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.q}
            </a>
          ))}
        </nav>
        {SECTIONS.map((s) => (
          <article key={s.id} id={s.id} className="learn-q">
            <h2>{s.q}</h2>
            <p>{s.a}</p>
          </article>
        ))}
        <AskPanel
          title="Still unsure? Ask LockFi AI"
          suggestions={[
            'How do I earn fees on LockFi?',
            'What is price impact on holdings?',
            'Are my funds safe with LockFi?',
          ]}
        />
        <p className="hint" style={{ marginTop: 18 }}>
          Ready? <Link href="/stakes">Stake a pool</Link> or <Link href="/positions">shape a position</Link>.
        </p>
      </div>
    </section>
  );
}
