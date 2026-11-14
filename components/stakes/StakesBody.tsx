'use client';

import { useMemo, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { PROTOCOL_FEE_BPS } from '@/lib/chain';
import type { Pool, Quote, Vault } from '@/lib/data/types';
import { ageLabel, count, inHours, signedPct, usd, usdExact, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';
import { BRAND } from '@/lib/site';
import { PREVIEW_BALANCE_ETH, dailyFromHalfDays, depositProblem, stakeQuote } from '@/lib/stake';
import {
  FEE_YIELD_LABEL,
  YIELD_WINDOW_HOURS,
  feeYieldQualifier,
  feeYieldTitle,
  feeYieldValue,
  yieldPct,
} from '@/lib/yield';

const FILTERS: { id: 'all' | Quote; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ETH', label: 'ETH' },
  { id: 'USDG', label: 'USDG' },
];

/** Below this the stake panel has no room, and a row opens the drawer instead. */
const PANEL_MEDIA = '(max-width: 980px)';

/**
 * The Stakes page body (§19): your earnings first, then every vault ranked by
 * fee yield with its last seven days of fees, and the stake form beside the
 * list rather than in a drawer, so comparing vaults and sizing a deposit
 * happen on one screen.
 */
export function StakesBody() {
  const { vaults, pools } = useMarket();
  const { query, openStake } = useUi();
  const [filter, setFilter] = useState<'all' | Quote>('all');
  const [picked, setPicked] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vaults
      .map((vault) => ({ vault, pool: pools.find((p) => p.id === vault.poolId) }))
      .filter((r): r is { vault: Vault; pool: Pool } => r.pool !== undefined)
      .filter(({ pool }) => filter === 'all' || pool.quote === filter)
      .filter(
        ({ pool }) =>
          q === '' ||
          pool.token.symbol.toLowerCase().includes(q) ||
          pool.token.name.toLowerCase().includes(q),
      )
      // §1: every ranking defaults to fee yield. No figure ranks last.
      .sort((a, b) => yieldPct(b.pool.feeYield) - yieldPct(a.pool.feeYield));
  }, [vaults, pools, filter, query]);

  const selected = rows.find((r) => r.vault.id === picked) ?? rows[0] ?? null;

  const choose = (vault: Vault, pool: Pool) => {
    if (typeof window !== 'undefined' && window.matchMedia(PANEL_MEDIA).matches) openStake(pool.id);
    else setPicked(vault.id);
  };

  return (
    <>
      <Earnings />
      <div className="st-cols">
        <section className="card">
          <div className="lh">
            <h2 className="sect-h">Vaults</h2>
            <span className="k">ranked by fee yield · fees per day, last 7 days</span>
            <div className="seg" role="group" aria-label="Vault quote filter" style={{ marginLeft: 'auto' }}>
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
          {rows.length === 0 ? (
            <div className="empty">
              <b>No vault matches</b>Try a ticker, or clear the search.
            </div>
          ) : (
            <div className="vlist">
              <div className="vhead" aria-hidden="true">
                <span>Pool</span>
                <span>Fee yield</span>
                <span>Fees, 7 days</span>
                <span>Staked</span>
                <span>Harvest</span>
              </div>
              {rows.map(({ vault, pool }) => (
                <VaultRow
                  key={vault.id}
                  vault={vault}
                  pool={pool}
                  selected={selected?.vault.id === vault.id}
                  onChoose={() => choose(vault, pool)}
                />
              ))}
            </div>
          )}
        </section>
        {selected && <StakePanel pool={selected.pool} />}
      </div>
    </>
  );
}

function VaultRow({
  vault,
  pool,
  selected,
  onChoose,
}: {
  vault: Vault;
  pool: Pool;
  selected: boolean;
  onChoose: () => void;
}) {
  const qualifier = feeYieldQualifier(pool.feeYield, ageLabel(pool.ageHours));
  const none = pool.feeYield.basis === 'insufficient';
  const days = dailyFromHalfDays(pool.feeHistory);
  const max = Math.max(...days, 1);

  return (
    <button className="vault" aria-pressed={selected} onClick={onChoose}>
      <span className="tok">
        <TokenBadge token={pool.token} />
        <span style={{ minWidth: 0 }}>
          <b>
            {pool.token.symbol} / WETH
            {/* "New" means what Established's 7d+ means: under a full week. */}
            {pool.quote === 'USDG' ? (
              <span className="pill grey">Stock</span>
            ) : pool.ageHours < YIELD_WINDOW_HOURS ? (
              <span className="pill grey">New</span>
            ) : null}
          </b>
          <small>{pool.token.name}</small>
        </span>
      </span>
      <span className={`apr num${none ? ' none' : ''}`} title={feeYieldTitle(pool.feeYield)}>
        {feeYieldValue(pool.feeYield)}
        {qualifier && <span className="est">{qualifier}</span>}
        <small>{FEE_YIELD_LABEL}</small>
      </span>
      <span>
        <span className="days" aria-hidden="true">
          {days.map((d, i) => (
            <i key={i} style={{ height: `${Math.max(10, (d / max) * 100)}%` }} />
          ))}
        </span>
        <small className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
          <span className="num">{usd(pool.fees24hUsd)}</span> in 24h
        </small>
      </span>
      <span className="cell">
        {usd(vault.totalStakedUsd)}
        <small>{count(vault.stakers)} stakers</small>
      </span>
      <span className="cell">
        {inHours(vault.nextHarvestInSeconds)}
        <small>next harvest</small>
      </span>
    </button>
  );
}

