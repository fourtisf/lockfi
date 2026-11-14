'use client';

import { useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { usd, usdExact } from '@/lib/format';
import { BRAND } from '@/lib/site';

type Trigger = 'cadence' | 'milestone';
interface Milestone {
  id: number;
  marketCap: string;
  sharePct: string;
}

let nextId = 3;

export function RouterPanel() {
  const { router } = useMarket();
  const { act } = useUi();
  const [trigger, setTrigger] = useState<Trigger>('cadence');
  const [destination, setDestination] = useState<'full' | 'narrow'>('full');
  const [milestones, setMilestones] = useState<Milestone[]>([
    { id: 1, marketCap: '5,000,000', sharePct: '50' },
    { id: 2, marketCap: '10,000,000', sharePct: '75' },
  ]);

  const numeric = milestones.map((m) => Number(m.marketCap.replace(/[^0-9.]/g, '')) || 0);
  // Milestones fire once each, in ascending order — out of order is rejected at
  // config time, not at route time (§3.5).
  const ascending = numeric.every((v, i) => i === 0 || v > numeric[i - 1]);
  const blocked = trigger === 'milestone' && !ascending;

  return (
    <div className="router">
      <div className="card panel">
        <div className="field">
          <label htmlFor="r-token">Your token</label>
          <div className="inp" style={{ height: 44 }}>
            <input
              id="r-token"
              defaultValue={router.tokenSymbol}
              placeholder="0x… or ticker"
              style={{ fontSize: 15 }}
            />
            <span className="pill up">Verified deployer</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="r-source">Fee source</label>
          <div className="inp" style={{ height: 44 }}>
            <input
              id="r-source"
              value={router.feeSourceAddress}
              readOnly
              style={{ fontSize: 14, fontWeight: 500 }}
            />
            <span className="max">Change</span>
          </div>
          <p className="hint">
            Creator fee share · accrued so far{' '}
            <span className="num">
              {router.accruedWeth.toFixed(2)} WETH · {usdExact(router.accruedUsd)}
            </span>
          </p>
        </div>

        <div className="field">
          <span className="lbl" id="r-trigger-label">
            Trigger
          </span>
          <div className="toggle" role="group" aria-labelledby="r-trigger-label">
            <button
              className={trigger === 'cadence' ? 'on' : undefined}
              aria-pressed={trigger === 'cadence'}
              onClick={() => setTrigger('cadence')}
            >
              Every 24h
            </button>
            <button
              className={trigger === 'milestone' ? 'on' : undefined}
              aria-pressed={trigger === 'milestone'}
              onClick={() => setTrigger('milestone')}
            >
              Market-cap milestones
            </button>
          </div>
        </div>

        {trigger === 'milestone' && (
          <div className="field">
            <span className="lbl">Milestones</span>
            {milestones.map((m, i) => (
              <div className="milestone" key={m.id}>
                <div className="inp">
                  <label className="sr-only" htmlFor={`ms-mc-${m.id}`}>
                    Milestone {i + 1} market cap
                  </label>
                  <input
                    id={`ms-mc-${m.id}`}
                    value={m.marketCap}
                    onChange={(e) =>
                      setMilestones((prev) =>
                        prev.map((x) => (x.id === m.id ? { ...x, marketCap: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="unit">$ MC</span>
                </div>
                <div className="inp">
                  <label className="sr-only" htmlFor={`ms-pct-${m.id}`}>
                    Milestone {i + 1} share of fees
                  </label>
                  <input
                    id={`ms-pct-${m.id}`}
                    value={m.sharePct}
                    onChange={(e) =>
                      setMilestones((prev) =>
                        prev.map((x) => (x.id === m.id ? { ...x, sharePct: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="unit">% of fees</span>
                </div>
                <button
                  className="rm"
                  aria-label={`Remove milestone ${i + 1}`}
                  onClick={() => setMilestones((prev) => prev.filter((x) => x.id !== m.id))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                setMilestones((prev) => [
                  ...prev,
                  { id: nextId++, marketCap: '', sharePct: '50' },
                ])
              }
            >
              Add milestone
            </button>
            {!ascending && (
              <p className="hint down">
                Milestones must ascend. Each one fires once, in order — the contract rejects an
                out-of-order list at config time.
              </p>
            )}
          </div>
        )}

        <div className="field">
          <span className="lbl" id="r-dest-label">
            Where it goes
          </span>
          <div className="toggle" role="group" aria-labelledby="r-dest-label">
            <button
              className={destination === 'full' ? 'on' : undefined}
              aria-pressed={destination === 'full'}
              onClick={() => setDestination('full')}
            >
              Full range
            </button>
            <button
              className={destination === 'narrow' ? 'on' : undefined}
              aria-pressed={destination === 'narrow'}
              onClick={() => setDestination('narrow')}
            >
              ±20% around price
            </button>
          </div>
          <p className="hint">
            Full range never goes out of position. Narrow adds more depth where traders actually
            are.
          </p>
        </div>

        <button
          className="btn btn-brand"
          style={{ width: '100%', justifyContent: 'center', height: 46 }}
          disabled={blocked}
          onClick={() => act('Enabling the router')}
        >
          Enable router
        </button>
      </div>

      <div className="card panel">
        <h2 className="sect-h">What happens next</h2>
        <div className="timeline">
          <div className="tl">
            <div className="w">
              Today<small>on enable</small>
            </div>
            <div>
              The router contract holds the fee stream. Nothing moves yet.
              <div className="st">You can pause or withdraw unrouted fees at any time.</div>
            </div>
          </div>
          <div className="tl">
            <div className="w">
              {trigger === 'cadence' ? 'Every 24h' : 'At each milestone'}
              <small>keeper</small>
            </div>
            <div>
              Accrued WETH is split, half swapped to {router.tokenSymbol} at{' '}
              {router.twapMinutes}-min TWAP, both sides added to the pool.
              <div className="st">
                Est. first route: {router.firstRouteWeth.toFixed(2)} WETH → +
                {usd(router.firstRouteDepthUsd)} depth
              </div>
            </div>
          </div>
          <div className="tl">
            <div className="w">Ongoing</div>
            <div>
              Pool depth compounds. Slippage on a $5K buy drops from{' '}
              {router.slippageNowPct.toFixed(1)}% to an estimated{' '}
              {router.slippageLaterPct.toFixed(1)}% after 30 days at current fee rate.
            </div>
          </div>
          <div className="tl">
            <div className="w">Always</div>
            <div>
              Every route is a public transaction. Holders can verify on the explorer that fees
              became liquidity.
            </div>
          </div>
        </div>

        {/* §3.4: routed liquidity is permanent. Say so, before they enable it. */}
        <div className="note" style={{ marginTop: 8 }}>
          <b>Routed liquidity is permanent.</b>
          <p className="hint">
            Once fees become pool depth they cannot be withdrawn — not by you, not by {BRAND}, not by
            anyone. Pausing stops future routes and releases only fees that have not been routed
            yet. The keeper can trigger a route but never receives funds, and the destination pool
            cannot be changed.
          </p>
        </div>

        <div className="note" style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Projected depth · 90 days
          </div>
          {/* Geometry only; the two figures sit under it in HTML, so neither is
              drawn over the curve or squashed to nothing on a phone. */}
          <svg
            className="proj"
            viewBox="0 0 400 110"
            preserveAspectRatio="none"
            style={{ width: '100%', display: 'block' }}
            role="img"
            aria-label={`Projected pool depth rising from ${usd(
              router.currentDepthUsd,
            )} to about ${usd(router.projectedDepthUsd)} over 90 days`}
          >
            <defs>
              <linearGradient id="router-depth" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--ac)" stopOpacity=".22" />
                <stop offset="1" stopColor="var(--ac)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d="M0 95 C60 92,110 80,160 66 S260 34,320 22 S380 10,400 8 L400 110 L0 110Z"
              fill="url(#router-depth)"
            />
            <path
              d="M0 95 C60 92,110 80,160 66 S260 34,320 22 S380 10,400 8"
              fill="none"
              stroke="var(--ac)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="proj-axis">
            <span>
              Now <b className="num">{usd(router.currentDepthUsd)}</b>
            </span>
            <span>
              Day 90 <b className="num">≈ {usd(router.projectedDepthUsd)}</b>
            </span>
          </div>
          <p className="hint">
            Projection at the current fee rate. If volume slows, depth grows slower.
          </p>
        </div>
      </div>
    </div>
  );
}
