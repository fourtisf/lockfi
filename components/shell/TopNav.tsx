'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { CHAIN, ROUTER_FACTORY } from '@/lib/chain';
import { duration, shortWallet } from '@/lib/format';
import { BRAND, TOKEN_CA } from '@/lib/site';
import { Community } from './Community';
import { Mark } from './Logo';

/** Above this the indexer is behind and the bar has to say so (§7). */
const LAG_THRESHOLD_SECONDS = 30;

/** Routes whose content the search query actually filters. */
const SEARCHABLE = ['/pools', '/stakes', '/portfolio'];

/** One stroke icon per page, drawn on a 20-unit grid. */
const ICONS: Record<string, ReactNode> = {
  '/pools': <path d="M3 16.5h14M5.5 13V8.5M10 13V4.5M14.5 13v-6" />,
  '/stakes': (
    <>
      <path d="M10 3 3 6.5 10 10l7-3.5L10 3Z" />
      <path d="m3 10 7 3.5 7-3.5M3 13.5 10 17l7-3.5" />
    </>
  ),
  '/positions': (
    <>
      <path d="M3 17h14" />
      <path d="M4.5 14v-2M7.5 14V9M10.5 14V5M13.5 14V9M16.5 14v-2" />
    </>
  ),
  '/router': (
    <>
      <circle cx="5" cy="5" r="2" />
      <circle cx="15" cy="15" r="2" />
      <path d="M7 5h4.5a3.5 3.5 0 0 1 0 7h-3a3.5 3.5 0 0 0 0 7H13" />
    </>
  ),
  '/portfolio': (
    <>
      <rect x="3" y="5.5" width="14" height="11" rx="2.5" />
      <path d="M3 9h14M13 12.5h1.5" />
    </>
  ),
  '/learn': (
    <>
      <path d="M3.5 4.5h4.5a2 2 0 0 1 2 2v10a1.5 1.5 0 0 0-1.5-1.5h-5V4.5Z" />
      <path d="M16.5 4.5H12a2 2 0 0 0-2 2v10a1.5 1.5 0 0 1 1.5-1.5h5V4.5Z" />
    </>
  ),  '/ask': (
    <>
      <path d="M9 3.5c.5 2.8 1.7 4 4.5 4.5-2.8.5-4 1.7-4.5 4.5-.5-2.8-1.7-4-4.5-4.5 2.8-.5 4-1.7 4.5-4.5Z" />
      <path d="M15 12c.3 1.5.9 2.1 2.5 2.5-1.6.4-2.2 1-2.5 2.5-.3-1.5-.9-2.1-2.5-2.5 1.6-.4 2.2-1 2.5-2.5Z" />
    </>
  ),
};

const NAV = [
  { href: '/pools', label: 'Pools' },
  { href: '/stakes', label: 'Stakes' },
  { href: '/positions', label: 'Positions' },
  { href: '/portfolio', label: 'Portfolio' },
  // 'later' until the router factory is deployed on this chain (§48)
  { href: '/router', label: 'Router', later: ROUTER_FACTORY === null },
  { href: '/learn', label: 'Learn' },
  { href: '/ask', label: 'Ask AI' },
];

/**
 * The application's left rail: brand, the pages, and where the project
 * talks. Below 1180px it narrows to icons; below 900px it becomes a strip
 * across the top whose links scroll inside themselves, so the page never
 * scrolls sideways.
 */
