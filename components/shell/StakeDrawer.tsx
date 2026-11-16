'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useStakeForm } from '@/hooks/useStakeForm';
import { mintAvailability, signingStatus } from '@/lib/contracts/status';
import { ageLabel, price, usd } from '@/lib/format';
import { Change } from '@/components/ui/Change';
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
import { StakeFields, StakeOutputs } from '@/components/stakes/StakeFields';
import { liveAgeLabel, vaultView } from '@/lib/vault-view';
import { useNow } from '@/hooks/useNow';

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
  // A vault is per pool, and a token trades in many: the one with a vault may
  // be another of this token's pools. Then the token CAN be staked — there.
  const vaultSibling = siblings.find((p) => p.id !== pool?.id && vaultPools.has(p.id)) ?? null;
  // A stakeable pool with no vault, while staking has launched: either the
  // token's vault is on another pool (above), or the token has none at all.
  const noVaultHere = pool !== null && !canStake && stakingLaunched && pool.stakeable;
  const tokenHasNoVault = noVaultHere && vaultSibling === null;
  // Where a token with no vault can still be added by hand: the deepest of
  // its pools the shaper can mint into (a v4 pool with an ETH side). That is
  // the token the person clicked — not the ETH / USDG vaults, which are a
  // different pair, and which this drawer used to send them to.
  const mintPool =
    pool === null
      ? null
      : DATA_SOURCE === 'live'
        ? (siblings.find((p) => p.stakeable && mintAvailability(p).ok) ?? null)
        : pool;
  const positionsHref = (p: { id: string } | null) =>
    p ? `/positions?pool=${encodeURIComponent(p.id)}` : '/positions';
  const vaultPairs = [...new Set(openVaults.map((p) => pairLabel(p)))];

  // closeStake is rebuilt whenever a toast or the search changes; the trap
  // below must not re-run for that — it moved focus to the close button on
  // every toast, mid-typing — so it reads the latest one through a ref.
  const closeRef = useRef(closeStake);
  closeRef.current = closeStake;

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
        closeRef.current();
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
  }, [open]);

  // A vault read live shows its own figures (lib/vault-view.ts): what its
  // full-range position earned, and its pool's fees today. Otherwise the
  // pool's row, labelled as the pool's average.
  const v = form.view;
  const headYield = v?.yield ?? pool?.feeYield ?? null;
  const enoughData = headYield !== null && headYield.basis !== 'insufficient';
  const now = useNow();
  // The traded token's live price and move, when it is the vault pool's
  // priced side (ETH on ETH/USDG).
  const headLive = (() => {
    const l = vaultHere?.live;
    if (!l || !pool) return null;
    const i = l.currencies.findIndex(
      (c) => c.address === pool.token.address.toLowerCase() || (pool.token.symbol === 'WETH' && c.symbol === 'ETH'),
    );
    const p = i >= 0 ? l.currencies[i].priceUsd : null;
    if (p === null || i < 0) return null;
    const change = l.change24hPct === null ? null : i === 0 ? l.change24hPct : (1 / (1 + l.change24hPct / 100) - 1) * 100;
    return { price: p, change };
  })();
  const age = pool && vaultHere?.live ? liveAgeLabel(vaultView(vaultHere, pool, now)) : null;

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
                {/* The token's own move, the figure a trader looks for first:
                    its price and 24h change, then its valuation. */}
                <div className="dr-price">
                  {/* A vault's pool read live: today's price and move, not the
                      snapshot's, which is as of the indexer's last swap read. */}
                  {headLive ? (
                    <>
                      <b className="num">{price(headLive.price)}</b>
                      <Change pct={headLive.change} />
                      <span className="muted">24h · live</span>
                    </>
                  ) : (
                    <>
                      <b className="num">{pool.priceUsd > 0 ? price(pool.priceUsd) : '—'}</b>
                      <Change pct={pool.change24hPct} refHours={pool.change24hRefHours} />
                      <span className="muted">24h</span>
                    </>
                  )}
                  {pool.marketCapUsd > 0 && (
                    <span className="muted">
                      · FDV <span className="num">{usd(pool.marketCapUsd)}</span>
                    </span>
                  )}
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
                  {v?.live ? (
                    <div className="k" title={v.yieldTitle}>
                      Your fee yield · trailing 7d
                    </div>
                  ) : (
                    <div className="k" title={hasVault && DATA_SOURCE === 'live' ? VAULT_YIELD_NOTE : undefined}>
                      {FEE_YIELD_LABEL.charAt(0).toUpperCase() + FEE_YIELD_LABEL.slice(1)}
                      {hasVault && DATA_SOURCE === 'live' ? ' · pool average' : ''}
                    </div>
                  )}
                  <div
                    className={`v num${enoughData ? ' up' : ' muted'}`}
                    title={v?.live ? v.yieldTitle : feeYieldTitle(pool.feeYield)}
                  >
                    {headYield && feeYieldValue(headYield)}
                    {v?.live ? (
                      <span className="est kv-note">
                        full range · after {vaultHere!.protocolFeeBps / 100}% fee
                        {v.poolYield.basis !== 'insufficient' && <> · pool avg {feeYieldValue(v.poolYield)}</>}
                      </span>
                    ) : (
                      <>
                        {feeYieldQualifier(pool.feeYield, ageLabel(pool.feeYield.basis === 'estimate' ? pool.feeYield.windowHours : pool.ageHours)) && (
                          <span className="est">
                            {feeYieldQualifier(pool.feeYield, ageLabel(pool.feeYield.basis === 'estimate' ? pool.feeYield.windowHours : pool.ageHours))}
                          </span>
                        )}
                        {feeYieldReason(pool.feeYield) && <span className="est">{feeYieldReason(pool.feeYield)}</span>}
                      </>
                    )}
                  </div>
                </div>
                <div>
                  <div className="k">Fees 24h</div>
                  <div className="v num">{usd(v?.fees24hUsd ?? pool.fees24hUsd)}</div>
                  {age && <span className={`est kv-note${age.startsWith('as of') ? ' down' : ''}`}>{age}</span>}
                </div>
                <div>
                  <div className="k">Pool depth</div>
                  <div className="v num">{usd(pool.tvlUsd)}</div>
                </div>
                <div>
                  <div className="k">Volume 24h</div>
                  <div className="v num">{usd(v?.volume24hUsd ?? pool.volume24hUsd)}</div>
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
                  ) : !pool.stakeable ? (
                    <>
                      <b>Not stakeable yet</b>
                      <p className="hint">
                        {pool.token.symbol} is still on its {pool.token.launchpad ?? 'launchpad'} curve.
                        Pre-graduation liquidity is indexed here but cannot be staked until the pool
                        graduates.
                      </p>
                    </>
                  ) : vaultSibling ? (
                    <>
                      <b>
                        {pool.token.symbol} is staked through its {pairLabel(vaultSibling)} ·{' '}
                        {feeTierLabel(vaultSibling)} pool
                      </b>
                      <p className="hint">
                        A {BRAND} vault is deployed per pool, and {pool.token.symbol}&rsquo;s is on
                        its {pairLabel(vaultSibling)} · {feeTierLabel(vaultSibling)} pool. The one
                        shown here, {pairLabel(pool)} · {feeTierLabel(pool)}, is a separate pool
                        with its own liquidity and fees, and has no vault.
                      </p>
                      <div className="dr-vaults">
                        <button className="btn btn-ghost" onClick={() => openStake(vaultSibling.id)}>
                          <TokenBadge token={vaultSibling.token} /> Stake in {pairLabel(vaultSibling)} ·{' '}
                          {feeTierLabel(vaultSibling)} fee
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <b>{pool.token.symbol} has no {BRAND} vault yet</b>
                      <p className="hint">
                        A stake goes into a {BRAND} vault, and a vault is deployed per pool
                        {vaultPairs.length > 0 ? <> — so far only for {vaultPairs.join(', ')}</> : null}.
                        Until {pool.token.symbol} has one, it cannot be staked here. The figures
                        above are its pool&rsquo;s own, read from the chain.
                      </p>
                      {mintPool && (
                        <p className="hint">
                          <b>You can still add {pool.token.symbol} liquidity yourself.</b> On
                          Positions, one ETH deposit becomes a Uniswap v4 position in{' '}
                          {pairLabel(mintPool)} · {feeTierLabel(mintPool)}, minted to your wallet. It
                          earns that pool&rsquo;s fees while the price stays inside the range you
                          choose. It is yours to manage from your wallet; the {BRAND} portfolio
                          does not list it yet.
                        </p>
                      )}
                      {openVaults.length > 0 && (
                        <>
                          <p className="hint">
                            Or stake in an open vault — a different pair, not {pool.token.symbol}:
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
                    </>
                  )}
                </div>
              )}

              {/* Folded by default, as the drawer was before a token had a
                  list: one token, its figures, and staking. The list is there
                  for whoever wants another of the token's pools. */}
              {siblings.length > 1 && (
                <details className="dr-pools">
                  <summary>
                    Showing {pairLabel(pool)} · {feeTierLabel(pool)} fee — {pool.token.symbol} trades in{' '}
                    {siblings.length} pools. <span className="dr-pools-more">See all</span>
                  </summary>
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
                    <p className="hint">&ldquo;—&rdquo; means under 24 hours of fees have been read for a pool, or its depth is not known yet: too little for an honest yield figure.</p>
                  )}
                  {siblings.some((p) => p.feeYield.basis === 'estimate') && (
                    <p className="hint">&ldquo;est.&rdquo; marks under 7 days of fees — a pool younger than a week, or one not yet read for a full week: its yield is worked out from the hours there are.</p>
                  )}
                </details>
              )}

              {canStake ? (
                <>
                  <div className="sect-h" style={{ display: 'block', marginBottom: 12 }}>
                    Stake
                  </div>
                  <StakeFields form={form} idPrefix="stake" />
                  {/* §7: the protocol fee is disclosed here, before signing —
                      live, as the vault itself reports it. */}
                  <StakeOutputs form={form} />

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
                  : vaultSibling && noVaultHere
                    ? `${pool.token.symbol} stakes through its ${pairLabel(vaultSibling)} · ${feeTierLabel(vaultSibling)} pool.`
                    : tokenHasNoVault
                      ? mintPool
                        ? `${pool.token.symbol} has no vault yet — add its liquidity yourself, or stake in an open vault.`
                        : `${pool.token.symbol} has no vault yet.`
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
                  router.push(positionsHref(mintPool));
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
                // A pool with no vault: the main button goes where this token
                // CAN go — its vault's pool, or adding its liquidity by hand —
                // and only failing both, to the vaults that exist.
                vaultSibling && noVaultHere ? (
                  <button className="btn btn-brand" onClick={() => openStake(vaultSibling.id)}>
                    Stake {pool.token.symbol}
                  </button>
                ) : tokenHasNoVault && mintPool ? (
                  <button
                    className="btn btn-brand"
                    onClick={() => {
                      closeStake();
                      router.push(positionsHref(mintPool));
                    }}
                  >
                    Add {pool.token.symbol} liquidity
                  </button>
                ) : tokenHasNoVault && openVaults.length > 0 ? (
                  <button
                    className="btn btn-brand"
                    onClick={() => {
                      closeStake();
                      router.push('/stakes');
                    }}
                  >
                    See open vaults
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
