'use client';

import { useMemo, useState } from 'react';
import { formatEther, zeroAddress, zeroHash } from 'viem';
import { useReadContract } from 'wagmi';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useActions } from '@/hooks/useActions';
import { CHAIN, CONTRACTS } from '@/lib/chain';
import { deploymentFor } from '@/lib/contracts/deployments';
import {
  ROUTER_DEFAULTS,
  buildRouterConfig,
  fullRange,
  hasOneEthSide,
  hookCanTakeLiquidity,
  usdToWethWei,
} from '@/lib/contracts/router';
import { shapeToTickBins } from '@/lib/contracts/shaped';
import { explorerAddress, v4PoolId } from '@/lib/contracts/tx';
import { stateViewAbi } from '@/lib/contracts/uniswap';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool } from '@/lib/data/types';
import { shortWallet, usd, usdExact } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { feeTierLabel, pairLabel } from '@/lib/pair';

type Trigger = 'cadence' | 'milestone';
interface Milestone {
  id: number;
  marketCap: string;
}

type Address = `0x${string}`;

let nextId = 3;

const LIVE = DATA_SOURCE === 'live';
/** The narrow destination: ±20% of the token's price, fixed at creation. */
const NARROW_PCT = 20;

/** Pools a router can route into: v4, a key, exactly one ETH side. */
function routable(p: Pool): boolean {
  return p.key !== undefined && v4PoolId(p.id) !== null && hasOneEthSide(p.key);
}

