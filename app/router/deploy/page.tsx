import type { Metadata } from 'next';
import { DeployFactory } from '@/components/router/DeployFactory';
import { Masthead } from '@/components/shell/Masthead';

// The owner's page, reached by its address: not in the navigation, not indexed.
export const metadata: Metadata = { title: 'Deploy router', robots: { index: false, follow: false } };

export default function DeployRouterPage() {
  return (
    <section>
      <Masthead eyebrow="Router · owner" title="Deploy the router factory" lede="Once, from the wallet that will own it." />
      <DeployFactory />
    </section>
  );
}
