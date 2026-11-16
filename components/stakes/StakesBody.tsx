'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useActions } from '@/hooks/useActions';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useStakeForm } from '@/hooks/useStakeForm';
import { signingStatus } from '@/lib/contracts/status';
import type { Pool, Quote, Vault } from '@/lib/data/types';
import { FEE_DIGITS, ageLabel, count, inHours, signedPct, tone, usd, usdExact, usdFee, weth } from '@/lib/format';
import { weekOverWeek } from '@/lib/portfolio';
import { BRAND } from '@/lib/site';
import { dailyFromHalfDays } from '@/lib/stake';
import { DATA_SOURCE } from '@/lib/data';
import { claimableLabel, hasClaimable, totalClaimableUsd, walletTotals } from '@/lib/wallet/portfolio';
import { useWalletHistory } from '@/hooks/useWalletHistory';
import {
  FEE_YIELD_LABEL,
  YIELD_WINDOW_HOURS,
  feeYieldQualifier,
  feeYieldTitle,
  feeYieldValue,
  yieldPct,
  VAULT_YIELD_NOTE,
} from '@/lib/yield';
import { feeTierLabel, feeTokensLabel, pairLabel, poolContracts } from '@/lib/pair';
import { CopyAddress } from '@/components/ui/CopyAddress';
import { StakeFields, StakeOutputs } from '@/components/stakes/StakeFields';
import { liveAgeLabel, vaultView } from '@/lib/vault-view';
import { useNow } from '@/hooks/useNow';

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
  const now = useNow();

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
      // §1: every ranking defaults to fee yield — the vault's own when it
      // has been read live, the pool's otherwise. No figure ranks last.
      .sort((a, b) => yieldPct(vaultView(b.vault, b.pool).yield) - yieldPct(vaultView(a.vault, a.pool).yield));
  }, [vaults, pools, filter, query]);

  const selected = rows.find((r) => r.vault.id === picked) ?? rows[0] ?? null;
  // Pin the first choice: the rows re-rank on every snapshot (two vaults a
  // fraction of a point apart swap places), and an unpinned panel would jump
  // to the other vault and clear what was typed.
  const shown = selected?.vault.id ?? null;
  useEffect(() => {
    if (picked === null && shown !== null) setPicked(shown);
  }, [picked, shown]);

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
            <span className="k">
              ranked by fee yield · fees per day, last 7 days
              {(() => {
                // How old the vaults' live read is, said once for the list.
                const read = rows.find((r) => r.vault.live);
                const age = read ? liveAgeLabel(vaultView(read.vault, read.pool, now)) : null;
                return age ? <> · <span className={age.startsWith('as of') ? 'down' : undefined}>{age.replace('live', 'read from the chain')}</span></> : null;
              })()}
            </span>
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
                <span title={LIVE ? VAULT_YIELD_NOTE : undefined}>
                  {rows.some((r) => r.vault.live) ? 'Your fee yield' : LIVE ? 'Pool fee yield' : 'Fee yield'}
                </span>
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
              <SamePairNote pools={rows.map((r) => r.pool)} />
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
  const v = vaultView(vault, pool, null);
  const y = v.yield;
  const qualifier = feeYieldQualifier(y, ageLabel(y.basis === 'estimate' ? y.windowHours : pool.ageHours));
  const none = y.basis === 'insufficient';
  const days = dailyFromHalfDays(v.feeHistory);
  const max = Math.max(...days, 1);

  return (
    <button className="vault" aria-pressed={selected} onClick={onChoose}>
      <span className="tok">
        <TokenBadge token={pool.token} />
        <span style={{ minWidth: 0 }}>
          <b>
            {pairLabel(pool)}
            {/* "New" means what Established's 7d+ means: under a full week. */}
            {v.young ? <span className="pill grey">New</span> : null}
          </b>
          <small>{feeTierLabel(pool)} fee pool</small>
        </span>
      </span>
      <span className={`apr num${none ? ' none' : ''}`} title={v.live ? v.yieldTitle : feeYieldTitle(y)}>
        {feeYieldValue(y)}
        {qualifier && <span className="est">{qualifier}</span>}
        <small>{v.live ? v.yieldLabel : FEE_YIELD_LABEL}</small>
        {v.live && v.poolYield.basis !== 'insufficient' && (
          // The pool's average, beside the vault's own, so the gap is seen.
          <small className="muted" title="The whole pool's average: most of its liquidity is concentrated near the price">
            pool avg {feeYieldValue(v.poolYield)}
          </small>
        )}
      </span>
      <span>
        <span className="days" aria-hidden="true">
          {days.map((d, i) => (
            <i key={i} style={{ height: `${Math.max(10, (d / max) * 100)}%` }} />
          ))}
        </span>
        <small className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
          <span className="num">{usd(v.fees24hUsd)}</span> in 24h
        </small>
      </span>
      <span className="cell">
        {usd(v.stakedUsd)}
        {/* The staker count comes from the indexer's reading of the vault's
            events; the amount, from the chain directly. While the indexer is
            behind, the count can say 0 beside a stake that exists. */}
        <small>{vault.stakers === 0 && v.stakedUsd > 0 ? 'stakers not read yet' : `${count(vault.stakers)} stakers`}</small>
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

/**
 * Two vaults on one pair look like a mistake — "ETH / USDG" twice, with
 * different numbers. They are two pools: one pair can trade in several, each
 * with its own trading fee, its own liquidity and its own trading, and a
 * vault adds to and earns from its own pool only.
 */
function SamePairNote({ pools }: { pools: Pool[] }) {
  const byPair = new Map<string, Pool[]>();
  for (const p of pools) byPair.set(pairLabel(p), [...(byPair.get(pairLabel(p)) ?? []), p]);
  const repeated = [...byPair.entries()].filter(([, ps]) => ps.length > 1);
  if (repeated.length === 0) return null;
  return (
    <p className="hint vlist-note">
      {repeated.map(([pair, ps]) => (
        <span key={pair}>
          <b>
            {ps.length === 2 ? 'Two' : ps.length === 3 ? 'Three' : ps.length} {pair} vaults
          </b>{' '}
          — the same pair in {ps.length === 2 ? 'two' : ps.length === 3 ? 'three' : ps.length} separate pools, at a{' '}
          {ps.map((p) => feeTierLabel(p)).join(' and a ')} trading fee.{' '}
        </span>
      ))}
      Each pool is its own market, with its own liquidity, trading and fees, and each vault
      adds to and earns from its own pool only — so their figures differ. Either can be
      withdrawn at any time.
    </p>
  );
}

/** What you have, before what you could have. */
function Earnings() {
  const { vaults, global, pools } = useMarket();
  const { act } = useUi();
  const symbolOf = (poolId: string) => {
    const p = pools.find((x) => x.id === poolId);
    return p ? pairLabel(p) : 'vault';
  };
  const { portfolio, source, stakes: walletStakes } = usePortfolio();
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const stakes = portfolio.stakes;
  const fromWallet = source === 'wallet';
  // Fees earned, all time: claimed (the vaults' own events) plus claimable,
  // at today's prices — the same sum the portfolio shows.
  const { history, failed: historyFailed } = useWalletHistory();
  const liveCurrencies = new Map(vaults.filter((v) => v.live).map((v) => [v.poolId.toLowerCase(), v.live!.currencies]));
  const earned = fromWallet && history ? walletTotals(history.vaults, walletStakes, liveCurrencies).feesEarnedUsd : Number.NaN;
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
                <div className="v num">{Number.isFinite(claimableUsd) ? usdFee(claimableUsd) : '—'}</div>
                <div className="s num">
                  {walletStakes.length === 1
                    ? claimableLabel(walletStakes[0])
                    : walletStakes.length === 0
                      ? 'nothing staked yet'
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
        <div className="k">{fromWallet ? 'Fees earned' : 'Your fees · last 7d'}</div>
        {fromWallet ? (
          // Unknown until the history is read: an em dash, never a $0 that
          // would say nothing was earned.
          <>
            <div className={`v num ${Number.isFinite(earned) ? tone(earned, FEE_DIGITS) : 'muted'}`}>
              {Number.isFinite(earned) ? usdFee(earned) : '—'}
            </div>
            <div className="s">
              {Number.isFinite(earned)
                ? 'claimed plus claimable, all time'
                : history === null
                  ? historyFailed
                    ? 'history could not be read — retrying'
                    : 'reading your history…'
                  : 'a pool is not priced yet'}
            </div>
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
  const { vaults } = useMarket();
  const vault = vaults.find((v) => v.poolId === pool.id);
  const live = form.mode === 'live';
  const v = form.view;
  const now = useNow();
  const age = vault && v?.live ? liveAgeLabel(vaultView(vault, pool, now)) : null;
  const y = v?.yield ?? pool.feeYield;
  const button = (
    <button className="btn btn-brand go" disabled={!form.canSubmit} onClick={() => void form.submit()}>
      {form.busy ? 'Staking…' : `Stake ${pairLabel(pool)}`}
    </button>
  );

  return (
    <aside className="card spanel" aria-label={`Stake ${pairLabel(pool)}`}>
      <h2>
        <TokenBadge token={pool.token} /> Stake {pairLabel(pool)} · {feeTierLabel(pool)}
      </h2>
      {vault && (
        <div className="spanel-ca">
          <CopyAddress label={`${BRAND} vault`} address={vault.address} />
          {poolContracts(pool).map((c) => (
            <CopyAddress key={c.address} label={c.symbol} address={c.address} />
          ))}
        </div>
      )}
      <div className="sub" title={v?.yieldTitle}>
        <span className={y.basis === 'insufficient' ? 'num' : 'num up'}>
          {feeYieldValue(y)}
        </span>{' '}
        {v?.live ? `your fee yield · ${v.yieldLabel}` : (v?.yieldLabel ?? FEE_YIELD_LABEL)}
        {v?.live ? (
          <span className="muted">
            {' '}
            · full range{v.poolYield.basis !== 'insufficient' && <> · pool avg {feeYieldValue(v.poolYield)}</>}
          </span>
        ) : (
          LIVE && (
            <span className="muted" title={VAULT_YIELD_NOTE}>
              {' '}
              (pool average)
            </span>
          )
        )}{' '}
        · {usd(v?.fees24hUsd ?? pool.fees24hUsd)} fees 24h
        {age && <span className={age.startsWith('as of') ? 'down' : 'muted'}> · {age}</span>}
      </div>

      <StakeFields form={form} idPrefix="sp" />
      <StakeOutputs form={form} />

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
              <b>Claim</b>Any time, in {feeTokensLabel(pool)}. Leaving never forfeits fees already earned.
            </li>
            <li>
              <b>Withdraw</b>All or part, any time, from Your stakes or the Portfolio. No lockup, no exit fee.
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
        <p className="note-s">No {BRAND} vault contract is deployed for this pool yet, so nothing can be staked.</p>
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
