import type { Metadata } from 'next';
import { ContractsBody } from '@/components/pages/ContractsBody';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Contracts — ${BRAND}` };

export default function ContractsPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Contracts</h1>
          <p className="lede">Every contract {BRAND} uses, to copy and check on the explorer before you sign anything.</p>
        </div>
      </div>
      <ContractsBody />
    </section>
  );
}
