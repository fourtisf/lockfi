'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV = [
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

function useLinks(withIcons: boolean) {
  const pathname = usePathname();
  return NAV.map((item) => {
    const active = pathname === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={active ? 'on' : undefined}
        aria-current={active ? 'page' : undefined}
      >
        {withIcons && (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {item.icon}
          </svg>
        )}
        <span>{item.label}</span>
      </Link>
    );
  });
}

/**
 * Primary navigation, in the top bar on a wide screen. Below 1024px it is
 * hidden and the tab bar takes over, so only one of the two is ever displayed
 * and assistive tech never meets both.
 */
export function NavLinks() {
  return (
    <nav className="links" aria-label="Primary">
      {useLinks(false)}
    </nav>
  );
}

export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Primary">
      {useLinks(true)}
    </nav>
  );
}
