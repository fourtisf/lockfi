import type { Metadata } from 'next';
import { MyStakes } from '@/components/stakes/MyStakes';
import { StakesBody } from '@/components/stakes/StakesBody';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Stakes — ${BRAND}` };

export default function StakesPage() {
  return (
    <section className="stakes-page">
      <div className="head">
        <div>
          <h1>Stakes</h1>
          <p className="lede">
            Drop in one token. Your share of the pool&rsquo;s swap fees streams to you in WETH over a
            rolling seven days. Leave whenever you like.
          </p>
        </div>
      </div>
      <StakesBody />
      <MyStakes />
    </section>
  );
}
