/**
 * The transparency page's figures (§32: /stats): what each vault has done
 * since it was deployed, from its own events (Vault.totals), valued at
 * today's prices from the vault watcher's live read (Vault.live).
 *
 * A total in tokens is a fact; in dollars it is that fact at today's price,
 * and the page says so. A side with no price is not valued at all: the
 * dollar figure is null, never a partial sum that reads as the whole.
 */

import { weiToNumber } from './contracts/tx';
import type { Pool, Vault, VaultCurrency } from './data/types';
import { feeTierLabel, pairLabel } from './pair';

export interface VaultStats {
  vault: Vault;
  /** "ETH / USDG · 0.05%" */
  label: string;
  stakedUsd: number;
  stakers: number;
  /** Null without totals (the simulator) or without a price for a side. */
  feesToStakersUsd: number | null;
  claimedUsd: number | null;
  protocolUsd: number | null;
  protocolPaidUsd: number | null;
  /** The token amounts behind feesToStakersUsd, for the row's subtitle: "0.12 ETH + 230.4 USDG". */
  feesToStakersTokens: string | null;
}

function amountText(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

/** Two raw amounts in dollars at today's prices; null when either side has no price or decimals. */
export function valuePair(raw: [string, string], cur: VaultCurrency[] | undefined): number | null {
  if (!cur || cur.length < 2) return null;
  let total = 0;
  for (const i of [0, 1] as const) {
    const c = cur[i];
    const amount = BigInt(raw[i]);
    if (amount === 0n) continue;
    if (c.priceUsd === null || c.decimals < 0) return null;
    total += weiToNumber(amount, c.decimals) * c.priceUsd;
  }
  return total;
}

function minus(a: [string, string], b: [string, string]): [string, string] {
  return [String(BigInt(a[0]) - BigInt(b[0])), String(BigInt(a[1]) - BigInt(b[1]))];
}

export function vaultStats(vault: Vault, pool: Pool | undefined): VaultStats {
  const cur = vault.live?.currencies;
  const t = vault.totals;
  const label = pool
    ? `${pairLabel(pool)} · ${feeTierLabel(pool)}`
    : cur
      ? `${cur[0].symbol} / ${cur[1].symbol}`
      : `Vault ${vault.address.slice(0, 6)}…${vault.address.slice(-4)}`;
  const toStakers = t ? minus(t.feesCollected, t.protocolCut) : null;
  const tokens =
    toStakers && cur
      ? (() => {
          // The ETH side first, as the site names pairs.
          const order = cur[1].symbol === 'ETH' && cur[0].symbol !== 'ETH' ? [1, 0] : [0, 1];
          return order
            .map((i) => `${amountText(weiToNumber(BigInt(toStakers[i]), cur[i].decimals))} ${cur[i].symbol}`)
            .join(' + ');
        })()
      : null;
  return {
    vault,
    label,
    stakedUsd: vault.totalStakedUsd,
    stakers: vault.stakers,
    feesToStakersUsd: toStakers ? valuePair(toStakers, cur) : null,
    claimedUsd: t ? valuePair(t.claimed, cur) : null,
    protocolUsd: t ? valuePair(t.protocolCut, cur) : null,
    protocolPaidUsd: t ? valuePair(t.protocolPaid, cur) : null,
    feesToStakersTokens: tokens,
  };
}

export interface StatsTotals {
  stakedUsd: number;
  stakers: number;
  everStakers: number;
  deposits: number;
  /** Null when any vault's figure is unknown: a sum with a hole is not a total. */
  feesToStakersUsd: number | null;
  claimedUsd: number | null;
  protocolUsd: number | null;
  protocolPaidUsd: number | null;
}

export function statsTotals(rows: VaultStats[]): StatsTotals {
  const sum = (pick: (r: VaultStats) => number | null): number | null =>
    rows.reduce<number | null>((a, r) => (a === null || pick(r) === null ? null : a + (pick(r) as number)), 0);
  return {
    stakedUsd: rows.reduce((a, r) => a + r.stakedUsd, 0),
    stakers: rows.reduce((a, r) => a + r.stakers, 0),
    // A wallet staked in two vaults is counted in both: said so on the page.
    everStakers: rows.reduce((a, r) => a + (r.vault.totals?.everStakers ?? 0), 0),
    deposits: rows.reduce((a, r) => a + (r.vault.totals?.deposits ?? 0), 0),
    feesToStakersUsd: sum((r) => r.feesToStakersUsd),
    claimedUsd: sum((r) => r.claimedUsd),
    protocolUsd: sum((r) => r.protocolUsd),
    protocolPaidUsd: sum((r) => r.protocolPaidUsd),
  };
}
