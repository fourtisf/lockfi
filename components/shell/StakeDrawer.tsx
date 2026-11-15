'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { PROTOCOL_FEE_BPS } from '@/lib/chain';
import { ageLabel, usd, weth } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { poolsOfToken } from '@/lib/pools';
import { stakeQuote } from '@/lib/stake';
import { FEE_YIELD_LABEL, feeYieldQualifier, feeYieldReason, feeYieldTitle, feeYieldValue } from '@/lib/yield';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StakeDrawer() {
  const { pools, vaults, global, portfolio } = useMarket();
  const { stakePoolId, closeStake, openStake, act } = useUi();
  const router = useRouter();
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const [amount, setAmount] = useState('1');

  const pool = pools.find((p) => p.id === stakePoolId) ?? null;
  const open = pool !== null;
  // Staking needs a vault to stake into. The live site has none until the
  // contracts ship, and the simulator has them for six pools of ten — the
  // drawer used to offer a stake form for every pool regardless.
  const hasVault = pool !== null && vaults.some((v) => v.poolId === pool.id);
  const canStake = pool !== null && pool.stakeable && hasVault;
  // No vault anywhere is not a missing vault for this pool: staking itself has
  // not launched (the contracts are P2, and §8 puts an audit before mainnet).
  const stakingLaunched = vaults.length > 0;
  const balance = portfolio.walletBalanceEth;
  // The token's pools, deepest first. The board shows one row per token, so
  // this is where its other pools are found (lib/pools.ts).
  const siblings = pool ? poolsOfToken(pools, pool) : [];

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

  const eth = Number.parseFloat(amount) || 0;
  const enoughData = pool?.feeYield.basis !== 'insufficient';
  // The same sum the stake panel does (lib/stake.ts): weekly fees from the
  // trailing window, after the protocol's cut, which the disclosure below
  // reads from the same constant.
  const quote = pool ? stakeQuote(pool, eth, global.ethPriceUsd) : null;
  const share = quote?.share ?? 0;
  const weeklyWeth = quote?.weeklyWeth ?? null;

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
        aria-label={pool ? `Stake ${pool.token.symbol}` : 'Stake'}
        aria-hidden={!open}
      >
        {pool && (
          <>
            <div className="dr-h">
              <TokenBadge token={pool.token} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {pool.token.symbol} / {pool.quote === 'USDG' ? 'USDG' : 'WETH'}
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
              <div className="kv">
                <div>
                  {/* §1's label, once — it used to sit above and below the figure. */}
                  <div className="k">
                    {FEE_YIELD_LABEL.charAt(0).toUpperCase() + FEE_YIELD_LABEL.slice(1)}
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
                        of the pool&rsquo;s fees — are still being built, and none goes live before an
                        independent security audit. Until then this shows each pool&rsquo;s real
                        trading, fees and depth, read from the chain. Nothing can be deposited yet.
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
                      <b>No vault for this pool yet</b>
                      <p className="hint">
                        Staking into {pool.token.symbol} opens when its {BRAND} vault is deployed.
                        The figures above are the pool&rsquo;s own; nothing can be staked here yet.
                      </p>
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
                    (WETH or USDG). Each pool is a separate market with its own liquidity — so its
                    own trading, fees and yield. A higher fee earns more on each trade but usually
                    draws less trading. Tap one to see it.
                  </p>
                  <div className="dr-pools-head" aria-hidden="true">
                    <span>Fee · pair</span>
                    <span>Depth</span>
                    <span>Fee yield 7d</span>
                  </div>
                  {siblings.slice(0, 8).map((p) => (
                    <button
                      key={p.id}
                      aria-current={p.id === pool.id}
                      onClick={() => openStake(p.id)}
                    >
                      <span className="muted">
                        {(p.feeTierBps / 100).toFixed(2)}% fee · {p.protocol}
                        {p.quote === 'USDG' ? ' · USDG' : ''}
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
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                      <span className="unit">ETH</span>
                      {balance !== null && <span className="max">Max {balance}</span>}
                    </div>
                  </div>

                  <div className="note">
                    <div className="disclose">
                      <span className="muted">Your share of pool</span>
                      <b className="num">{(share * 100).toFixed(2)}%</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Est. weekly fees · from trailing 7d</span>
                      <b className="num">{weeklyWeth === null ? '—' : weth(weeklyWeth)}</b>
                    </div>
                    {/* §7: the protocol fee is disclosed here, before signing. */}
                    <div className="disclose">
                      <span className="muted">{BRAND} fee</span>
                      <b className="num">{PROTOCOL_FEE_BPS / 100}% of fees earned</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Lockup</span>
                      <b>None</b>
                    </div>
                  </div>

                  <p className="hint" style={{ marginTop: 12 }}>
                    Your position stays withdrawable by your wallet only. If the token drops, the
                    value of your stake drops with it — fees soften that, they don&rsquo;t remove
                    it.
                  </p>
                </>
              ) : null}
            </div>

            {!canStake && (
              <p className="dr-f-why">
                {!stakingLaunched ? `Staking opens when ${BRAND} vaults launch, after an audit.` : 'No vault to stake into for this pool yet.'}
              </p>
            )}
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
              <button
                className="btn btn-brand"
                disabled={!canStake || balance === null}
                title={
                  !canStake ? undefined : balance === null ? 'Connect a wallet to stake' : undefined
                }
                onClick={() => {
                  act('Staking');
                  closeStake();
                }}
              >
                Stake
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
