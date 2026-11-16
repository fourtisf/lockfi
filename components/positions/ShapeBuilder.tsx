'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { zeroHash } from 'viem';
import { useReadContract } from 'wagmi';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { BinChart } from '@/components/positions/BinChart';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useActions } from '@/hooks/useActions';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useWallet } from '@/hooks/useWallet';
import { CHAIN, CONTRACTS } from '@/lib/chain';
import { shapeToTickBins, tokenShareOfBins } from '@/lib/contracts/shaped';
import { mintAvailability } from '@/lib/contracts/status';
import { maxSpendableWei, parseEthInput, weiToNumber } from '@/lib/contracts/tx';
import { stateViewAbi } from '@/lib/contracts/uniswap';
import { DATA_SOURCE } from '@/lib/data';
import type { ShapeId } from '@/lib/data/types';
import { price as fmtPrice } from '@/lib/format';
import { MAX_BINS, MIN_BINS, SHAPES, shapeWeights } from '@/lib/shapes';
import { BRAND } from '@/lib/site';
import { feeYieldReason, yieldPct } from '@/lib/yield';
import { feeTierLabel, pairLabel } from '@/lib/pair';

const SHAPE_ICONS: Record<ShapeId, number[]> = {
  spot: [20, 20, 20, 20, 20, 20, 20, 20],
  curve: [6, 11, 17, 21, 21, 17, 11, 6],
  bidask: [21, 16, 11, 6, 6, 11, 16, 21],
};

export function ShapeBuilder() {
  const { pools } = useMarket();
  // An indexer still reading the blocks before the PoolManager existed has
  // found no pools, and a builder needs one to build on. Said plainly, rather
  // than the page throwing on pools[0].
  if (pools.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <b>No pools indexed yet</b>
          The indexer is still reading the chain. Once it finds a pool you can shape a position
          on it here.
        </div>
      </div>
    );
  }
  return <Builder />;
}

const LIVE = DATA_SOURCE === 'live';

/** Why a live pool cannot be minted into here, in a sentence. */
const UNAVAILABLE = {
  'no-key': 'This pool is not a Uniswap v4 pool the indexer has a key for, so it cannot be minted into here.',
  'no-shaper': `Minting opens when ${BRAND}’s shaper contract is deployed.`,
  'no-eth-side': 'This pool has no ETH side, so a position cannot be minted into it with ETH.',
} as const;