function wethLabel(wei: bigint): string {
  const n = Number(formatEther(wei));
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

export function RouterPanel() {
  const { router, pools, global } = useMarket();
  const { act } = useUi();
  const actions = useActions();
  const [trigger, setTrigger] = useState<Trigger>('cadence');
  const [destination, setDestination] = useState<'full' | 'narrow'>('full');
  const [milestones, setMilestones] = useState<Milestone[]>([
    { id: 1, marketCap: '5,000,000' },
    { id: 2, marketCap: '10,000,000' },
  ]);
  const [tokenQuery, setTokenQuery] = useState(router.tokenSymbol === '—' ? '' : router.tokenSymbol);
  const [pickedPool, setPickedPool] = useState<string | null>(null);
  const [slippage, setSlippage] = useState<string>(ROUTER_DEFAULTS.maxSlippagePct);
  const [twapGuard, setTwapGuard] = useState<string>(ROUTER_DEFAULTS.twapDeviationPct);
  const [minRoute, setMinRoute] = useState<string>(ROUTER_DEFAULTS.minRouteEth);
  const [maxRoute, setMaxRoute] = useState<string>(ROUTER_DEFAULTS.maxRouteEth);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ address: Address; symbol: string } | null>(null);

  const numeric = milestones.map((m) => Number(m.marketCap.replace(/[^0-9.]/g, '')) || 0);
  // Milestones fire once each, in ascending order — out of order is rejected at
  // config time, not at route time (§3.5).
  const ascending = numeric.every((v, i) => i === 0 || v > numeric[i - 1]);
  const blocked = trigger === 'milestone' && !ascending;
  // Estimates need a fee stream to estimate from. Before one accrues they
  // were "0.00 WETH → +$0" and a curve that rose anyway.
  const flowing = router.accruedWeth > 0;
  const grows = flowing && router.projectedDepthUsd > router.currentDepthUsd;

  // ------------------------------------------------------------- live ----
  const factory = LIVE ? (deploymentFor(CHAIN.id)?.routerFactory ?? null) : null;
  const signing = factory !== null;

  // The token's routable pools, deepest first. Matched by exact address, or
  // by ticker — which a copycat can share, so the address is always shown.
  const q = tokenQuery.trim().toLowerCase();
  const candidates = useMemo(() => {
    if (!signing || q === '') return [];
    return pools
      .filter((p) => (q.startsWith('0x') ? p.token.address.toLowerCase() === q : p.token.symbol.toLowerCase() === q))
      .filter(routable)
      .sort((a, b) => b.tvlUsd - a.tvlUsd);
  }, [signing, pools, q]);
  const eligible = candidates.filter((p) => !hookCanTakeLiquidity(p.key!.hooks));
  const pool = eligible.find((p) => p.id === pickedPool) ?? eligible[0] ?? null;

  // The keeper that will trigger routes: Tidewell's, as recorded in
  // config/deployments.json. It only triggers; it never receives funds.
  const recorded = deploymentFor(CHAIN.id)?.keeper ?? null;
  const keeper = recorded && recorded.toLowerCase() !== zeroAddress ? recorded : null;

  // The narrow range is fixed around today's price, so it needs that price.
  const poolId = pool ? v4PoolId(pool.id) : null;
  const slot0 = useReadContract({
    address: CONTRACTS.stateView as Address,
    abi: stateViewAbi,
    functionName: 'getSlot0',
    args: [poolId ?? zeroHash],
    chainId: CHAIN.id,
    query: { enabled: signing && destination === 'narrow' && poolId !== null, refetchInterval: 30_000 },
  });

  const range = useMemo(() => {
    if (!pool?.key) return null;
    if (destination === 'full') return fullRange(pool.key.tickSpacing);
    const tick = slot0.data?.[1];
    if (tick === undefined) return null;
    const weth = CONTRACTS.weth.toLowerCase();
    const tokenIsCurrency0 = pool.key.currency1.toLowerCase() === weth;
    const out = shapeToTickBins({
      weights: [1],
      minPct: -NARROW_PCT,
      maxPct: NARROW_PCT,
      currentTick: tick,
      tickSpacing: pool.key.tickSpacing,
      tokenIsCurrency0,
    });
    return out.ok ? { lower: out.bins[0].lower, upper: out.bins[0].upper } : null;
  }, [pool, destination, slot0.data]);

  const built =
    signing && pool?.key && range
      ? buildRouterConfig({
          key: pool.key,
          range,
          mode: trigger,
          cadenceSeconds: ROUTER_DEFAULTS.cadenceSeconds,
          milestonesUsd: numeric,
          ethPriceUsd: global.ethPriceUsd,
          maxSlippagePct: slippage,
          twapDeviationPct: twapGuard,
          minRouteEth: minRoute,
          maxRouteEth: maxRoute,
        })
      : null;

  let liveProblem: string | null = null;
  if (signing) {
    if (q === '') liveProblem = 'Enter your token’s address or ticker.';
    else if (candidates.length === 0) liveProblem = 'No Uniswap v4 pool with an ETH side was found for that token.';
    else if (!pool) liveProblem = 'Every pool found for that token has a hook that can rewrite liquidity, which the router refuses.';
    else if (!keeper)
      liveProblem = `A keeper address is needed to trigger routes, and ${BRAND}’s is not recorded in its deployment yet. Nothing can be created until it is.`;
    else if (!range) liveProblem = destination === 'narrow' ? 'Reading the pool’s price for the range…' : 'This pool has no usable range.';
    else if (built && !built.ok) liveProblem = built.reason;
  }

  const enable = async () => {
    if (!signing) {
      act('Enabling the router');
      return;
    }
    if (!built?.ok || !keeper || !pool) return;
    setBusy(true);
    try {
      const address = await actions.createRouter(built.cfg, keeper, pool.token.symbol);
      if (address) setCreated({ address, symbol: pool.token.symbol });
    } finally {
      setBusy(false);
    }
  };

  const enableButton = (
    <button
      className="btn btn-brand"
      style={{ width: '100%', justifyContent: 'center', height: 46 }}
      disabled={blocked || (LIVE && !signing) || (signing && (liveProblem !== null || busy))}
      onClick={() => void enable()}
    >
      {busy ? 'Creating router…' : 'Enable router'}
    </button>
  );

  return (
    <div className="router">
      <div className="card panel">
        <div className="field">
          <label htmlFor="r-token">Your token</label>
          <div className="inp" style={{ height: 44 }}>
            <input
              id="r-token"
              value={tokenQuery}
              onChange={(e) => {
                setTokenQuery(e.target.value);
                setPickedPool(null);
              }}
              placeholder="0x… or ticker"
              autoComplete="off"
              style={{ fontSize: 15 }}
            />
            {router.deployerVerified && <span className="pill up">Verified deployer</span>}
          </div>
        </div>

        {signing ? (
          <div className="field">
            <label htmlFor="r-pool">Destination pool</label>
            <div className="inp" style={{ height: 44 }}>
              <select
                id="r-pool"
                value={pool?.id ?? ''}
                onChange={(e) => setPickedPool(e.target.value)}
                disabled={eligible.length === 0}
              >
                {eligible.length === 0 && <option value="">No routable pool</option>}
                {eligible.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pairLabel(p)} · {feeTierLabel(p)} ·{' '}
                    {usd(p.tvlUsd)} depth
                  </option>
                ))}
              </select>
            </div>
            {pool && (
              <p className="hint">
                Token <span className="num">{pool.token.address}</span> — check it is yours: anyone can deploy a token
                with the same ticker. The pool is fixed when the router is created and can never be changed.
              </p>
            )}
          </div>
        ) : (
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
        )}

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
            {milestones.map((m, i) => {
              const wei = usdToWethWei(numeric[i], global.ethPriceUsd);
              return (
                <div className="milestone" key={m.id}>
                  <div className="inp">
                    <label className="sr-only" htmlFor={`ms-mc-${m.id}`}>
                      Milestone {i + 1} market cap in dollars
                    </label>
                    <input
                      id={`ms-mc-${m.id}`}
                      value={m.marketCap}
                      inputMode="decimal"
                      onChange={(e) =>
                        setMilestones((prev) =>
                          prev.map((x) => (x.id === m.id ? { ...x, marketCap: e.target.value } : x)),
                        )
                      }
                    />
                    <span className="unit">$ MC</span>
                  </div>
                  <span className="ms-weth num" title="What the router actually compares against: fully diluted value in WETH">
                    {wei === null || wei === 0n ? '— WETH' : `≈ ${wethLabel(wei)} WETH`}
                  </span>
                  <button
                    className="rm"
                    aria-label={`Remove milestone ${i + 1}`}
                    onClick={() => setMilestones((prev) => prev.filter((x) => x.id !== m.id))}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setMilestones((prev) => [...prev, { id: nextId++, marketCap: '' }])}
            >
              Add milestone
            </button>
            {!ascending && (
              <p className="hint down">
                Milestones must ascend. Each one fires once, in order — the contract rejects an
                out-of-order list at config time.
              </p>
            )}
            <p className="hint">
              Each milestone fires once and routes everything accrued until then. The router measures
              fully diluted value in WETH — total supply × its 30-minute average price — not dollars:
              each figure is converted at today&rsquo;s ETH price
              {global.ethPriceUsd > 0 ? (
                <>
                  {' '}(<span className="num">{usdExact(global.ethPriceUsd, 2)}</span>)
                </>
              ) : (
                ', which is not known yet'
              )}{' '}
              and fixed when the router is created. If ETH moves, the dollar value it fires at moves with it.
            </p>
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
              ±{NARROW_PCT}% around price
            </button>
          </div>
          <p className="hint">
            Full range never goes out of position. Narrow adds more depth where traders actually
            are{signing ? ', but it is fixed around today’s price forever: if the price leaves it, routed liquidity stops earning and stops adding depth, and still cannot be withdrawn' : ''}.
          </p>
        </div>

        {signing && (
          <details className="field adv">
            <summary>Route guards</summary>
            <div className="adv-grid">
              <label>
                <span>Max slippage vs 30-min TWAP</span>
                <span className="inp sm">
                  <input value={slippage} onChange={(e) => setSlippage(e.target.value)} inputMode="decimal" />
                  <span className="unit">%</span>
                </span>
              </label>
              <label>
                <span>Max spot-vs-TWAP move</span>
                <span className="inp sm">
                  <input value={twapGuard} onChange={(e) => setTwapGuard(e.target.value)} inputMode="decimal" />
                  <span className="unit">%</span>
                </span>
              </label>
              <label>
                <span>Smallest route</span>
                <span className="inp sm">
                  <input value={minRoute} onChange={(e) => setMinRoute(e.target.value)} inputMode="decimal" />
                  <span className="unit">WETH</span>
                </span>
              </label>
              <label>
                <span>Largest route</span>
                <span className="inp sm">
                  <input
                    value={maxRoute}
                    onChange={(e) => setMaxRoute(e.target.value)}
                    inputMode="decimal"
                    placeholder="no limit"
                  />
                  <span className="unit">WETH</span>
                </span>
              </label>
            </div>
            <p className="hint">
              A route reverts rather than buy more than this far from the average price, or while the
              price is this far from it — that is what keeps a keeper call from being sandwiched. A cap
              on the largest route slices a big balance into routes a thin pool can take.
            </p>
          </details>
        )}

        {signing ? <SignGate className="btn btn-brand router-go">{enableButton}</SignGate> : enableButton}
        {LIVE && !signing ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            The router opens when {BRAND}&rsquo;s router factory contract is deployed. Nothing can be created yet.
          </p>
        ) : signing && liveProblem ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }} role="status">
            {liveProblem}
          </p>
        ) : signing && keeper ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            One transaction. You become the router&rsquo;s owner; {BRAND}&rsquo;s keeper{' '}
            <a className="num" href={explorerAddress(keeper)} target="_blank" rel="noopener noreferrer">
              {shortWallet(keeper)}
            </a>{' '}
            can trigger routes and never receives funds.
          </p>
        ) : null}
        {signing && <AuditNotice className="center" />}

        {created && (
          <div className="note router-made" role="status">
            <b>Your {created.symbol} router is live</b>
            <p className="hint">
              <a className="num" href={explorerAddress(created.address)} target="_blank" rel="noopener noreferrer">
                {created.address}
              </a>
            </p>
            <p className="hint">
              Point your creator-fee payouts (ETH or WETH) at this address. Routes start once it has
              recorded 30 minutes of prices. You own it: you can pause it and take back fees not yet
              routed. What it has routed is permanent.
            </p>
          </div>
        )}
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
              Accrued WETH is split, part swapped to {pool?.token.symbol ?? router.tokenSymbol} within the{' '}
              {router.twapMinutes}-min TWAP guard, both sides added to the pool.
              <div className="st">
                {flowing ? (
                  <>
                    Est. first route: {router.firstRouteWeth.toFixed(2)} WETH → +
                    {usd(router.firstRouteDepthUsd)} depth
                  </>
                ) : (
                  'Nothing has accrued yet, so there is no first route to estimate.'
                )}
              </div>
            </div>
          </div>
          <div className="tl">
            <div className="w">Ongoing</div>
            <div>
              {flowing ? (
                <>
                  Pool depth compounds. Slippage on a $5K buy drops from{' '}
                  {router.slippageNowPct.toFixed(1)}% to an estimated{' '}
                  {router.slippageLaterPct.toFixed(1)}% after 30 days at current fee rate.
                </>
              ) : (
                'Pool depth compounds with every route.'
              )}
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
          {!grows ? (
            // The curve is a fixed shape, so it may only be drawn when depth
            // actually grows. With no fee stream it rose while its own labels
            // said the start and the end were the same.
            <p className="hint" style={{ marginTop: 8 }}>
              No fee stream is routed yet, so there is nothing to project. Pool depth is{' '}
              <b className="num">{usd(pool?.tvlUsd ?? router.currentDepthUsd)}</b> today and stays there until fees
              accrue.
            </p>
          ) : (
          <>
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
          </>
          )}
        </div>
      </div>
    </div>
  );
}
