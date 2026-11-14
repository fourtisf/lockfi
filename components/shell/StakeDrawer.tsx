'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { PROTOCOL_FEE_BPS } from '@/lib/chain';
import { ageLabel, usd, weth } from '@/lib/format';
import { FEE_YIELD_LABEL, feeYieldQualifier, feeYieldTitle, feeYieldValue } from '@/lib/yield';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StakeDrawer() {
  const { pools, global } = useMarket();
  const { stakePoolId, closeStake, act } = useUi();
  const router = useRouter();
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const [amount, setAmount] = useState('1');

  const pool = pools.find((p) => p.id === stakePoolId) ?? null;
  const open = pool !== null;

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
  const depositUsd = eth * global.ethPriceUsd;
  const share = pool ? depositUsd / (pool.tvlUsd + depositUsd) : 0;
  const enoughData = pool?.feeYield.basis !== 'insufficient';
  // Weekly fees, after the protocol's cut, from the trailing window only. The
  // cut and its disclosure below read the same constant, so they cannot drift.
  const lpShare = 1 - PROTOCOL_FEE_BPS / 10_000;
  const weeklyWeth = pool
    ? ((pool.feesWindowUsd * (168 / pool.feeWindowHours)) * share * lpShare) / global.ethPriceUsd
    : 0;

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
                <div style={{ fontWeight: 600, fontSize: 14 }}>{pool.token.symbol} / WETH</div>
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

              {pool.stakeable ? (
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
                      <span className="max">Max 4.18</span>
                    </div>
                  </div>

                  <div className="note">
                    <div className="disclose">
                      <span className="muted">Your share of pool</span>
                      <b className="num">{(share * 100).toFixed(2)}%</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Est. weekly fees · from trailing 7d</span>
                      <b className="num">{enoughData ? weth(weeklyWeth) : '—'}</b>
                    </div>
                    {/* §7: the protocol fee is disclosed here, before signing. */}
                    <div className="disclose">
                      <span className="muted">Balast fee</span>
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
              ) : (
                <div className="note">
                  <b>Not stakeable yet</b>
                  <p className="hint">
                    {pool.token.symbol} is still on its {pool.token.launchpad ?? 'launchpad'} curve.
                    Pre-graduation liquidity is indexed here but cannot be staked until the pool
                    graduates.
                  </p>
                </div>
              )}
            </div>

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
                disabled={!pool.stakeable}
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
