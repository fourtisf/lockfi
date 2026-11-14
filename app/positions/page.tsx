import type { Metadata } from 'next';
import { ShapeBuilder } from '@/components/positions/ShapeBuilder';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Positions — ${BRAND}` };

export default function PositionsPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Positions</h1>
          <p className="lede">
            Shape your liquidity by hand. Choose a range, pick a shape, deposit one token:{' '}
            {BRAND} splits it across bins and mints one Uniswap v4 position straight to your
            wallet.
          </p>
        </div>
      </div>
      <ShapeBuilder />
    </section>
  );
}
