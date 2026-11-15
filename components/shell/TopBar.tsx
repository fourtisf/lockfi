'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { WalletButton } from '@/components/wallet/Wallet';
import { CaChip, XButton } from './Socials';
import { DATA_SOURCE } from '@/lib/data';
import { lagLabel, usd, usdExact } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { Lockup, Mark } from './Logo';
import { NavLinks } from './Nav';

/** Above this the indexer is behind and the top bar has to say so (§7). */
const LAG_THRESHOLD_SECONDS = 30;

/** Routes whose content the search query actually filters. */
const SEARCHABLE = ['/pools', '/stakes', '/portfolio'];

export function TopBar() {
  const { global, featured, indexerLagSeconds } = useMarket();
  const { query, setQuery } = useUi();
  const pathname = usePathname();
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const behind = indexerLagSeconds > LAG_THRESHOLD_SECONDS;
  const filtersHere = SEARCHABLE.includes(pathname);
  const simulated = DATA_SOURCE !== 'live';

  const onSearch = (value: string) => {
    setQuery(value);
    // Typing on a page the query cannot filter takes you to the listing it can.
    if (value !== '' && !filtersHere) router.push('/pools');
  };

  // "/" focuses search from anywhere that is not already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const lagSeconds = Math.round(indexerLagSeconds);
  const statusTitle = simulated
    ? behind
      ? 'Simulated data. The simulator is also rehearsing an indexer that has fallen behind head: numbers on screen are as of this lag.'
      : 'Simulated data: the simulator generates every number on this page. No transaction is ever sent, even with a wallet connected.'
    : behind
      ? 'The indexer is behind head. Numbers on screen are as of this lag, not live.'
      : 'Indexer is at head.';

  return (
    <header className="top">
      <div className="top-in">
        <Link href="/pools" className="brand" aria-label={`${BRAND}, pools`}>
          <span className="brand-full">
            <Lockup size={28} />
          </span>
          <span className="brand-m">
            <Mark size={28} />
          </span>
        </Link>

        <NavLinks />

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
            ref={searchRef}
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={filtersHere ? 'Search tokens' : 'Search pools'}
            autoComplete="off"
          />
          <kbd aria-hidden="true">/</kbd>
        </div>

        <div className="top-r">
          <span
            className={`lag${simulated ? ' sim' : ''}${behind ? ' behind' : ''}`}
            title={statusTitle}
          >
            <i />
            {simulated && (
              <>
                <span className="lag-long">Simulated</span>
                <span className="lag-short">Sim</span>
                {behind && <span className="lag-word"> ·</span>}
              </>
            )}
            {behind ? (
              <>
                {!simulated && <span className="lag-word">Indexer</span>} {lagLabel(lagSeconds)} behind
              </>
            ) : (
              !simulated && <span className="lag-live">Live</span>
            )}
          </span>
          <XButton />
          <WalletButton />
        </div>
      </div>

      {/* The market strip. Every figure is summed from the pools (§12). */}
      <div className="strip">
        <div className="strip-in">
          <div className="tstats">
            <Stat label="TVL" value={usdExact(global.tvlUsd)} />
            <Stat label="Fees 24h" value={usdExact(featured.fees24hUsd)} />
            <Stat label="Volume 24h" value={usd(featured.volume24hUsd)} />
            {/* Zero means not priced yet — the USD anchor has not been found — not
                that ETH is worth nothing. */}
            <Stat label="ETH" value={global.ethPriceUsd > 0 ? usdExact(global.ethPriceUsd, 2) : '—'} />
          </div>
          {simulated && (
            // Said in words, where it cannot be mistaken for a live feed (§7).
            <p className="strip-note">Simulated data · numbers are generated and no transaction is ever sent</p>
          )}
          <span className="strip-ca">
            <CaChip compact />
          </span>
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ts">
      <div className="k">{label}</div>
      <div className="v num">{value}</div>
    </div>
  );
}
