'use client';

import { Fragment, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { AuditNotice, SignGate } from '@/components/wallet/Wallet';
import { useActions } from '@/hooks/useActions';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useWallet } from '@/hooks/useWallet';
import { signingStatus } from '@/lib/contracts/status';
import { sharesForPct } from '@/lib/contracts/tx';
import type { Pool, UserStake } from '@/lib/data/types';
import { countdown, shortWallet, tone, usd, usdExact, weth } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { MIN_DEPOSIT_USD, minDepositEth } from '@/lib/stake';
import { claimableLabel, hasClaimable, holdingLabel, type WalletStake } from '@/lib/wallet/portfolio';

export function MyStakes() {
  const { pools, global } = useMarket();
  const { query } = useUi();
  const { portfolio, source, stakes: walletStakes } = usePortfolio();
  const { status } = useWallet();
  const fromWallet = source === 'wallet';

  const q = query.trim().toLowerCase();
  const stakes = portfolio.stakes.filter((stake) => {
    if (q === '') return true;
    const pool = pools.find((p) => p.id === stake.poolId);
    if (!pool) return false;
    return (
      pool.token.symbol.toLowerCase().includes(q) || pool.token.name.toLowerCase().includes(q)
    );
  });
  const deployed = signingStatus().vaults.length > 0;

  return (
    <div className="card mine">
      <div className="mine-h">
        <h2 className="sect-h">Your stakes</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {source === 'sim'
            ? 'fees drip over 7 days, so a deposit just before a harvest earns no more than its share'
            : 'fees are credited the moment they’re earned; claim any time in ETH and the pool’s token; leaving never forfeits fees already earned'}
        </span>
        {fromWallet && portfolio.stakes.length > 0 && <AuditNotice className="mine-audit" />}
      </div>

      {portfolio.stakes.length === 0 ? (
        // Nothing staked is not the same as nothing matching a search, and
        // each reason it is empty is said as itself.
        <div className="empty">
          <b>No stakes yet</b>
          {source === 'sim'
            ? 'Stakes you make appear here.'
            : !deployed
              ? `Stakes appear here once ${BRAND}'s vaults are deployed and a wallet is connected.`
              : status === 'disconnected' || status === 'connecting'
                ? 'Connect a wallet to see its stakes.'
                : 'This wallet has nothing staked in a Tidewell vault.'}
        </div>
      ) : (
      <div className="tbl-wrap" style={{ maxHeight: 'none' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col" className="r">
                Staked
              </th>
              <th scope="col" className="r">
                Claimable
              </th>
              {/* Real vaults have no stream to show: fees are claimable as they arrive. */}
              {!fromWallet && <th scope="col">Stream</th>}
              <th scope="col" className="r">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {stakes.map((stake) => {
              const pool = pools.find((p) => p.id === stake.poolId);
              const live = fromWallet ? walletStakes.find((s) => s.vaultId === stake.vaultId) : undefined;
              if (!pool && !live) return null;
              return live ? (
                <WalletRow key={stake.vaultId} stake={live} pool={pool} ethPriceUsd={global.ethPriceUsd} />
              ) : (
                <PreviewRow key={stake.vaultId} stake={stake} pool={pool!} />
              );
            })}
          </tbody>
        </table>
        {stakes.length === 0 && (
          <div className="empty">
            <b>No match</b>None of your stakes match that search.
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/** The simulator's rows: everything a preview, nothing sent. */
function PreviewRow({ stake, pool }: { stake: UserStake; pool: Pool }) {
  const { act } = useUi();
  return (
    <tr className="static">
      <td data-label="Pool">
        <div className="tok">
          <TokenBadge token={pool.token} />
          <div className="n">{pool.token.symbol} / WETH</div>
        </div>
      </td>
      <td className="r num" data-label="Staked">
        {usd(stake.stakedUsd)}
      </td>
      <td className={`r num ${tone(stake.earnedWeth, 2)}`} data-label="Claimable">
        {weth(stake.earnedWeth, 2)}
      </td>
      <td style={{ minWidth: 180 }} data-label="Stream">
        <Stream pct={stake.streamProgressPct} label={pool.token.symbol} />
        <div className="hint" style={{ marginTop: 4 }}>
          {countdown(stake.streamRemainingSeconds)}
        </div>
      </td>
      <td className="r">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => act('Claiming')}>
            Claim
          </button>
          <button className="btn btn-quiet btn-sm" onClick={() => act('Compounding')}>
            Compound
          </button>
        </div>
      </td>
    </tr>
  );
}

function Stream({ pct, label }: { pct: number; label: string }) {
  return (
    <div
      className="stream"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label} 7-day stream`}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

const WITHDRAW_STEPS = [25, 50, 75, 100];

/** A stake read from the chain, with real Claim, Compound and Withdraw. */
function WalletRow({ stake, pool, ethPriceUsd }: { stake: WalletStake; pool?: Pool; ethPriceUsd: number }) {
  const actions = useActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [pct, setPct] = useState(100);
  const symbol = pool?.token.symbol ?? `vault ${shortWallet(stake.vault)}`;

  const run = async (what: string, fn: () => Promise<boolean>) => {
    setBusy(what);
    try {
      const ok = await fn();
      if (ok && what === 'withdraw') setWithdrawing(false);
    } finally {
      setBusy(null);
    }
  };

  const claimable = hasClaimable(stake);
  // Compound stakes back the ETH side only; the $10 minimum applies to it.
  const minEth = minDepositEth(ethPriceUsd);
  const [first, second] = stake.sides;
  const canCompound = stake.ethIndex !== null && minEth !== null && stake.claimableEth >= minEth;
  const compoundWhy = stake.ethIndex === null
    ? "This pool has no ETH side to stake back in — claim instead"
    : !claimable
    ? 'Nothing to compound yet'
    : minEth === null
      ? 'The ETH price is not known, so the $10 minimum cannot be checked'
      : !canCompound
        ? `The ETH side is under the $${MIN_DEPOSIT_USD} minimum — claim it instead`
        : `Two transactions: claim both tokens, then stake the ${first.symbol} back in${first.symbol === 'WETH' ? ' (plus an approval for exactly that WETH when the zap needs one)' : ''}. The ${second.symbol} stays in your wallet.`;
  const holding = stake.shares > 0n;

  return (
    <Fragment>
      <tr className="static">
        <td data-label="Pool">
          <div className="tok">
            {pool ? <TokenBadge token={pool.token} /> : null}
            <div>
              <div className="n">{pool ? `${second.symbol} / ${first.symbol}` : symbol}</div>
              {holding && <div className="s num">{holdingLabel(stake)}</div>}
            </div>
          </div>
        </td>
        <td className="r num" data-label="Staked" title={stake.priced ? undefined : 'This pool has no price on the site yet'}>
          {holding ? usd(stake.stakedUsd) : 'withdrawn'}
          {holding && (
            <div className="hint" style={{ marginTop: 2 }}>
              {(stake.vaultShare * 100).toFixed(2)}% of vault
            </div>
          )}
        </td>
        <td className="r num" data-label="Claimable">
          {/* Two tokens, as the vault pays them, and what they are worth together. */}
          <span className={claimable ? 'up' : undefined}>{claimableLabel(stake)}</span>
          <div className="hint" style={{ marginTop: 2 }}>
            {Number.isFinite(stake.claimableUsd) ? usdExact(stake.claimableUsd, 2) : 'not priced yet'}
          </div>
        </td>
        <td className="r">
          <SignGate className="btn btn-ghost btn-sm">
            <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy !== null || !claimable}
                title={claimable ? `Claim ${claimableLabel(stake)} to this wallet` : 'Nothing to claim yet'}
                onClick={() => void run('claim', () => actions.claim(stake.vault, symbol))}
              >
                {busy === 'claim' ? 'Claiming…' : 'Claim'}
              </button>
              <button
                className="btn btn-quiet btn-sm"
                disabled={busy !== null || !canCompound}
                title={compoundWhy}
                onClick={() => void run('compound', () => actions.compound(stake.vault, symbol, ethPriceUsd))}
              >
                {busy === 'compound' ? 'Compounding…' : 'Compound'}
              </button>
              {holding && (
                <button
                  className="btn btn-quiet btn-sm"
                  disabled={busy !== null}
                  aria-expanded={withdrawing}
                  onClick={() => setWithdrawing((w) => !w)}
                >
                  Withdraw
                </button>
              )}
            </div>
          </SignGate>
        </td>
      </tr>
      {withdrawing && holding && (
        <tr className="static wd-row">
          <td colSpan={4}>
            <div className="wd">
              <div className="quick" role="group" aria-label="Share of your stake to withdraw">
                {WITHDRAW_STEPS.map((p) => (
                  <button key={p} className={pct === p ? 'on' : undefined} aria-pressed={pct === p} onClick={() => setPct(p)}>
                    {p === 100 ? 'All' : `${p}%`}
                  </button>
                ))}
              </div>
              <p className="hint">
                Withdraws <span className="num">{pct}%</span> of your shares
                {stake.priced && <> — about <span className="num">{usd((stake.stakedUsd * pct) / 100)}</span></>} — as
                {' '}{first.symbol} and {second.symbol}, to this wallet. The minimum accepted is what they are worth
                now, less 0.5%. No fee, no lockup. Leaving never forfeits fees already earned: they stay
                claimable.
              </p>
              <div className="row">
                <button
                  className="btn btn-brand btn-sm"
                  disabled={busy !== null}
                  onClick={() => void run('withdraw', () => actions.withdraw(stake.vault, sharesForPct(stake.shares, pct), symbol))}
                >
                  {busy === 'withdraw' ? 'Withdrawing…' : `Withdraw ${pct === 100 ? 'all' : `${pct}%`}`}
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
