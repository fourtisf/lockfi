'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { byChange, byMarketCap, mcRanked, MC_MAX_DEPTH_MULTIPLE, tokenRows } from '@/lib/pools';

type Variant = 'trending' | 'established';

const FILTERS: { id: 'all' | Quote; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ETH', label: 'ETH' },
  { id: 'USDG', label: 'USDG' },
];

/**
 * How a board is ranked: its own metric (§6), market cap (ALFA's default),
 * or the 24h price move either way — top gainers and top losers, the way a
 * trader reads a market. Gainers and losers rank the price move, never fee
 * yield: yield is what an LP earns, not what the token did.
 */
type Sort = 'board' | 'mc' | 'gainers' | 'losers';
const SORTS: readonly Sort[] = ['board', 'mc', 'gainers', 'losers'];

/** The sort a viewer chose, per board. A convenience: losing it loses nothing. */
function readSort(boardId: string): Sort {
  try {
    const saved = window.localStorage.getItem(`tidewell.sort.${boardId}`);
    return SORTS.includes(saved as Sort) ? (saved as Sort) : 'mc';
  } catch {
    return 'mc';
  }
}
function writeSort(boardId: string, sort: Sort): void {
  try {
    window.localStorage.setItem(`tidewell.sort.${boardId}`, sort);
  } catch {
    /* private window or blocked storage: the choice lasts this visit only */
  }
}

