'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMarket } from '@/components/providers/MarketProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useActions } from '@/hooks/useActions';
import { useWalletPositions } from '@/hooks/useWalletPositions';
import { explorerTx, weiToNumber } from '@/lib/contracts/tx';
import type { TokenMeta } from '@/lib/data/types';
import { price, usd, usdFee } from '@/lib/format';
import { tokenPriceRange, type WalletPosition } from '@/lib/positions';
import { rebalanceHref } from '@/lib/rebalance';
import { MAX_BINS, MIN_BINS } from '@/lib/shapes';
import { BRAND } from '@/lib/site';

/** "62.7", "0.004998", "12,480" — enough digits to be true, not so many they wrap. */
export function tokenAmount(raw: bigint, decimals: number): string {
  const n = weiToNumber(raw, decimals);
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

function feeLabel(fee: number): string {
  return `${+(fee / 10_000).toFixed(4)}%`;
}

function pairOf(p: WalletPosition): string {
  const t = p.currencies[p.tokenIndex];
  const q = p.currencies[p.tokenIndex === 0 ? 1 : 0];
  return `${t.symbol} / ${q.symbol}`;
}

function holds(p: WalletPosition, a0: bigint, a1: bigint): string {
  const parts = [
    a0 > 0n ? `${tokenAmount(a0, p.currencies[0].decimals)} ${p.currencies[0].symbol}` : null,
    a1 > 0n ? `${tokenAmount(a1, p.currencies[1].decimals)} ${p.currencies[1].symbol}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' + ') : 'nothing';
}

/**
 * The connected wallet's positions minted through Tidewell, read from the
 * chain (hooks/useWalletPositions.ts): one row per mint, however many bins
 * it was split into, with what it holds now, the fees it has earned and not
 * collected, whether the price is inside it — and Collect fees and Remove,
 * signed from this wallet against Uniswap's PositionManager — Withdraw, as
 * a stake says it, not Uniswap's Remove.
 */
export function WalletPositions() {
  const { positions, loading, failed, refetch } = useWalletPositions();

  return (
    <div className="card mine" style={{ marginTop: 20 }}>
      <div className="mine-h">
        <h2 className="sect-h">Your positions</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Uniswap v4 positions you minted with {BRAND}&rsquo;s shape builder: NFTs in your own wallet, one per bin
        </span>
        {positions.length > 0 && <AuditNotice className="mine-audit" />}
      </div>
      {positions.length === 0 ? (
        <div className="empty">
          <b>{loading ? 'Reading your positions…' : failed ? 'Your positions could not be read' : 'No positions yet'}</b>
          {loading
            ? 'Looking up the positions this wallet minted, and reading each one from the chain.'
            : failed
              ? 'The chain did not answer just now; this retries on its own.'
              : `Positions you mint on the Positions page appear here, with their range, value and fees.`}
        </div>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}>
          <table className="tbl pos-tbl">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col" className="r">
                  Value
                </th>
                <th scope="col" className="r">
                  Fees to collect
                </th>
                <th scope="col" className="r">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <PositionRow key={p.txHash} position={p} onDone={refetch} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PositionRow({ position: p, onDone }: { position: WalletPosition; onDone: () => void }) {
  const { pools } = useMarket();
  const actions = useActions();
  const router = useRouter();
  const [busy, setBusy] = useState<'collect' | 'withdraw' | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [rebalancing, setRebalancing] = useState(false);
  const token = p.currencies[p.tokenIndex];
  const pool = pools.find((x) => x.id.toLowerCase() === `v4:${p.poolId}`.toLowerCase());
  const meta: TokenMeta =
    pool?.token ??
    pools.find((x) => x.token.address.toLowerCase() === token.address.toLowerCase())?.token ?? {
      address: token.address,
      symbol: token.symbol,
      name: token.symbol,
      decimals: token.decimals,
      logoColor: '',
    };
  const name = `${pairOf(p)} · ${feeLabel(p.key.fee)}`;
  const range = tokenPriceRange(p);
  const hasFees = p.fees0 > 0n || p.fees1 > 0n;
  const earning = p.binsInRange > 0;

  const run = async (what: 'collect' | 'withdraw', fn: () => Promise<boolean>) => {
    setBusy(what);
    try {
      if (await fn()) {
        if (what === 'withdraw') setWithdrawing(false);
        onDone();
      }
    } finally {
      setBusy(null);
    }
  };

  // §6's rebalance prompt: an out-of-range position earns nothing. Withdraw
  // it, then open Positions on the same pool with the same width and bins,
  // centred on today's price — when that pool is on the Positions page.
  const poolId = `v4:${p.poolId}`.toLowerCase();
  const onPage = pools.some((x) => x.id.toLowerCase() === poolId && x.stakeable);
  const href = rebalanceHref(poolId, p.tickLower, p.tickUpper, p.bins.length, MIN_BINS, MAX_BINS);
  const rebalance = async () => {
    setBusy('withdraw');
    try {
      if (await actions.removePosition(p, `Withdraw from ${name} to rebalance`)) {
        setRebalancing(false);
        onDone();
        if (onPage) router.push(href);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Fragment>
      <tr className="static">
        <td data-label="Position">
          <div className="tok">
            <TokenBadge token={meta} />
            <div>
              <div className="n">{name}</div>
              <div className="s">
                {p.bins.length} {p.bins.length === 1 ? 'bin' : 'bins'}
                {range && (
                  <>
                    {' · '}
                    <span className="num">
                      {price(range.low)} – {price(range.high)}
                    </span>
                  </>
                )}
                {' · '}
                {earning ? (
                  // A shaped position earns through whichever bin the price is in.
                  'in range — earning'
                ) : (
                  // §7: out of range earns nothing. Said in the row, in red.
                  <span className="down">out of range — earning nothing</span>
                )}
              </div>
              <div className="s">
                <a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer">
                  minted at block {p.blockNumber.toLocaleString('en-US')} ↗
                </a>
              </div>
            </div>
          </div>
        </td>
        <td className="r num" data-label="Value">
          {p.valueUsd === null ? '—' : usd(p.valueUsd)}
          <div className="hint" style={{ marginTop: 2 }}>
            {holds(p, p.amount0, p.amount1)}
          </div>
        </td>
        <td className="r num" data-label="Fees to collect">
          <span className={hasFees ? 'up' : undefined}>{holds(p, p.fees0, p.fees1)}</span>
          <div className="hint" style={{ marginTop: 2 }}>
            {p.feesUsd === null ? 'not priced yet' : usdFee(p.feesUsd)}
          </div>
        </td>
        <td className="r">
          <SignGate className="btn btn-ghost btn-sm">
            <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy !== null || !hasFees}
                title={hasFees ? `Collect ${holds(p, p.fees0, p.fees1)} to this wallet; the liquidity stays` : 'No fees to collect yet'}
                onClick={() => void run('collect', () => actions.collectPosition(p, `Collect fees from ${name}`))}
              >
                {busy === 'collect' ? 'Collecting…' : 'Collect fees'}
              </button>
              {!earning && (
                <button
                  className="btn btn-brand btn-sm"
                  disabled={busy !== null}
                  aria-expanded={rebalancing}
                  onClick={() => {
                    setRebalancing((r) => !r);
                    setWithdrawing(false);
                  }}
                >
                  Rebalance
                </button>
              )}
              <button
                className="btn btn-quiet btn-sm"
                disabled={busy !== null}
                aria-expanded={withdrawing}
                onClick={() => {
                  setWithdrawing((w) => !w);
                  setRebalancing(false);
                }}
              >
                Withdraw
              </button>
            </div>
          </SignGate>
        </td>
      </tr>
      {rebalancing && (
        <tr className="static wd-row">
          <td colSpan={4}>
            <div className="wd">
              <p className="hint">
                This position is out of range and earning nothing. Rebalancing is two steps: first withdraw all{' '}
                {p.bins.length} {p.bins.length === 1 ? 'bin' : 'bins'} (
                <span className="num">{holds(p, p.amount0, p.amount1)}</span>
                {p.feesUsd !== null && p.feesUsd > 0 ? ', plus the fees to collect' : ''}) to this wallet in one transaction;
                then{' '}
                {onPage
                  ? 'Positions opens on the same pool with the same width and number of bins, centred on today’s price, for you to mint again.'
                  : 'mint a new range on the Positions page — this pool is not listed there yet.'}
              </p>
              <div className="row">
                <button className="btn btn-brand btn-sm" disabled={busy !== null} onClick={() => void rebalance()}>
                  {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw and rebalance'}
                </button>
                <button className="btn btn-quiet btn-sm" onClick={() => setRebalancing(false)} disabled={busy !== null}>
                  Cancel
                </button>
              </div>
              <AuditNotice />
            </div>
          </td>
        </tr>
      )}
      {withdrawing && (
        <tr className="static wd-row">
          <td colSpan={4}>
            <div className="wd">
              <p className="hint">
                Withdraws all {p.bins.length} {p.bins.length === 1 ? 'bin' : 'bins'} in one transaction:{' '}
                <span className="num">{holds(p, p.amount0, p.amount1)}</span>
                {p.valueUsd !== null && <> (about <span className="num">{usd(p.valueUsd)}</span>)</>}, plus the fees
                to collect, go to this wallet, and the position NFTs are burned. The least accepted is what each bin
                would return within 0.5% of today&rsquo;s price; past that, nothing happens.
              </p>
              <div className="row">
                <button
                  className="btn btn-brand btn-sm"
                  disabled={busy !== null}
                  onClick={() => void run('withdraw', () => actions.removePosition(p, `Withdraw from ${name}`))}
                >
                  {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw all'}
                </button>
                <button className="btn btn-quiet btn-sm" onClick={() => setWithdrawing(false)} disabled={busy !== null}>
                  Cancel
                </button>
              </div>
              <AuditNotice />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
