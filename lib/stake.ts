import { PROTOCOL_FEE_BPS } from './chain';
import type { Pool } from './data/types';

/**
 * The simulator's wallet balance. Forms read `portfolio.walletBalanceEth`,
 * never this: the simulator sets it from here, and the live site has no
 * wallet until P2, so it sends null and the forms say so.
 */
export const PREVIEW_BALANCE_ETH = 4.18;

/** The LP's share of harvested fees, after the protocol's cut (§3.3). */
export const LP_FEE_SHARE = 1 - PROTOCOL_FEE_BPS / 10_000;

export interface StakeQuote {
  depositUsd: number;
  /** The deposit's share of the pool once it is in, 0–1. */
  share: number;
  /**
   * WETH a week at the trailing fee rate, after the protocol's cut. Null when
   * the pool has under 24h of data: §7 allows no figure at all then.
   */
  weeklyWeth: number | null;
}

/**
 * What a deposit would earn at the pool's trailing rate. Arithmetic on past
 * fees, not a forecast — the drawer and the stake panel both say so — and the
 * only place the sum is done, so the two cannot disagree.
 */
export function stakeQuote(pool: Pool, eth: number, ethPriceUsd: number): StakeQuote {
  const depositUsd = Math.max(0, eth) * ethPriceUsd;
  const share = depositUsd > 0 ? depositUsd / (pool.tvlUsd + depositUsd) : 0;
  if (pool.feeYield.basis === 'insufficient' || pool.feeWindowHours <= 0 || ethPriceUsd <= 0) {
    return { depositUsd, share, weeklyWeth: null };
  }
  const weeklyFeesUsd = pool.feesWindowUsd * (168 / pool.feeWindowHours);
  return { depositUsd, share, weeklyWeth: (weeklyFeesUsd * share * LP_FEE_SHARE) / ethPriceUsd };
}

/**
 * Why a deposit amount cannot be staked, or null when it can. With no wallet
 * there is no balance to check against and nothing to sign with, so the
 * answer is that, not a comparison with an invented number.
 */
export function depositProblem(eth: number, balanceEth: number | null): string | null {
  if (balanceEth === null) return 'Connect a wallet to stake.';
  if (!Number.isFinite(eth) || eth <= 0) return 'Enter an amount to stake.';
  if (eth > balanceEth) return `That is above your balance of ${balanceEth} ETH.`;
  return null;
}

/** 14 buckets of 12h folded into 7 days, oldest first, for the daily bars. */
export function dailyFromHalfDays(buckets: number[]): number[] {
  const days: number[] = [];
  for (let i = 0; i + 1 < buckets.length; i += 2) days.push(buckets[i] + buckets[i + 1]);
  return days;
}