export function Sidebar() {
  const { portfolio } = useMarket();
  // Positions earning nothing because the price left their range (§7). Only
  // the ones whose status is known: a pool without a price yet is not "out".
  const outOfRange = portfolio.positions.filter((p) => !p.inRange && !p.rangeUnknown).length;
  const pathname = usePathname();

  return (
    <aside className="side">
      <Link href="/pools" className="brand" aria-label={`${BRAND}, to the pools`}>
        <span className="brand-mark">
          <Mark size={22} color="var(--on-ac)" />
        </span>
        <span className="brand-name">{BRAND}</span>
      </Link>

      <nav className="nav-links" aria-label="Primary">
        {NAV.map((item) => {
          const active = pathname === item.href;
          const later = 'later' in item && item.later;
          const out = item.href === '/portfolio' && outOfRange > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? 'on' : undefined}
              aria-current={active ? 'page' : undefined}
              title={item.label}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                {ICONS[item.href]}
              </svg>
              <span className="nav-label">{item.label}</span>
              {/* A space, so a screen reader hears "Portfolio, 1 out of range", not one word. */}
              {(later || out) && ' '}
              {later && (
                <span className="nav-tag" title="The router contract is phase 4 and not deployed. The page shows the design.">
                  later
                </span>
              )}
              {out && (
                <span
                  className="nav-tag down"
                  data-testid="nav-out-of-range"
                  title={`${outOfRange} position${outOfRange === 1 ? ' is' : 's are'} out of range and earning nothing`}
                >
                  {outOfRange} out of range
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="side-foot">
        <Community className="side-soc" />
        <div className="side-net" title={`${CHAIN.name}, chain id ${CHAIN.id}. Every position is minted through Uniswap.`}>
          <i aria-hidden="true" />
          <span>
            {CHAIN.name}
            <small>Uniswap v3 · v4</small>
          </span>
        </div>
      </div>
    </aside>
  );
}

/**
 * The sticky bar over the page: search, the indexer's freshness and the
 * wallet. The global figures live in each page's masthead, where there is
 * room to label them.
 */
export function TopBar() {
  const { indexerLagSeconds } = useMarket();
  const { query, setQuery, wallet, openWallet } = useUi();
  const pathname = usePathname();
  const router = useRouter();

  const behind = indexerLagSeconds > LAG_THRESHOLD_SECONDS;
  const filtersHere = SEARCHABLE.includes(pathname);

  const onSearch = (value: string) => {
    setQuery(value);
    // Typing on a page the query cannot filter takes you to the listing it can.
    if (value !== '' && !filtersHere) router.push('/pools');
  };

  return (
    <header className="nav">
      <div className="nav-in">
        <div className="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <label htmlFor="q" className="sr-only">
            Search tokens and stakes
          </label>
          <input
            id="q"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={filtersHere ? 'Search tokens' : 'Search pools'}
            autoComplete="off"
          />
        </div>

        {/* The token's contract address, or that it is not announced yet
            (§43). Said on every page, because a site that asks for a wallet
            should say which address is its own before anyone else does. */}
        <CaChip />

        {/* Indexer freshness (§7: never render stale numbers as if they were
            live). Neutral by design — red is reserved for negative numbers. */}
        <span
          className={`lag${behind ? ' behind' : ''}`}
          title={
            behind
              ? 'The indexer is behind head. Numbers on screen are as of this lag, not live.'
              : 'Indexer is at head.'
          }
        >
          <i />
          {behind ? (
            <>
              <span className="lag-word">Indexer</span>{' '}
              <span className="num">{duration(indexerLagSeconds)}</span> behind
            </>
          ) : (
            <span className="lag-live">Live</span>
          )}
        </span>

        <button
          className="btn btn-brand"
          onClick={openWallet}
          title={wallet ? `${wallet.address} · ${wallet.name}` : undefined}
        >
          {wallet ? (
            <>
              <i className="wallet-dot" aria-hidden="true" />
              <span className="num">{shortWallet(wallet.address)}</span>
            </>
          ) : (
            <>
              <span className="wallet-long">Connect wallet</span>
              <span className="wallet-short">Connect</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
}

/** "CA · coming soon" until TOKEN_CA is set; then the short address, copied on click. */
function CaChip() {
  const [copied, setCopied] = useState(false);
  const ca = TOKEN_CA;
  if (!ca) {
    return (
      <span
        className="ca-chip"
        title="LockFi's contract address will be announced here first. Any address circulating before it appears on this site is not ours."
      >
        CA <b>coming soon</b>
      </span>
    );
  }
  const copy = () => {
    void navigator.clipboard?.writeText(ca).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="ca-chip" onClick={copy} title={`${ca}: click to copy`}>
      CA <b className="num">{copied ? 'copied' : `${ca.slice(0, 6)}…${ca.slice(-4)}`}</b>
    </button>
  );
}
