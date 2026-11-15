import type { Metadata } from 'next';
import { MyStakes } from '@/components/stakes/MyStakes';
import { StakesBody } from '@/components/stakes/StakesBody';
import { DATA_SOURCE } from '@/lib/data';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Stakes — ${BRAND}` };

export default function StakesPage() {
  return (
    <section className="stakes-page">
      <div className="head">
        <div>
          <h1>Stakes</h1>
          {DATA_SOURCE === 'live' ? (
            // Real vaults credit fees per share as they are collected and pay
            // them in the pool's two tokens; the simulator still rehearses the
            // WETH stream.
            <p className="lede">
              Drop in ETH, USDG, or both. Your share of the pool&rsquo;s swap fees is credited the
              moment it&rsquo;s earned — claim any time in ETH and the pool&rsquo;s token. Withdraw
              whenever you like, here or from your portfolio: leaving never forfeits fees already earned.
            </p>
          ) : (
            <p className="lede">
              Drop in one token. Your share of the pool&rsquo;s swap fees streams to you in WETH over a
              rolling seven days. Leave whenever you like.
            </p>
          )}
        </div>
      </div>
      <StakesBody />
      <MyStakes />
    </section>
  );
}
