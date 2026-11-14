'use client';

import { useMemo, useState } from 'react';
import { usePools } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { Change } from '@/components/ui/Change';
import { FlashTd } from '@/components/ui/FlashTd';
import { Spark } from '@/components/ui/Sparkline';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { useFlip } from '@/hooks/useFlip';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { Pool, Quote } from '@/lib/data/types';
import { ageLabel, usd } from '@/lib/format';
import {
  YIELD_WINDOW_HOURS,
  feeYieldQualifier,
  feeYieldTitle,
  feeYieldValue,
  yieldPct,
} from '@/lib/yield';

type Variant = 'trending' | 'established';

const FILTERS: { id: 'all' | Quote; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ETH', label: 'ETH' },
  { id: 'USDG', label: 'USDG' },
];

/** Widest depth bar in the Established board, so the bars stay comparable. */
const DEPTH_BAR_MAX = 6.5e6;

export function PoolBoard({
  variant,
  title,
  boardId,
}: {
  variant: Variant;
  title: string;
  boardId: string;
}) {
  const pools = usePools();
  const { query, openStake } = useUi();
  const [filter, setFilter] = useState<'all' | Quote>('all');
  const reduced = useReducedMotion();
  const register = useFlip(!reduced);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = pools
      .filter((p) => filter === 'all' || p.quote === filter)
      .filter(
        (p) =>
          q === '' ||
          p.token.symbol.toLowerCase().includes(q) ||
          p.token.name.toLowerCase().includes(q),
      );

    if (variant === 'trending') {
      // Volume ranks Trending, and only Trending. Everything else ranks on
      // fee yield (§1) — volume is trivially washed.
      return matching.slice().sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    }
    return matching
      // §10 assumption: a pool joins Established once it has a real 7d record.
      .filter((p) => p.ageHours >= YIELD_WINDOW_HOURS)
      .slice()
      .sort((a, b) => yieldPct(b.feeYield) - yieldPct(a.feeYield));
  }, [pools, filter, query, variant]);

  // An empty board has four different causes, and the live site meets all of
  // them for real. "Try a ticker" was the answer to every one, including a
  // board nobody had searched.
  const empty: [string, string] =
    pools.length === 0
      ? ['No pools indexed yet', 'The indexer is still reading the chain.']
      : query.trim() !== ''
        ? ['No match', 'Try a ticker, or clear the search.']
        : filter !== 'all'
          ? [`No ${filter} pools`, 'None of the indexed pools trade against it yet.']
          : ['No pool has a full week yet', 'Pools join this board once they have 7 days of fees.'];

  return (
    <div className="card">
      <div className="board-h">
        <h2 className="sect-h">
          {title}
          {variant === 'trending' ? (
            <span className="muted">by volume</span>
          ) : (
            <span
              className="muted"
              title="A pool needs a full 7 days of fees before its yield is worth ranking."
            >
              7d+ · by fee yield
            </span>
          )}
        </h2>
        <div className="seg" role="group" aria-label={`${title} quote filter`}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? 'on' : undefined}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr-only">
            {variant === 'trending'
              ? `${title}, ranked by 24h volume`
              : `${title}, ranked by fee yield over the trailing 7 days`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col" className="r hide-mc">
                MC
              </th>
              <th scope="col" className="r">
                24h
              </th>
              <th scope="col" className="r">
                {variant === 'trending' ? 'Fees 24h' : 'Fee yield 7d'}
              </th>
              <th scope="col" className="r hide-l">
                {variant === 'trending' ? 'Vol 24h' : 'Depth'}
              </th>
              <th scope="col" className="r hide-a">
                Age
              </th>
              <th scope="col" className="r hide-m">
                7d fees
              </th>
              <th scope="col" className="hide-m">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="static">
                <td colSpan={8}>
                  <div className="empty">
                    <b>{empty[0]}</b>
                    {empty[1]}
                  </div>
                </td>
              </tr>
            )}
            {rows.map((pool, i) => (
              <Row
                key={pool.id}
                pool={pool}
                rank={i + 1}
                leader={i === 0}
                variant={variant}
                registerRef={register(`${boardId}-${pool.id}`)}
                onOpen={() => openStake(pool.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  pool,
  rank,
  leader,
  variant,
  registerRef,
  onOpen,
}: {
  pool: Pool;
  rank: number;
  leader: boolean;
  variant: Variant;
  registerRef: (el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  const age = ageLabel(pool.ageHours);
  const qualifier = feeYieldQualifier(pool.feeYield, age);
  const yieldText = feeYieldValue(pool.feeYield);

  return (
    <tr ref={registerRef} className={leader ? 'lead' : undefined} onClick={onOpen}>
      <td>
        <button className="tok tok-btn" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          <span className="rank" aria-hidden="true">
            {rank}
          </span>
          <TokenBadge token={pool.token} />
          <span className="tok-id">
            <span className="n">{pool.token.symbol}</span>
            <span className="s" title={pool.token.name}>
              {pool.token.name}
            </span>
          </span>
        </button>
      </td>
      <td
        className="r num hide-mc"
        title={
          pool.marketCapUsd <= 0
            ? 'No token supply read yet, so there is no figure to show.'
            : pool.marketCapIsFdv
              ? 'Fully diluted: total supply \u00d7 price. Circulating supply is not ' +
                'distinguishable on chain, so locked and vested tokens are included.'
              : undefined
        }
      >
        {/* An FDV is marked, because calling it market cap overstates every
            token with a vesting schedule (§7). */}
        {usd(pool.marketCapUsd)}
        {pool.marketCapIsFdv && pool.marketCapUsd > 0 ? <i className="fdv">fdv</i> : null}
      </td>
      <FlashTd className="r" text={pool.change24hPct.toFixed(1)}>
        <Change pct={pool.change24hPct} />
      </FlashTd>

      {variant === 'trending' ? (
        <FlashTd className="r num" text={usd(pool.fees24hUsd)} />
      ) : (
        <FlashTd
          className={`r num${pool.feeYield.basis === 'insufficient' ? ' muted' : ' up'}`}
          text={yieldText}
          title={feeYieldTitle(pool.feeYield)}
        >
          <span style={{ fontWeight: 600 }}>{yieldText}</span>
          {qualifier && <span className="est" style={{ display: 'block', margin: 0 }}>{qualifier}</span>}
        </FlashTd>
      )}

      {variant === 'trending' ? (
        <FlashTd className="r num hide-l" text={usd(pool.volume24hUsd)} />
      ) : (
        <td className="r hide-l" style={{ whiteSpace: 'nowrap' }}>
          <span className="depth-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, (pool.tvlUsd / DEPTH_BAR_MAX) * 100)}%` }} />
          </span>
          <span className="num muted" style={{ fontSize: 12.5 }}>
            {usd(pool.tvlUsd)}
          </span>
        </td>
      )}

      <td className="r num hide-a muted">{age}</td>
      <td className="r hide-m">
        <Spark values={pool.feeHistory} />
      </td>
      <td className="act hide-m">
        <button
          className="stake-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {pool.stakeable ? 'Stake' : 'View'}
          <span className="sr-only"> {pool.token.symbol}</span>
        </button>
      </td>
    </tr>
  );
}
