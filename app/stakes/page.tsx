import type { Metadata } from 'next';
import { MyStakes } from '@/components/stakes/MyStakes';
import { VaultGrid } from '@/components/stakes/VaultGrid';

export const metadata: Metadata = { title: 'Stakes — Balast' };

export default function StakesPage() {
  return (
    <section className="stakes-page">
      <div className="head">
        <div>
          <h1>Stakes</h1>
          <p className="lede">
            Stake once and your share of fees streams to you as WETH over a rolling 7 days. Drop in
            one token; Balast pairs it, places it and harvests. Claim, compound or leave whenever
            you like.
          </p>
        </div>
      </div>

      <VaultGrid />
      <MyStakes />
    </section>
  );
}