/** What you have, before what you could have. */
function Earnings() {
  const { portfolio, vaults, global } = useMarket();
  const { act } = useUi();
  const stakes = portfolio.stakes;
  const staked = stakes.reduce((a, s) => a + s.stakedUsd, 0);
  const wow = weekOverWeek(portfolio.dailyFeesWeth);
  const harvests = stakes
    .map((s) => vaults.find((v) => v.id === s.vaultId)?.nextHarvestInSeconds)
    .filter((v): v is number => v !== undefined);
  const nextHarvest = harvests.length ? Math.min(...harvests) : null;

  return (
    <section className="card earn" aria-label="Your earnings">
      <div>
        <div className="k">Claimable now</div>
        <div className="split">
          <div>
            <div className="v num">{weth(portfolio.claimableWeth)}</div>
            <div className="s num">
              {usdExact(portfolio.claimableWeth * global.ethPriceUsd)} · {stakes.length}{' '}
              {stakes.length === 1 ? 'stake' : 'stakes'}
            </div>
          </div>
          <button
            className="btn btn-brand btn-sm"
            disabled={portfolio.claimableWeth <= 0}
            onClick={() => act('Claiming')}
          >
            Claim all
          </button>
        </div>
      </div>
      <div>
        <div className="k">Your fees · last 7d</div>
        <div className="v num up">{usdExact(portfolio.fees7dUsd)}</div>
        {wow.changePct !== null ? (
          <div className={`s num ${wow.changePct >= 0 ? 'up' : 'down'}`}>
            {signedPct(wow.changePct)} vs the week before
          </div>
        ) : (
          <div className="s">first week</div>
        )}
      </div>
      <div>
        <div className="k">Staked</div>
        <div className="v num">{usdExact(staked)}</div>
        <div className="s">withdraw any time, no fee</div>
      </div>
      <div>
        <div className="k">Next harvest</div>
        <div className="v num">{nextHarvest === null ? '—' : inHours(nextHarvest)}</div>
        <div className="s">then it streams to you over 7 days</div>
      </div>
    </section>
  );
}

function StakePanel({ pool }: { pool: Pool }) {
  const { global } = useMarket();
  const { act } = useUi();
  const [amount, setAmount] = useState('1');
  const eth = Number.parseFloat(amount);
  const problem = depositProblem(eth);
  const quote = stakeQuote(pool, problem ? 0 : eth, global.ethPriceUsd);
  const shares = [0.25, 0.5, 0.75, 1];

  return (
    <aside className="card spanel" aria-label={`Stake ${pool.token.symbol}`}>
      <h2>
        <TokenBadge token={pool.token} /> Stake {pool.token.symbol} / WETH
      </h2>
      <div className="sub">
        <span className={pool.feeYield.basis === 'insufficient' ? 'num' : 'num up'}>
          {feeYieldValue(pool.feeYield)}
        </span>{' '}
        {FEE_YIELD_LABEL} · {usd(pool.fees24hUsd)} fees 24h
      </div>

      <label htmlFor="sp-amount" className="sr-only">
        Amount to stake in ETH
      </label>
      <div className="inp">
        <input
          id="sp-amount"
          type="number"
          min="0"
          step="0.1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <span className="unit">ETH</span>
        <span className="max">Max {PREVIEW_BALANCE_ETH}</span>
      </div>
      <div className="quick" role="group" aria-label="Share of balance">
        {shares.map((f) => {
          const value = (PREVIEW_BALANCE_ETH * f).toFixed(2);
          return (
            <button
              key={f}
              className={Number(amount) === Number(value) ? 'on' : undefined}
              onClick={() => setAmount(value)}
            >
              {f === 1 ? 'Max' : `${f * 100}%`}
            </button>
          );
        })}
      </div>

      <div className="out">
        <div>
          <span>Your share of pool</span>
          <b>{(quote.share * 100).toFixed(2)}%</b>
        </div>
        <div>
          <span>Est. weekly fees · from trailing 7d</span>
          <b>{quote.weeklyWeth === null ? '—' : weth(quote.weeklyWeth)}</b>
        </div>
        {/* §7: the protocol fee is disclosed here, before anything is signed. */}
        <div>
          <span>{BRAND} fee</span>
          <b>{PROTOCOL_FEE_BPS / 100}% of fees earned</b>
        </div>
        <div>
          <span>Lockup</span>
          <b>None</b>
        </div>
      </div>

      <div className="drip">
        <div className="k" style={{ fontSize: 12.5, color: 'var(--fg-3)', fontWeight: 600 }}>
          How you get paid
        </div>
        <ol>
          <li>
            <b>Harvest</b>Swap fees are collected every few hours.
          </li>
          <li>
            <b>Stream</b>Each harvest drips to stakers over 7 days.
          </li>
          <li>
            <b>Claim</b>Claim or compound whenever you like.
          </li>
        </ol>
      </div>

      <button className="btn btn-brand go" disabled={problem !== null} onClick={() => act('Staking')}>
        Stake {pool.token.symbol}
      </button>
      {problem ? (
        <p className="note-s down" role="alert">
          {problem}
        </p>
      ) : (
        <p className="note-s">Preview: no transaction is sent until wallets arrive in P2.</p>
      )}
    </aside>
  );
}
