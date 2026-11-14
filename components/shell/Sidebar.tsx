'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DATA_SOURCE } from '@/lib/data';
import { Mark } from './Logo';

const NAV = [
  {
    href: '/pools',
    label: 'Pools',
    icon: <path d="M3 17l5-6 4 4 5-8 4 5" />,
  },
  {
    href: '/stakes',
    label: 'Stakes',
    icon: (
      <>
        <path d="M12 3l9 5-9 5-9-5 9-5z" />
        <path d="M3 13l9 5 9-5" />
      </>
    ),
  },
  {
    href: '/positions',
    label: 'Positions',
    icon: <path d="M4 20V10M9 20V4M14 20v-8M19 20V7" />,
  },
  {
    href: '/router',
    label: 'Router',
    icon: (
      <>
        <path d="M4 7h10a4 4 0 014 4v6" />
        <path d="M15 14l3 3 3-3" />
        <circle cx="4" cy="7" r="2" />
      </>
    ),
  },
  {
    href: '/portfolio',
    label: 'Portfolio',
    icon: (
      <>
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" />
      </>
    ),
  },
];

/**
 * Primary navigation: a labelled rail on desktop, an icon rail below 1180px,
 * and a bottom tab bar on a phone. Only one of the two navs is ever displayed,
 * so assistive tech never meets both.
 */
export function Sidebar() {
  const pathname = usePathname();

  const links = (cls?: string) =>
    NAV.map((item) => {
      const active = pathname === item.href;
      return (
        <Link
          key={item.href}
          href={item.href}
          className={[cls, active ? 'on' : undefined].filter(Boolean).join(' ') || undefined}
          aria-current={active ? 'page' : undefined}
          title={item.label}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {item.icon}
          </svg>
          <span>{item.label}</span>
        </Link>
      );
    });

  return (
    <>
      <nav className="rail" aria-label="Primary">
        <div className="logo-m">
          <Mark size={26} title="Balast" />
          <span>Balast</span>
        </div>
        {links()}
        <div className="sp" />
        {DATA_SOURCE !== 'live' && (
          // The simulator's numbers are generated. The page says so in words,
          // where it cannot be mistaken for a live feed (§7).
          <div className="sys">
            <b>Simulated data</b>
            P0 preview. Numbers are generated and no transaction is ever sent.
          </div>
        )}
      </nav>
      <nav className="tabbar" aria-label="Primary">
        {links()}
      </nav>
    </>
  );
}
