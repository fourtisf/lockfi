import type { Metadata } from 'next';
import { StatusBody } from '@/components/pages/StatusBody';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Status — ${BRAND}` };

export default function StatusPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Status</h1>
          <p className="lede">What the services behind {BRAND}&rsquo;s figures are doing, and how fresh each figure is.</p>
        </div>
      </div>
      <StatusBody />
    </section>
  );
}
