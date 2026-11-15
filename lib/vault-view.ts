/**
 * What a vault shows, decided in one place for the Stakes page, the stake
 * panel, the drawer and the portfolio.
 *
 * With the vault watcher's live read (Vault.live), every figure is the
 * vault's own: what a full-range position earned over the trailing seven
 * days, less the vault's protocol fee — the rate a staker actually keeps —
 * and its pool's fees and volume over the last 24 hours, read from the chain
 * a minute ago. Without it (the simulator, or before the watcher's first
 * read) the figures are the pool's row, and the label says the yield is the
 * pool's average: concentrated LPs pull that far above what full range earns.
 */
import type { FeeYield, Pool, Vault } from './data/types';

/** A live read older than this is shown with its age, not as live (§7). */
export const LIVE_STALE_SECONDS = 600;

export interface VaultView {
  /** True when the figures are the vault's own, read from the chain. */
  live: boolean;
  /** Live, but older than LIVE_STALE_SECONDS. */
  stale: boolean;
  /** Seconds since the live read; null without one, or before the clock is known. */
  ageSeconds: number | null;
  /** Live, with less than a full week of swap history behind it. */
  young: boolean;
  /** The headline: what a staker keeps when live; the pool's average otherwise. */
  yield: FeeYield;
  /** Words under the headline figure. */
  yieldLabel: string;
  /** The longer explanation, for a title. */
  yieldTitle: string;
  /** The pool's own average, for comparison. */
  poolYield: FeeYield;
  fees24hUsd: number;
  volume24hUsd: number;
  feeHistory: number[];
  stakedUsd: number;
  /** ETH in dollars from the vault's own pool, when live and ETH/USDG. */
  ethPriceUsd: number | null;
}

/** A yield less a share of it (the protocol's fee, in basis points). */
export function afterFee(y: FeeYield, feeBps: number): FeeYield {
  if (y.basis === 'insufficient') return y;
  const keep = 1 - Math.max(0, Math.min(10_000, feeBps)) / 10_000;
  return { ...y, pct: y.pct * keep };
}

/**
 * @param now the clock to age the live read by; null before the page has
 *        mounted, when no age is shown (see hooks/useNow.ts).
 */
export function vaultView(vault: Vault, pool: Pool, now: number | null = Date.now()): VaultView {
  const live = vault.live;
  if (!live) {
    return {
      live: false,
      stale: false,
      ageSeconds: null,
      young: pool.ageHours < 168,
      yield: pool.feeYield,
      yieldLabel: 'pool average, trailing 7d',
      yieldTitle:
        "The whole pool's average fee yield. The vault holds a full-range position, which usually earns less " +
        'than this when other liquidity is concentrated near the price.',
      poolYield: pool.feeYield,
      fees24hUsd: pool.fees24hUsd,
      volume24hUsd: pool.volume24hUsd,
      feeHistory: pool.feeHistory,
      stakedUsd: vault.totalStakedUsd,
      ethPriceUsd: null,
    };
  }
  const ageSeconds = now === null ? null : Math.max(0, Math.round((now - Date.parse(live.asOf)) / 1000));
  const feePct = vault.protocolFeeBps / 100;
  return {
    live: true,
    stale: ageSeconds !== null && ageSeconds > LIVE_STALE_SECONDS,
    ageSeconds,
    // The pool's age in the snapshot is as of the indexer's last swap read,
    // which can be months ago; the live read says how much history it has.
    young: live.historyHours < 167.5,
    yield: afterFee(live.fullRangeYield, vault.protocolFeeBps),
    yieldLabel: `trailing 7d · after ${feePct}% fee`,
    yieldTitle:
      `What the vault's full-range position actually earned in swap fees over the trailing ` +
      `${Math.round(Math.min(168, live.historyHours))} hours, read from the chain, annualised, after ${feePct}% to ` +
      `the protocol. Not a forecast. The pool's own average is higher because most of its liquidity is ` +
      'concentrated near the price, which earns more per dollar than a full-range position — and stops ' +
      'earning when the price leaves its range.',
    poolYield: pool.feeYield,
    fees24hUsd: live.fees24hUsd,
    volume24hUsd: live.volume24hUsd,
    feeHistory: live.feeHistory,
    stakedUsd: live.stakedUsd ?? vault.totalStakedUsd,
    ethPriceUsd: live.ethPriceUsd,
  };
}

/** "live · 40s ago", "as of 25m ago" — how old a vault's live read is. */
export function liveAgeLabel(view: Pick<VaultView, 'live' | 'stale' | 'ageSeconds'>): string | null {
  if (!view.live || view.ageSeconds === null) return null;
  const s = view.ageSeconds;
  const text = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172_800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
  return view.stale ? `as of ${text} ago` : `live · ${text} ago`;
}

/**
 * ETH's dollar price for anything a person signs: from a vault's live pool
 * read when there is one — seconds old, from the chain — and only otherwise
 * from the snapshot, which is as of the indexer's last swap read and can be
 * months old.
 */
export function liveEthPrice(vaults: Vault[], fallback: number): number {
  // The newest live read wins, however old: a price from the chain an hour
  // ago is still closer to now than the indexer's last swap read.
  let best: { price: number; at: number } | null = null;
  for (const v of vaults) {
    const p = v.live?.ethPriceUsd;
    const at = v.live ? Date.parse(v.live.asOf) : Number.NaN;
    if (p != null && p > 0 && Number.isFinite(at) && (best === null || at > best.at)) best = { price: p, at };
  }
  return best?.price ?? fallback;
}
