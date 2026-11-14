import { CHAIN } from '@/lib/chain';
import { Mark } from './Logo';

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-l">
        <Mark size={18} color="var(--fg-4)" />
        Balast · {CHAIN.name} · chain {CHAIN.id}
      </div>
      <div className="foot-r">
        <a href="#">Contracts</a>
        {/* No "Audit" link until there is an audit to link to (§8, P5). */}
        <a href="#">Docs</a>
        <a href="#">Status</a>
        <a href="#">X</a>
      </div>
    </footer>
  );
}