/** What a pool must have traded in 24 hours to be on Trending. */
const TRENDING_MIN_VOLUME_USD = 100;
/** What a pool must have earned in 7 days to be on Established. */
const ESTABLISHED_MIN_FEES_USD = 1;

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
  // Highest market cap first, by default: ALFA's call, asked for twice, over
  // §1's "every ranking defaults to fee yield". Each board's own ranking
  // (§6: volume for Trending, fee yield for Established) is one click away,
  // and a viewer's choice is remembered in this browser. Read after mount so
  // the server's HTML and the first client render agree.
  const [sort, setSortState] = useState<Sort>('mc');
  useEffect(() => setSortState(readSort(boardId)), [boardId]);
  const setSort = (next: Sort) => {
    setSortState(next);
    writeSort(boardId, next);
  };
  const boardLabel = variant === 'trending' ? 'Volume' : 'Fee yield';
  /** What the heading says the board is ranked by. */
  const rankedBy =
    sort === 'mc'
      ? 'by market cap'
      : sort === 'gainers'
        ? 'top gainers 24h'
        : sort === 'losers'
          ? 'top losers 24h'
          : variant === 'trending'
            ? 'by volume'
            : 'by fee yield';
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

    // Live boards list what is live. A pool nobody traded shows 0.0%, $0
    // fees and $0 volume — true, and a wall of it buried the pools people
    // came to see. Trending is what traded in the last 24 hours; Established
    // is what earned fees in the last 7 days (§10: and has 7 days of record).
    // Filtered per pool, before grouping, so a token's row is its deepest
    // ACTIVE pool rather than a dead one that happens to be deeper.
    //
    // "Traded" means traded for real: a pool with one $0.40 swap passed a
    // trades > 0 test and filled the board with $0 fees and $0 volume again.
    const active =
      variant === 'trending'
        ? matching.filter((p) => p.volume24hUsd >= TRENDING_MIN_VOLUME_USD)
        : matching.filter(
            (p) => p.ageHours >= YIELD_WINDOW_HOURS && p.feeHistory.reduce((a, f) => a + f, 0) >= ESTABLISHED_MIN_FEES_USD,
          );
    // One row per token: its deepest pool in this view (lib/pools.ts).
    const board = tokenRows(active);
    if (sort === 'mc') {
      // Highest market cap first, with thin pools' figures kept from leading.
      return board.sort((a, b) => byMarketCap(a.pool, b.pool));
    }
    if (sort === 'gainers' || sort === 'losers') {
      // The 24h price move, up or down (lib/pools.ts byChange): true 24h
      // moves before since-launch ones, unknown last.
      const order = byChange(sort === 'gainers' ? 1 : -1);
      return board.sort((a, b) => order(a.pool, b.pool));
    }
    if (variant === 'trending') {
      // Volume ranks Trending, and only Trending. Everything else ranks on
      // fee yield (§1) — volume is trivially washed.
      return board.sort((a, b) => b.pool.volume24hUsd - a.pool.volume24hUsd);
    }
    return board.sort((a, b) => yieldPct(b.pool.feeYield) - yieldPct(a.pool.feeYield));
  }, [pools, filter, query, variant, sort]);

  // An empty board has four different causes, and the live site meets all of
  // them for real. "Try a ticker" was the answer to every one, including a
  // board nobody had searched.
  const empty: [string, string] =
    pools.length === 0
      ? ['No pools indexed yet', 'The indexer is still reading the chain.']
      : query.trim() !== ''
        ? ['No match', 'Try a ticker, or clear the search.']
        : filter !== 'all'
          ? [`No ${filter} pools`, 'None of the active pools trade against it.']
          : variant === 'trending'
            ? ['Nothing traded in the last 24 hours', 'Pools appear here once $100 trades in a day.']
            : ['No pool has a full week of fees yet', 'Pools join this board once they have 7 days of fees.'];

  return (
    <div className="card">
      <div className="board-h">
        <h2 className="sect-h">
          {title}
          {variant === 'trending' ? (
            <span className="muted" title="Tokens with at least $100 traded in the last 24 hours.">
              24h · {rankedBy}
            </span>
          ) : (
            <span
              className="muted"
              title="Pools with a full 7 days of record that earned fees in them."
            >
              7d+ · {rankedBy}
            </span>
          )}
        </h2>
        <div className="board-ctl">
          <div className="seg" role="group" aria-label={`${title} sort`}>
            <button className={sort === 'board' ? 'on' : undefined} aria-pressed={sort === 'board'} onClick={() => setSort('board')}>
              {boardLabel}
            </button>
            <button
              className={sort === 'mc' ? 'on' : undefined}
              aria-pressed={sort === 'mc'}
              onClick={() => setSort('mc')}
              title={`Highest market cap first. A figure more than ${MC_MAX_DEPTH_MULTIPLE.toLocaleString('en-US')}\u00d7 its pool's depth, or with depth unknown, is ranked after the rest: a price a few dollars can move makes it meaningless.`}
            >
              MC
            </button>
            <button
              className={sort === 'gainers' ? 'on' : undefined}
              aria-pressed={sort === 'gainers'}
              onClick={() => setSort('gainers')}
              title="Biggest 24h price rise first. A move measured since a pool's first trade today (marked with its age) ranks after full-day moves."
            >
              <span aria-hidden="true">▲ </span>Gainers
            </button>
            <button
              className={sort === 'losers' ? 'on' : undefined}
              aria-pressed={sort === 'losers'}
              onClick={() => setSort('losers')}
              title="Biggest 24h price fall first. A move measured since a pool's first trade today (marked with its age) ranks after full-day moves."
            >
              <span aria-hidden="true">▼ </span>Losers
            </button>
          </div>
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
      </div>

      <div className="tbl-wrap">
        <table className={sort === 'mc' ? 'tbl by-mc' : 'tbl'}>
          <caption className="sr-only">
            {sort === 'mc'
              ? `${title}, ranked by market cap`
              : sort === 'gainers'
                ? `${title}, biggest 24h price rise first`
                : sort === 'losers'
                  ? `${title}, biggest 24h price fall first`
                  : variant === 'trending'
                ? `${title}, ranked by 24h volume`
                : `${title}, ranked by fee yield over the trailing 7 days`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col" className="r hide-mc" aria-sort={sort === 'mc' ? 'descending' : undefined}>
                MC
              </th>
              <th
                scope="col"
                className="r"
                aria-sort={sort === 'gainers' ? 'descending' : sort === 'losers' ? 'ascending' : undefined}
              >
                24h
              </th>
              <th scope="col" className="r metric">
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
            {rows.map(({ pool, others }, i) => (
              <Row
                key={pool.id}
                pool={pool}
                others={others.length}
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
  others,
  rank,
  leader,
  variant,
  registerRef,
  onOpen,
}: {
  pool: Pool;
  /** How many more pools this token has in the view; the row is its deepest. */
  others: number;
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
            <span className="n">
              {pool.token.symbol}
              {others > 0 && (
                <span
                  className="pill grey pools-n"
                  title={`${pool.token.symbol} trades in ${others + 1} pools. This row is the deepest; open it to see all of them.`}
                >
                  +{others} {others === 1 ? 'pool' : 'pools'}
                </span>
              )}
            </span>
            <span className="s" title={pool.token.name}>
              {pool.token.name}
            </span>
          </span>
        </button>
      </td>
      <td
        className={`r num hide-mc${pool.marketCapUsd > 0 && !mcRanked(pool) ? ' muted' : ''}`}
        title={
          pool.marketCapUsd <= 0
            ? 'No token supply read yet, so there is no figure to show.'
            : !mcRanked(pool)
              ? pool.tvlUsd > 0
                ? `Priced from a pool with only ${usd(pool.tvlUsd)} of depth: a few dollars move this price, ` +
                  'so this figure is shown but not ranked with the others.'
                : 'The depth of the pool behind this price is unknown, so this figure is shown but not ranked with the others.'
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
      <FlashTd className="r" text={pool.change24hPct === null ? '—' : pool.change24hPct.toFixed(1)}>
        <Change pct={pool.change24hPct} refHours={pool.change24hRefHours} />
      </FlashTd>

      {variant === 'trending' ? (
        <FlashTd className="r num metric" text={usd(pool.fees24hUsd)} />
      ) : (
        <FlashTd
          className={`r num metric${pool.feeYield.basis === 'insufficient' ? ' muted' : ' up'}`}
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
