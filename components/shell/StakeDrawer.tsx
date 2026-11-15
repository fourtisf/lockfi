'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useStakeForm } from '@/hooks/useStakeForm';
import { signingStatus } from '@/lib/contracts/status';
import { ageLabel, usd } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { DATA_SOURCE } from '@/lib/data';
import { poolsOfToken } from '@/lib/pools';
import {
  FEE_YIELD_LABEL,
  VAULT_YIELD_NOTE,
  feeYieldQualifier,
  feeYieldReason,
  feeYieldTitle,
  feeYieldValue,
} from '@/lib/yield';
import { feeTierLabel, feeTokensLabel, isDynamicFee, pairLabel, poolContracts } from '@/lib/pair';
import { CopyAddress } from '@/components/ui/CopyAddress';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StakeDrawer() {
  const { pools, vaults } = useMarket();
  const { stakePoolId, closeStake, openStake } = useUi();
  const router = useRouter();
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  const pool = pools.find((p) => p.id === stakePoolId) ?? null;
  const open = pool !== null;
  const form = useStakeForm(pool);
  // Staking needs a vault to stake into. In the simulator that is one of its
  // generated vaults (six pools of ten); live, it is a vault and the zap
  // deployed on chain (config/deployments.json) — nothing else signs.
  const vaultHere = pool !== null ? (vaults.find((v) => v.poolId === pool.id) ?? null) : null;
  const hasVault = vaultHere !== null;
  const vaultPools = new Set(vaults.map((v) => v.poolId));
  const canStake =
    pool !== null && (form.mode === 'live' || (form.mode === 'preview' && pool.stakeable && hasVault));
  // No vault anywhere is not a missing vault for this pool: staking itself has
  // not launched.
  const stakingLaunched = vaults.length > 0 || signingStatus().vaults.length > 0;
  // The token's pools, deepest first. The board shows one row per token, so
  // this is where its other pools are found (lib/pools.ts).
  const siblings = pool ? poolsOfToken(pools, pool) : [];
  // The pools that do have a vault, deepest first: where a stake can go
  // when this pool has none.
  const openVaults = vaults
    .map((v) => pools.find((p) => p.id === v.poolId))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && p.id !== pool?.id)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
  // Exactly the note's "no vault for this pool" case — not a pool still on its
  // launchpad curve, nor one with no ETH side — while other vaults are open.
  const noVaultHere =
    pool !== null &&
    !canStake &&
    stakingLaunched &&
    pool.stakeable &&
    form.closedReason !== 'no-eth-side' &&
    openVaults.length > 0;

  // Escape closes, Tab cycles inside, focus returns where it came from.
  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    const node = drawerRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStake();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusTo.current?.focus();
    };
  }, [open, closeStake]);

  const enoughData = pool?.feeYield.basis !== 'insufficient';
  // The same sum the stake panel does (lib/stake.ts, through useStakeForm):
  // weekly fees from the trailing window, after the protocol's cut — the
  // same fee the disclosure below prints, read from the vault when live.
  const share = form.quote?.share ?? 0;

  return (
    <>
      <div
        className={`overlay${open ? ' on' : ''}`}
        onClick={closeStake}
        aria-hidden="true"
      />
      <aside
        className={`drawer${open ? ' on' : ''}`}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={pool ? `Stake ${pairLabel(pool)}` : 'Stake'}
        aria-hidden={!open}
      >
        {pool && (
          <>
            <div className="dr-h">
              <TokenBadge token={pool.token} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {pairLabel(pool)}
                </div>
                <div style={{ fontSize: 12 }} className="muted">
                  {pool.token.name}
                </div>
              </div>
              <button className="x" onClick={closeStake} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="dr-b">
              {/* What a person copies to check or buy: the pool's token
                  contracts (native ETH has none) and its vault, if any. */}
              <div className="dr-ca" aria-label="Contract addresses">
                {poolContracts(pool).map((c) => (
                  <CopyAddress key={c.address} label={c.symbol} address={c.address} />
                ))}
                {vaultHere && <CopyAddress label={`${BRAND} vault`} address={vaultHere.address} />}
              </div>
              <div className="kv">
                <div>
                  {/* §1's label, once — it used to sit above and below the figure. */}
                  <div className="k" title={hasVault && DATA_SOURCE === 'live' ? VAULT_YIELD_NOTE : undefined}>
                    {FEE_YIELD_LABEL.charAt(0).toUpperCase() + FEE_YIELD_LABEL.slice(1)}
                    {hasVault && DATA_SOURCE === 'live' ? ' · pool average' : ''}
                  </div>
                  <div
                    className={`v num${enoughData ? ' up' : ' muted'}`}
                    title={feeYieldTitle(pool.feeYield)}
                  >
                    {feeYieldValue(pool.feeYield)}
                    {feeYieldQualifier(pool.feeYield, ageLabel(pool.ageHours)) && (
                      <span className="est">
                        {feeYieldQualifier(pool.feeYield, ageLabel(pool.ageHours))}
                      </span>
                    )}
                    {feeYieldReason(pool.feeYield) && <span className="est">{feeYieldReason(pool.feeYield)}</span>}
                  </div>
                </div>
                <div>
                  <div className="k">Fees 24h</div>
                  <div className="v num">{usd(pool.fees24hUsd)}</div>
                </div>
                <div>
                  <div className="k">Pool depth</div>
                  <div className="v num">{usd(pool.tvlUsd)}</div>
                </div>
                <div>
                  <div className="k">Volume 24h</div>
                  <div className="v num">{usd(pool.volume24hUsd)}</div>
                </div>
              </div>

              {!canStake && (
                <div className="note dr-why">
                  {!stakingLaunched ? (
                    <>
                      <b>Staking isn&rsquo;t open yet</b>
                      <p className="hint">
                        {BRAND}&rsquo;s vaults — the contracts that hold a stake and pay it a share
                        of the pool&rsquo;s fees — are not deployed yet. Until they are, this shows
                        each pool&rsquo;s real trading, fees and depth, read from the chain. Nothing
                        can be deposited yet.
                      </p>
                    </>
                  ) : form.closedReason === 'no-eth-side' ? (
                    <>
                      <b>Not enterable with ETH</b>
                      <p className="hint">
                        This pool&rsquo;s {BRAND} vault exists, but the pool has no ETH side, and this
                        form stakes ETH. Nothing can be staked into it from here yet.
                      </p>
                    </>
                  ) : !pool.stakeable ? (
                    <>
                      <b>Not stakeable yet</b>
                      <p className="hint">
                        {pool.token.symbol} is still on its {pool.token.launchpad ?? 'launchpad'} curve.
                        Pre-graduation liquidity is indexed here but cannot be staked until the pool
                        graduates.
                      </p>
                    </>
                  ) : (
                    <>
                      <b>No vault for this pool yet — staking is open on {openVaults.length === 1 ? 'this pool' : 'these'}:</b>
                      <p className="hint">
                        A stake goes into a {BRAND} vault, and a vault is deployed per pool.{' '}
                        {pairLabel(pool)} has none yet, so nothing can be staked here — the figures
                        above are the pool&rsquo;s own.
                      </p>
                      <div className="dr-vaults">
                        {openVaults.map((p) => (
                          <button key={p.id} className="btn btn-ghost" onClick={() => openStake(p.id)}>
                            <TokenBadge token={p.token} /> {pairLabel(p)} · {feeTierLabel(p)} fee
                            <span className="muted"> {feeYieldValue(p.feeYield)}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {siblings.length > 1 && (
                <div className="dr-pools">
                  <div className="k">
                    {pool.token.symbol} trades in {siblings.length} pools · deepest first
                  </div>
                  <p className="hint dr-pools-why">
                    Anyone can open a pool for a token, with its own trading fee and its own pair
                    (ETH or USDG). Each pool is a separate market with its own liquidity — so its
                    own trading, fees and yield. A higher fee earns more on each trade but usually
                    draws less trading. Tap one to see it.
                  </p>
                  <div className="dr-pools-head" aria-hidden="true">
                    <span>Pool · fee</span>
                    <span>Depth</span>
                    <span>Fee yield 7d</span>
                  </div>
                  {siblings.slice(0, 8).map((p) => (
                    <button
                      key={p.id}
                      aria-current={p.id === pool.id}
                      onClick={() => openStake(p.id)}
                    >
                      <span className="dr-pool-name">
                        <b>{pairLabel(p)}</b>
                        <span
                          className="pill grey"
                          title={isDynamicFee(p) ? 'Dynamic fee: set by the pool’s hook on every swap' : `Trading fee ${feeTierLabel(p)}`}
                        >
                          {feeTierLabel(p)}
                        </span>
                        {vaultPools.has(p.id) && <span className="pill brand">Vault</span>}
                      </span>
                      <span className="num">{usd(p.tvlUsd)}</span>
                      <span className="num" title={feeYieldTitle(p.feeYield)}>
                        {feeYieldValue(p.feeYield)}
                        {p.feeYield.basis === 'estimate' && <span className="est-inline"> est.</span>}
                        {feeYieldReason(p.feeYield) && <span className="sr-only"> — {feeYieldReason(p.feeYield)}</span>}
                      </span>
                    </button>
                  ))}
                  {siblings.length > 8 && (
                    <p className="hint">and {siblings.length - 8} smaller pools</p>
                  )}
                  {siblings.some((p) => p.feeYield.basis === 'insufficient') && (
                    <p className="hint">&ldquo;—&rdquo; means a pool has under 24 hours of fees, or its depth is not known yet: too little for an honest yield figure.</p>
                  )}
                  {siblings.some((p) => p.feeYield.basis === 'estimate') && (
                    <p className="hint">&ldquo;est.&rdquo; marks a pool younger than 7 days: its yield is worked out from the hours it has, not a full week.</p>
                  )}
                </div>
              )}

              {canStake ? (
                <>
                  <div className="sect-h" style={{ display: 'block', marginBottom: 12 }}>
                    Stake with one token
                  </div>
                  <div className="field">
                    <label htmlFor="stake-amount" className="sr-only">
                      Amount to stake in ETH
                    </label>
                    <div className="inp">
                      <input
                        id="stake-amount"
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
                    <p className="hint">{form.minLabel}</p>
                  </div>

                  <div className="note">
                    <div className="disclose">
                      <span className="muted">Your share of pool</span>
                      <b className="num">{(share * 100).toFixed(2)}%</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Est. weekly fees · from trailing 7d</span>
                      <b className="num">{form.weeklyLabel ?? '—'}</b>
                    </div>
                    {/* §7: the protocol fee is disclosed here, before signing —
                        live, as the vault itself reports it. */}
                    <div className="disclose">
                      <span className="muted">{BRAND} fee</span>
                      <b className="num">
                        {form.feeLabel}
                      </b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Lockup</span>
                      <b>None</b>
                    </div>
                  </div>

                  <p className="hint" style={{ marginTop: 12 }}>
                    {form.mode === 'live' && (
                      <>
                        Fees are credited the moment they&rsquo;re earned — claim any time in{' '}
                        {feeTokensLabel(pool)}. Leaving never forfeits fees already earned.{' '}
                      </>
                    )}
                    Your position stays withdrawable by your wallet only. If the token drops, the
                    value of your stake drops with it — fees soften that, they don&rsquo;t remove
                    it.
                  </p>
                </>
              ) : null}
            </div>

            {!canStake ? (
              <p className="dr-f-why">
                {!stakingLaunched
                  ? `Staking opens when ${BRAND} vaults launch.`
                  : form.closedReason === 'no-eth-side'
                    ? 'This pool has no ETH side to stake with.'
                    : noVaultHere
                      ? `No vault for ${pairLabel(pool)} — stake in an open vault instead.`
                      : 'No vault to stake into for this pool yet.'}
              </p>
            ) : form.problem && (form.mode === 'preview' || form.walletStatus === 'ready') ? (
              <p className={`dr-f-why${form.quiet ? '' : ' down'}`} role={form.quiet ? undefined : 'alert'}>
                {form.problem}
              </p>
            ) : null}
            {canStake && form.mode === 'live' && <AuditNotice className="dr-audit" />}
            <div className="dr-f">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  closeStake();
                  router.push('/positions');
                }}
              >
                Build custom
              </button>
              {canStake && form.mode === 'live' ? (
                <SignGate>
                  <button className="btn btn-brand" disabled={!form.canSubmit} onClick={() => void form.submit()}>
                    {form.busy ? 'Staking…' : 'Stake'}
                  </button>
                </SignGate>
              ) : (
                // A pool with no vault while others have one: the main button
                // takes you to the vaults that exist, rather than sitting grey.
                noVaultHere ? (
                  <button
                    className="btn btn-brand"
                    onClick={() => {
                      closeStake();
                      router.push('/stakes');
                    }}
                  >
                    Go to open vaults
                  </button>
                ) : (
                <button
                  className="btn btn-brand"
                  disabled={!canStake || !form.canSubmit}
                  title={!canStake ? undefined : (form.problem ?? undefined)}
                  onClick={() => {
                    void form.submit();
                    closeStake();
                  }}
                >
                  Stake
                </button>
                )
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
