import type { Metadata } from 'next';
import Link from 'next/link';
import { Featured, MiniCards } from '@/components/pools/Featured';
import { LivePayouts } from '@/components/pools/LivePayouts';
import { PoolBoard } from '@/components/pools/PoolBoard';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Pools — ${BRAND}` };

export default function PoolsPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Pools</h1>
          <p className="lede">Earn a share of real swap fees, paid in WETH. No emissions, no lockups.</p>
        </div>
        <div className="acts">
          <Link className="btn btn-quiet" href="/positions">
            Build a position
          </Link>
          <Link className="btn btn-brand" href="/stakes">
            Start earning
          </Link>
        </div>
      </div>

      <div className="hero">
        <Featured />
        <MiniCards />
      </div>

      <div className="boards">
        <PoolBoard variant="trending" title="Trending" boardId="A" />
        <PoolBoard variant="established" title="Established" boardId="B" />
      </div>

      <div className="grid g2" style={{ marginTop: 20 }}>
        <LivePayouts />
        {/* §7's rules, on the page where the numbers are, not in a docs page. */}
        <div className="card rules">
          <h2 className="sect-h">How these numbers are made</h2>
          <ul>
            <li>
              <b>7d</b>
              <span>Fee yield is trailing seven days of real swap fees. It is never annualised from a single day.</span>
            </li>
            <li>
              <b>est.</b>
              <span>A pool younger than seven days is an estimate, and shows its age next to the figure.</span>
            </li>
            <li>
              <b>—</b>
              <span>Under 24 hours of data there is no figure at all, only a dash.</span>
            </li>
            <li>
              <b>10%</b>
              <span>{BRAND}&rsquo;s fee, taken from fees earned at harvest. Never from your deposit.</span>
            </li>
            <li>
              <b>0</b>
              <span>Token emissions. If volume slows, the yield slows with it.</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
