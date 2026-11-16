'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useWalletHistory } from '@/hooks/useWalletHistory';
import { explorerTx } from '@/lib/contracts/tx';
import { toNumber } from '@/lib/deposit';
import { pairLabel } from '@/lib/pair';

const KIND: Record<string, string> = { Deposited: 'Deposit', Withdrawn: 'Withdraw', Claimed: 'Claim' };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function amount(raw: string, decimals: number, symbol: string): string | null {
  const n = toNumber(BigInt(raw), decimals);
  if (!(n > 0)) return null;
  const eth = symbol === 'ETH' || symbol === 'WETH';
  const digits = eth ? (n < 0.01 ? 6 : 4) : n < 1 ? 6 : 2;
  // Below what those digits can show, say so rather than print "0".
  const floor = 10 ** -digits;
  if (n < floor) return `<${floor.toFixed(digits)} ${symbol}`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: digits })} ${symbol}`;
}

/**
 * The connected wallet's deposits, withdrawals and claims, newest first, each
 * linked to its transaction — read from the vaults' own events.
 */
export function Activity() {
  const { pools, vaults } = useMarket();
  const { history, failed } = useWalletHistory();

  return (
    <div className="card panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h2 className="sect-h">Activity</h2>
        {history?.asOf && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            vault events read to {ago(history.asOf)}
          </span>
        )}
      </div>
      {history === null ? (
        <p className="hint" style={{ marginTop: 0 }}>
          {failed ? 'Your vault history could not be read just now. It is retried every 30 seconds.' : 'Reading your vault history…'}
        </p>
      ) : history.events.length === 0 ? (
        <div className="empty">
          <b>No activity yet</b>
          Deposits, withdrawals and claims this wallet makes in a vault appear here, each with its transaction.
        </div>
      ) : (
        <ul className="act-list">
          {history.events.map((e) => {
            const pool = pools.find((p) => p.id.toLowerCase() === e.poolId);
            const cur = vaults.find((v) => v.poolId.toLowerCase() === e.poolId)?.live?.currencies;
            const parts = cur
              ? [amount(e.amount0, cur[0].decimals, cur[0].symbol), amount(e.amount1, cur[1].decimals, cur[1].symbol)].filter(Boolean)
              : [];
            return (
              <li key={`${e.txHash}-${e.kind}-${e.vault}`}>
                <span className={`pill${e.kind === 'Claimed' ? ' brand' : ' grey'}`}>{KIND[e.kind] ?? e.kind}</span>
                <span className="act-what">
                  <b>{pool ? pairLabel(pool) : `vault ${e.vault.slice(0, 6)}…`}</b>
                  <span className="num">{parts.length > 0 ? parts.join(' + ') : '—'}</span>
                </span>
                <a className="act-when muted" href={explorerTx(e.txHash)} target="_blank" rel="noreferrer">
                  {ago(e.at)} ↗
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
