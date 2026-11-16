import type { Metadata } from 'next';
import { TokenBody } from '@/components/pages/TokenBody';
import { initialSnapshot } from '@/lib/data/initial-snapshot';
import { BRAND } from '@/lib/site';

/** The token's symbol from the live snapshot, for the title and the link card; none in the simulator. */
async function symbolOf(address: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const snap = await initialSnapshot();
  const a = address.toLowerCase();
  return snap?.pools.find((p) => p.token.address.toLowerCase() === a)?.token.symbol ?? null;
}

export async function generateMetadata({ params }: { params: { address: string } }): Promise<Metadata> {
  const symbol = await symbolOf(params.address);
  const title = symbol ? `${symbol} — ${BRAND}` : `Token — ${BRAND}`;
  const description = symbol
    ? `${symbol} on Robinhood Chain: price, depth, fees and every pool, read from the chain. Stake or add liquidity on ${BRAND}.`
    : `A token on Robinhood Chain, read from the chain by ${BRAND}.`;
  return { title, description, openGraph: { title, description }, twitter: { card: 'summary_large_image', title, description } };
}

/** The heading is the client body's: it knows the symbol from the market data in the simulator too. */
export default function TokenPage({ params }: { params: { address: string } }) {
  return (
    <section>
      <TokenBody address={params.address} />
    </section>
  );
}
