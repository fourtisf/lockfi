'use client';

import { useMemo, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useActions } from '@/hooks/useActions';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useStakeForm } from '@/hooks/useStakeForm';
import { signingStatus } from '@/lib/contracts/status';
import type { Pool, Quote, Vault } from '@/lib/data/types';
import { ageLabel, count, inHours, signedPct, tone, usd, usdExact, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';
import { BRAND } from '@/lib/site';
import { dailyFromHalfDays } from '@/lib/stake';
import { DATA_SOURCE } from '@/lib/data';
import { claimableLabel, hasClaimable, totalClaimableUsd } from '@/lib/wallet/portfolio';
import {
  FEE_YIELD_LABEL,
  YIELD_WINDOW_HOURS,
  feeYieldQualifier,
  feeYieldTitle,
  feeYieldValue,
  yieldPct,
  VAULT_YIELD_NOTE,
} from '@/lib/yield';

const FILTERS: { id: 'all' | Quote; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ETH', label: 'ETH' },
  { id: 'USDG', label: 'USDG' },
];

/** Real vaults (live) pay per share as fees are collected; the simulator still rehearses the stream. */
const LIVE = DATA_SOURCE === 'live';

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
      {/* With no vault to choose there is no stake panel, and the list takes the row. */}
      <div className={`st-cols${selected ? '' : ' solo'}`}>
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
          {vaults.length === 0 ? (
            // Not "no match": there is nothing to match. The live site has no
            // vault until the contracts ship, and saying "try a ticker" sent
            // people looking for a search they never made.
            signingStatus().vaults.length > 0 ? (
              // Deployed, but the indexer has not reported them yet: say that,
              // not that they do not exist.
              <div className="empty">
                <b>Vaults are deployed</b>
                Their figures appear here once the indexer has read them. The pools are live:
                their real fee yield is on the Pools page.
              </div>
            ) : (
              <div className="empty">
                <b>No vaults yet</b>
                {BRAND}&rsquo;s vault contracts are not deployed, so there is nothing to stake into
                yet. The pools are live: their real fee yield is on the Pools page.
              </div>
            )
          ) : rows.length === 0 ? (
            <div className="empty">
              {query.trim() !== '' ? (
                <>
                  <b>No vault matches</b>Try a ticker, or clear the search.
                </>
              ) : (
                <>
                  <b>No {filter} vaults</b>None of the vaults trade against it yet.
                </>
              )}
            </div>
          ) : (
            <div className="vlist">
              <div className="vhead" aria-hidden="true">
                <span>Pool</span>
                <span title={LIVE ? VAULT_YIELD_NOTE : undefined}>{LIVE ? 'Pool fee yield' : 'Fee yield'}</span>
                <span>Fees, 7 days</span>
                <span>Staked</span>
                <span>{LIVE ? 'Payouts' : 'Harvest'}</span>
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
      {LIVE ? (
        // Real vaults credit fees per share as they are collected: there is
        // no harvest to count down to.
        <span className="cell">
          any time
          <small>as fees are collected</small>
        </span>
      ) : (
        <span className="cell">
          {inHours(vault.nextHarvestInSeconds)}
          <small>next harvest</small>
        </span>
      )}
    </button>
  );
}

/** What you have, before what you could have. */
function Earnings() {
  const { vaults, global, pools } = useMarket();
  const { act } = useUi();
  const symbolOf = (poolId: string) => pools.find((p) => p.id === poolId)?.token.symbol ?? 'vault';
  const { portfolio, source, stakes: walletStakes } = usePortfolio();
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const stakes = portfolio.stakes;
  const fromWallet = source === 'wallet';
  // A stake the indexer cannot price makes the total unknown, not smaller.
  const staked = stakes.some((s) => !Number.isFinite(s.stakedUsd))
    ? Number.NaN
    : stakes.reduce((a, s) => a + s.stakedUsd, 0);
  const wow = weekOverWeek(portfolio.dailyFeesWeth);
  const harvests = stakes
    .map((s) => vaults.find((v) => v.id === s.vaultId || v.poolId === s.poolId)?.nextHarvestInSeconds)
    .filter((v): v is number => v !== undefined);
  const nextHarvest = harvests.length ? Math.min(...harvests) : null;
  const claimable = portfolio.claimableWeth;
  const claimTargets = walletStakes.filter(hasClaimable);
  const claimableUsd = totalClaimableUsd(walletStakes);

  const claimAll = async () => {
    if (!fromWallet) {
      act('Claiming');
      return;
    }
    setBusy(true);
    try {
      await actions.claimAll(
        claimTargets.map((s) => ({ vault: s.vault, symbol: symbolOf(s.poolId) })),
      );
    } finally {
      setBusy(false);
    }
  };
  const claimButton = (
    <button
      className="btn btn-brand btn-sm"
      disabled={(fromWallet ? claimTargets.length === 0 : claimable <= 0) || busy}
      onClick={() => void claimAll()}
      title={fromWallet && claimTargets.length > 1 ? `${claimTargets.length} transactions, one per vault` : undefined}
    >
      {busy ? 'Claiming…' : 'Claim all'}
    </button>
  );

  return (
    <section className="card earn" aria-label="Your earnings">
      <div>
        <div className="k">Claimable now</div>
        <div className="split">
          <div>
            {fromWallet ? (
              // Vaults pay in both of a pool's tokens: the total in dollars,
              // and the tokens themselves underneath.
              <>
                <div className="v num">{Number.isFinite(claimableUsd) ? usdExact(claimableUsd, 2) : '—'}</div>
                <div className="s num">
                  {walletStakes.length === 1
                    ? claimableLabel(walletStakes[0])
                    : `${walletStakes.length} stakes · each in both its pool's tokens`}
                </div>
              </>
            ) : (
              <>
                <div className="v num">{weth(claimable)}</div>
                <div className="s num">
                  {global.ethPriceUsd > 0 ? usdExact(claimable * global.ethPriceUsd) : '—'} · {stakes.length}{' '}
                  {stakes.length === 1 ? 'stake' : 'stakes'}
                </div>
              </>
            )}
          </div>
          {fromWallet && claimTargets.length > 0 ? <SignGate className="btn btn-brand btn-sm">{claimButton}</SignGate> : claimButton}
        </div>
        {fromWallet && claimTargets.length > 0 && <AuditNotice />}
      </div>
      <div>
        <div className="k">Your fees · last 7d</div>
        {fromWallet ? (
          // The wallet's payout history is not read from the chain yet. A $0
          // here would claim it earned nothing.
          <>
            <div className="v num muted">—</div>
            <div className="s">payout history is not read yet</div>
          </>
        ) : (
          <>
            <div className={`v num ${tone(portfolio.fees7dUsd)}`}>{usdExact(portfolio.fees7dUsd)}</div>
            {stakes.length === 0 ? (
              <div className="s">nothing staked yet</div>
            ) : wow.changePct !== null ? (
              <div className={`s num ${tone(wow.changePct, 1)}`}>
                {signedPct(wow.changePct)} vs the week before
              </div>
            ) : (
              <div className="s">first week</div>
            )}
          </>
        )}
      </div>
      <div>
        <div className="k">Staked</div>
        <div className="v num">{Number.isFinite(staked) ? usdExact(staked) : '—'}</div>
        <div className="s">{Number.isFinite(staked) ? 'withdraw any time, no fee' : 'a pool is not priced yet'}</div>
      </div>
      {LIVE ? (
        <div>
          <div className="k">Payouts</div>
          <div className="v">Any time</div>
          <div className="s">fees are credited the moment they&rsquo;re earned; leaving never forfeits fees already earned</div>
        </div>
      ) : (
        <div>
          <div className="k">Next harvest</div>
          <div className="v num">{nextHarvest === null ? '—' : inHours(nextHarvest)}</div>
          <div className="s">then it streams to you over 7 days</div>
        </div>
      )}
    </section>
  );
}

function StakePanel({ pool }: { pool: Pool }) {
  const form = useStakeForm(pool);
  const shares = [0.25, 0.5, 0.75, 1];
  const live = form.mode === 'live';
  const button = (
    <button className="btn btn-brand go" disabled={!form.canSubmit} onClick={() => void form.submit()}>
      {form.busy ? 'Staking…' : `Stake ${pool.token.symbol}`}
    </button>
  );

  return (
    <aside className="card spanel" aria-label={`Stake ${pool.token.symbol}`}>
      <h2>
        <TokenBadge token={pool.token} /> Stake {pool.token.symbol} / WETH
      </h2>
      <div className="sub">
        <span className={pool.feeYield.basis === 'insufficient' ? 'num' : 'num up'}>
          {feeYieldValue(pool.feeYield)}
        </span>{' '}
        {FEE_YIELD_LABEL}
        {LIVE && (
          <span className="muted" title={VAULT_YIELD_NOTE}>
            {' '}
            (pool average)
          </span>
        )}{' '}
        · {usd(pool.fees24hUsd)} fees 24h
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
          inputMode="decimal"
          placeholder="0.0"
          value={form.amount}
          onChange={(e) => form.setAmount(e.target.value)}
        />
        <span className="unit">ETH</span>
        {form.maxLabel !== null && (
          <button type="button" className="max" onClick={() => form.setShare(1)}>
            Max {form.maxLabel}
          </button>
        )}
      </div>
      {/* Shares of a balance need a balance: no wallet, no chips. */}
      {form.maxLabel !== null && (
        <div className="quick" role="group" aria-label="Share of balance">
          {shares.map((f) => (
            <button key={f} onClick={() => form.setShare(f)}>
              {f === 1 ? 'Max' : `${f * 100}%`}
            </button>
          ))}
        </div>
      )}
      <p className="note-s" style={{ textAlign: 'left' }}>
        {form.minLabel}
      </p>

      <div className="out">
        <div>
          {/* Arithmetic on the amount typed, which needs no wallet. */}
          <span>Your share of pool</span>
          <b>{((form.quote?.share ?? 0) * 100).toFixed(2)}%</b>
        </div>
        <div>
          <span>Est. weekly fees · from trailing 7d</span>
          <b>{form.weeklyLabel ?? '—'}</b>
        </div>
        {/* §7: the protocol fee is disclosed here, before anything is signed —
            live, as the vault itself reports it. */}
        <div>
          <span>{BRAND} fee</span>
          <b>{form.feeLabel}</b>
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
        {LIVE ? (
          <ol>
            <li>
              <b>Earn</b>Fees are credited to every share the moment they&rsquo;re earned.
            </li>
            <li>
              <b>Claim</b>Any time, in ETH and {pool.token.symbol}. Leaving never forfeits fees already earned.
            </li>
            <li>
              <b>Compound</b>Claim, then stake the ETH side back in: two signatures.
            </li>
          </ol>
        ) : (
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
        )}
      </div>

      {live ? <SignGate className="btn btn-brand go">{button}</SignGate> : button}
      {form.mode === 'closed' ? (
        <p className="note-s">
          {form.closedReason === 'no-eth-side'
            ? 'This pool has no ETH side, and this form stakes ETH, so nothing can be staked from here.'
            : `No ${BRAND} vault contract is deployed for this pool yet, so nothing can be staked.`}
        </p>
      ) : form.problem && (!live || form.walletStatus === 'ready') ? (
        <p className={`note-s${form.quiet ? '' : ' down'}`} role={form.quiet ? undefined : 'alert'}>
          {form.problem}
        </p>
      ) : !live ? (
        <p className="note-s">Preview: the simulator&rsquo;s pools are not on chain, so nothing is sent.</p>
      ) : null}
      {live && <AuditNotice className="center" />}
    </aside>
  );
}
