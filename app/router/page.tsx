import type { Metadata } from 'next';
import { RouterPanel } from '@/components/router/RouterPanel';

export const metadata: Metadata = { title: 'Router — Balast' };

export default function RouterPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Router</h1>
          <p className="lede">
            For token teams: turn creator fees into permanent pool depth. Point your fee wallet at
            the router and it adds liquidity on a schedule or at market-cap milestones. TWAP
            priced, keeper triggered, and funds never leave the contract.
          </p>
        </div>
      </div>
      <RouterPanel />
    </section>
  );
}
