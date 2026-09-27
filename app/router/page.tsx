import type { Metadata } from 'next';
import { LiveRouter } from '@/components/router/LiveRouter';
import { RouterPanel } from '@/components/router/RouterPanel';
import { Masthead } from '@/components/shell/Masthead';
import { ROUTER_FACTORY } from '@/lib/chain';
import { DATA_SOURCE } from '@/lib/data';

export const metadata: Metadata = { title: 'Router' };

export default function RouterPage() {
  // Live once the factory is deployed on this chain (§48); until then, and on
  // simulated data, the page shows how it will work and sends nothing.
  const live = ROUTER_FACTORY !== null && DATA_SOURCE === 'live';
  return (
    <section>
      <Masthead
        eyebrow="Router · for token teams"
        title="Fees into liquidity"
        lede={
          live
            ? 'Point your creator fees at the router and it turns them into permanent liquidity for your pool, on the schedule you choose.'
            : 'Point your creator fees at the router and it turns them into permanent liquidity for your pool, on a schedule or at market-cap milestones.'
        }
      />
      {live ? <LiveRouter /> : <RouterPanel />}
    </section>
  );
}
