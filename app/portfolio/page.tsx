import type { Metadata } from 'next';
import { PortfolioBody, ShareCardButton } from '@/components/portfolio/PortfolioStats';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Portfolio — ${BRAND}` };

export default function PortfolioPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Portfolio</h1>
          <p className="lede">
            Every stake and position, marked to market, with the fees it actually earned. Nothing
            here is projected.
          </p>
        </div>
        <ShareCardButton />
      </div>
      <PortfolioBody />
    </section>
  );
}
