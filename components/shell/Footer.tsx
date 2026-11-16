import Link from 'next/link';
import { CHAIN } from '@/lib/chain';
import { BRAND } from '@/lib/site';
import { Mark } from './Logo';
import { CA_WARNING, CaChip, TelegramLink, XLink } from './Socials';

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-l">
        <Mark size={18} color="var(--fg-3)" />
        {BRAND} · {CHAIN.name} · chain {CHAIN.id}
      </div>
      <div className="foot-ca">
        <CaChip />
        <span className="foot-warn">{CA_WARNING}</span>
      </div>
      <div className="foot-r">
        <Link href="/brand">Brand</Link>
        <Link href="/contracts">Contracts</Link>
        {/* No "Audit" link until there is an audit to link to (§8, P5). */}
        <Link href="/docs">Docs</Link>
        <Link href="/status">Status</Link>
        <XLink />
        <TelegramLink />
      </div>
    </footer>
  );
}