function Builder() {
  const { pools, global } = useMarket();
  const { portfolio, balanceWei } = usePortfolio();
  const wallet = useWallet();
  const actions = useActions();
  const { act } = useUi();
  const [busy, setBusy] = useState(false);
  // After a mint confirms: the position is in the wallet, and the portfolio
  // should show it at once rather than at its next 20-second read.
  const [minted, setMinted] = useState(false);
  const queryClient = useQueryClient();

  const stakeablePools = pools.filter((p) => p.stakeable);
  const [poolId, setPoolId] = useState(stakeablePools[0]?.id ?? pools[0].id);
  // ?pool=<id>: the drawer's "Add CASHCAT liquidity" opens here on the token
  // the person clicked, not on whichever pool happens to be first. Read after
  // mount — the page is static, so the server renders the default.
  // ?width=&bins=&rebalance=1: the portfolio's Rebalance opens here with the
  // old position's width and bin count, centred on today's price.
  const [rebalancing, setRebalancing] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const wanted = q.get('pool');
    if (wanted && stakeablePools.some((p) => p.id === wanted)) setPoolId(wanted);
    const w = Number(q.get('width'));
    if (Number.isFinite(w) && w >= 2 && w <= 60) {
      setMinPct(-Math.round(w));
      setMaxPct(Math.round(w));
    }
    const b = Number(q.get('bins'));
    if (Number.isInteger(b) && b >= MIN_BINS && b <= MAX_BINS) setBins(b);
    if (q.get('rebalance') === '1') setRebalancing(true);
    // Once, on arrival: later snapshots must not undo a choice made here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [amount, setAmount] = useState('2.5');
  const [shape, setShape] = useState<ShapeId>('spot');
  const [minPct, setMinPct] = useState(-15);
  const [maxPct, setMaxPct] = useState(15);
  const [bins, setBins] = useState(24);

  const pool = pools.find((p) => p.id === poolId) ?? pools[0];
  const shapeMeta = SHAPES.find((s) => s.id === shape)!;
  const weights = useMemo(() => shapeWeights(shape, bins), [shape, bins]);

  // Live: TidewellShaper, for a v4 pool with a key and an ETH side. The
  // pool's current price is read so the shape can be put on its tick grid.
  const avail = LIVE ? mintAvailability(pool) : null;
  const target = avail?.ok ? avail : null;
  const slot0 = useReadContract({
    address: CONTRACTS.stateView as `0x${string}`,
    abi: stateViewAbi,
    functionName: 'getSlot0',
    args: [target?.poolId ?? zeroHash],
    chainId: CHAIN.id,
    query: { enabled: target !== null, refetchInterval: 15_000 },
  });
  const sqrtPriceX96 = slot0.data?.[0];
  const currentTick = slot0.data?.[1];

  // Null with no wallet connected: no balance to cap the deposit at, and
  // nothing to sign a mint with. Live, it is the wallet's ETH less gas.
  const balance =
    LIVE ? (balanceWei === null ? null : Number(weiToNumber(maxSpendableWei(balanceWei)).toFixed(4))) : portfolio.walletBalanceEth;

  const eth = Number.parseFloat(amount) || 0;

  // Nothing downstream is meaningful for an inverted or empty range, so the
  // range is validated before it is drawn rather than after it breaks.
  const problems: string[] = [];
  if (!Number.isFinite(eth) || eth <= 0) problems.push('Enter a deposit amount.');
  else if (balance !== null && eth > balance) problems.push(`Deposit is above your balance of ${balance} ETH.`);
  if (maxPct <= minPct) problems.push('Max must be above Min.');
  if (minPct <= -100) problems.push('Min must be above −100%.');
  if (minPct > 0) problems.push('Min must be at or below the current price.');
  if (maxPct < 0) problems.push('Max must be at or above the current price.');
  const valid = problems.length === 0;

  // Draw against a sane range even while the inputs are mid-edit.
  const safeMin = Math.min(minPct, 0);
  const safeMax = Math.max(maxPct, safeMin + 1);
  const lo = pool.priceUsd * (1 + safeMin / 100);
  const hi = pool.priceUsd * (1 + safeMax / 100);

  // Share of the deposit that has to sit above the current price, i.e. in the
  // token rather than in WETH.
  const span = (safeMax - safeMin) / 100 || 1;
  const priceFraction = (0 - safeMin / 100) / span;
  const pageShare = weights.reduce(
    (acc, w, i) => acc + ((i + 0.5) / bins > priceFraction ? w : 0),
    0,
  );

  // Live, the shape on this pool's tick grid, and the split those exact
  // bins need at the pool's price — what the shaper will actually swap.
  const plan = useMemo(
    () =>
      target && currentTick !== undefined && valid
        ? shapeToTickBins({
            weights,
            minPct,
            maxPct,
            currentTick,
            tickSpacing: target.key.tickSpacing,
            tokenIsCurrency0: target.tokenIsCurrency0,
          })
        : null,
    [target, currentTick, valid, weights, minPct, maxPct],
  );
  const tokenShare =
    plan?.ok && sqrtPriceX96 !== undefined
      ? tokenShareOfBins(plan.bins, sqrtPriceX96, target!.tokenIsCurrency0)
      : pageShare;
  const amountWei = parseEthInput(amount);

  const mint = async () => {
    if (!LIVE) {
      act('Minting');
      return;
    }
    if (!target || amountWei === null) return;
    setBusy(true);
    setMinted(false);
    try {
      if (await actions.mintShaped({ target, weights, minPct, maxPct, amountWei }, pool.token.symbol)) {
        setMinted(true);
        void queryClient.invalidateQueries({ queryKey: ['wallet-positions'] });
      }
    } finally {
      setBusy(false);
    }
  };

  // Estimated, and labelled as such: this pool's trailing-7d yield scaled by
  // how tightly the range concentrates it. Never a forecast (§1).
  const known = pool.feeYield.basis !== 'insufficient';
  const trailing = yieldPct(pool.feeYield);
  const concentration = Math.min(6, 0.6 / span);
  const shapeFactor = shape === 'curve' ? 1.35 : shape === 'bidask' ? 0.8 : 1;
  const estYield = trailing * concentration * shapeFactor;

  const setWidth = (w: number) => {
    setMinPct(-w);
    setMaxPct(w);
  };

  return (
    <div className="builder">
      <div className="card panel">
        <div className="field">
          <label htmlFor="b-token">Token</label>
          <div className="inp" style={{ height: 46 }}>
            <select id="b-token" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
              {stakeablePools.map((p) => (
                <option key={p.id} value={p.id}>
                  {pairLabel(p)} · {feeTierLabel(p)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="b-amount">Deposit</label>
          <div className="inp">
            <input
              id="b-amount"
              type="number"
              min="0"
              step="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="unit">ETH</span>
            {balance !== null && (
              <button type="button" className="max" onClick={() => setAmount(String(balance))}>
                Max {balance}
              </button>
            )}
          </div>
          <p className="hint">
            {BRAND} swaps part of this into {pool.token.symbol} to fill the shape you choose.
          </p>
        </div>

        <div className="field">
          <span className="lbl" id="shape-label">
            Shape
          </span>
          <div className="shape" role="group" aria-labelledby="shape-label">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                className={shape === s.id ? 'on' : undefined}
                aria-pressed={shape === s.id}
                onClick={() => setShape(s.id)}
              >
                <svg viewBox="0 0 52 24" aria-hidden="true">
                  {SHAPE_ICONS[s.id].map((h, i) => (
                    <rect key={i} x={2 + i * 6} y={24 - h} width={4} height={h} />
                  ))}
                </svg>
                {s.label}
              </button>
            ))}
          </div>
          <p className="hint">{shapeMeta.hint}</p>
        </div>

        <div className="field">
          <span className="lbl">Price range</span>
          <div className="rangebox">
            <div className="inp sm">
              <label className="unit" htmlFor="b-min" style={{ fontSize: 12 }}>
                Min
              </label>
              <input
                id="b-min"
                type="number"
                step="1"
                value={minPct}
                onChange={(e) => setMinPct(Number(e.target.value))}
              />
              <span className="unit">%</span>
            </div>
            <div className="inp sm">
              <label className="unit" htmlFor="b-max" style={{ fontSize: 12 }}>
                Max
              </label>
              <input
                id="b-max"
                type="number"
                step="1"
                value={maxPct}
                onChange={(e) => setMaxPct(Number(e.target.value))}
              />
              <span className="unit">%</span>
            </div>
          </div>
          <label className="sr-only" htmlFor="b-width">
            Symmetric range width, percent
          </label>
          <input
            className="range"
            id="b-width"
            type="range"
            min="2"
            max="60"
            value={Math.round(Math.max(Math.abs(minPct), Math.abs(maxPct)))}
            onChange={(e) => setWidth(Number(e.target.value))}
            style={{ marginTop: 10 }}
          />
          <p className="hint">
            Tighter range earns more per dollar while price stays inside, and nothing once it
            leaves.
          </p>
        </div>

        <div className="field">
          <label htmlFor="b-bins">
            Bins <span className="muted" style={{ fontWeight: 400 }}>· {bins}</span>
          </label>
          <input
            className="range"
            id="b-bins"
            type="range"
            min={MIN_BINS}
            max={MAX_BINS}
            value={bins}
            onChange={(e) => setBins(Number(e.target.value))}
          />
          <p className="hint">
            Up to {MAX_BINS} bins in one transaction — past that, two transactions are cheaper.
          </p>
        </div>

        {LIVE && target ? (
          <SignGate className="btn btn-brand mint-go">
            <button
              className="btn btn-brand mint-go"
              disabled={!valid || busy || balance === null || !plan?.ok || amountWei === null}
              onClick={() => void mint()}
            >
              {busy ? 'Minting…' : 'Mint position'}
            </button>
          </SignGate>
        ) : (
          <button
            className="btn btn-brand mint-go"
            disabled={!valid || balance === null || (LIVE && !target)}
            onClick={() => void mint()}
          >
            Mint position
          </button>
        )}
        {rebalancing && !minted && (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            Rebalancing: the same width and number of bins as the position you withdrew, centred on today&rsquo;s price.
            Adjust anything before you mint.
          </p>
        )}
        {minted && (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            Minted to your wallet. It is listed in your <Link href="/portfolio">portfolio</Link>, with its value,
            fees, Collect fees and Withdraw.
          </p>
        )}
        {!valid ? (
          <p className="hint down" style={{ textAlign: 'center', marginTop: 8 }} role="alert">
            {problems[0]}
          </p>
        ) : LIVE && avail && !avail.ok ? (
          // Not an input error, so not red: the builder still works as a
          // calculator for this pool.
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            {UNAVAILABLE[avail.reason]}
          </p>
        ) : LIVE && wallet.status !== 'ready' ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            {wallet.status === 'wrong-chain'
              ? `Minting needs your wallet on ${CHAIN.name}.`
              : 'Connect a wallet to mint. The position NFTs go to it.'}
          </p>
        ) : LIVE && slot0.isError ? (
          <p className="hint down" style={{ textAlign: 'center', marginTop: 8 }} role="alert">
            Could not read this pool&rsquo;s price from the chain. Try again in a moment.
          </p>
        ) : LIVE && currentTick === undefined ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            Reading the pool&rsquo;s price…
          </p>
        ) : LIVE && plan && !plan.ok ? (
          <p className="hint down" style={{ textAlign: 'center', marginTop: 8 }} role="alert">
            {plan.reason}
          </p>
        ) : LIVE && plan?.ok ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            One transaction, {plan.bins.length} {plan.bins.length === 1 ? 'position' : 'positions'}, each a
            Uniswap v4 NFT minted to your wallet.
            {plan.merged > 0 &&
              ` ${plan.merged} ${plan.merged === 1 ? 'bin merges' : 'bins merge'} into neighbours on this pool’s tick spacing of ${target!.key.tickSpacing}.`}
            {' '}The price may move 0.5% at most before it lands, or nothing happens.
          </p>
        ) : balance === null ? (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            Minting needs a wallet.
          </p>
        ) : (
          <p className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
            One transaction. Gas ≈ $0.06. You keep the NFT.
          </p>
        )}
        {LIVE && target && <AuditNotice className="center" />}
      </div>

      <div className="card viz">
        <div className="viz-h">
          <div>
            <span className="t">{pairLabel(pool)}</span>{' '}
            <span className="sub">
              · current price <span className="num">{fmtPrice(pool.priceUsd)}</span>
            </span>
          </div>
          <span className="pill grey">{shapeMeta.label}</span>
        </div>

        <BinChart
          weights={weights}
          minPct={safeMin / 100}
          maxPct={safeMax / 100}
          currentPrice={pool.priceUsd}
          shape={shape}
          symbol={pool.token.symbol}
        />

        <div className="legend">
          <span>
            <i style={{ background: 'var(--ac)' }} />
            Token side (above price)
          </span>
          <span>
            <i style={{ background: 'var(--ac-3)' }} />
            WETH side
          </span>
          <span>
            <i className="line" />
            Current price
          </span>
        </div>

        <div className="sum">
          <div>
            <div className="k">Range</div>
            <div className="v num">
              {fmtPrice(lo)} – {fmtPrice(hi)}
            </div>
          </div>
          <div>
            <div className="k">Est. fee yield</div>
            <div className={`v num${known ? ' up' : ' muted'}`}>
              {known ? `${estYield.toFixed(0)}%` : '—'}
              {known && <span className="est">est. · from {trailing.toFixed(0)}% trailing</span>}
              {/* A dash says why: §7 allows no figure from under a day of fees. */}
              {!known && feeYieldReason(pool.feeYield) && <span className="est">{feeYieldReason(pool.feeYield)}</span>}
            </div>
          </div>
          <div>
            <div className="k">Split at mint</div>
            {/* One amount per line: side by side they ran into the next column. */}
            <div className="v num">
              <span className="ln">{(eth * (1 - tokenShare)).toFixed(2)} ETH</span>
              <span className="ln">
                {((eth * tokenShare * global.ethPriceUsd) / pool.priceUsd).toLocaleString('en-US', {
                  maximumFractionDigits: 1,
                })}{' '}
                {pool.token.symbol}
              </span>
            </div>
          </div>
          <div>
            <div className="k">Fee tier</div>
            <div className="v num">{feeTierLabel(pool)}</div>
          </div>
        </div>

        <p className="hint">
          {!known && pool.feeYield.basis === 'insufficient' && (
            <>
              {pool.feeYield.reason === 'unread'
                ? `No estimate yet: the indexer has read under 24 hours of this pool's last week — it is still catching up with the chain — and a yield from less than a day of fees would be a guess. It appears once a day has been read. `
                : pool.feeYield.reason === 'no-depth'
                  ? `No estimate yet: this pool's depth is not known, so there is nothing honest to divide its fees by. `
                  : `No estimate yet: this pool has under 24 hours of fees. `}
            </>
          )}
          Est. fee yield scales this pool&rsquo;s trailing 7d fees by how tightly your range
          concentrates them. It is arithmetic on past fees, not a forecast, and it earns nothing
          while price sits outside the range.
        </p>
      </div>
    </div>
  );
}
