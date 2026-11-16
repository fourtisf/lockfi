import type { Metadata } from 'next';
import { StatsBody } from '@/components/pages/StatsBody';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = {
  title: `Stats — ${BRAND}`,
  description: `What every ${BRAND} vault holds and has paid: staked, stakers, fees to stakers and ${BRAND}'s fee, from the vaults' own events.`,
};

export default function StatsPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Stats</h1>
          <p className="lede">What every vault holds and has paid, from its own events on chain.</p>
        </div>
      </div>
      <StatsBody />
    </section>
  );
}
