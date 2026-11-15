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
export function stakeQuote(
  pool: Pool,
  eth: number,
  ethPriceUsd: number,
  /** The vault's own fee once it has been read from the contract (§7). */
  protocolFeeBps: number = PROTOCOL_FEE_BPS,
): StakeQuote {
  const depositUsd = Math.max(0, eth) * ethPriceUsd;
  const share = depositUsd > 0 ? depositUsd / (pool.tvlUsd + depositUsd) : 0;
  if (pool.feeYield.basis === 'insufficient' || pool.feeWindowHours <= 0 || ethPriceUsd <= 0) {
    return { depositUsd, share, weeklyWeth: null };
  }
  const weeklyFeesUsd = pool.feesWindowUsd * (168 / pool.feeWindowHours);
  const lpShare = 1 - protocolFeeBps / 10_000;
  return { depositUsd, share, weeklyWeth: (weeklyFeesUsd * share * lpShare) / ethPriceUsd };
}

/**
 * The smallest deposit Tidewell takes, in dollars (ALFA's call). One
 * constant, read by both stake forms and by compound.
 */
export const MIN_DEPOSIT_USD = 10;

/**
 * The minimum in ETH at a given ETH price, or null when the price is not
 * known: the minimum is then unknown too, and is not guessed.
 */
export function minDepositEth(ethPriceUsd: number): number | null {
  return Number.isFinite(ethPriceUsd) && ethPriceUsd > 0 ? MIN_DEPOSIT_USD / ethPriceUsd : null;
}

/** "Minimum $10 · ≈ 0.0040 ETH at today's price", or why it cannot say. */
export function minDepositLabel(ethPriceUsd: number): string {
  const eth = minDepositEth(ethPriceUsd);
  return eth === null
    ? `Minimum $${MIN_DEPOSIT_USD} · the ETH price is not known yet, so it cannot be shown in ETH`
    : `Minimum $${MIN_DEPOSIT_USD} · ≈ ${eth.toFixed(4)} ETH at today's price`;
}

/**
 * Why a deposit amount cannot be staked, or null when it can. With no wallet
 * there is no balance to check against and nothing to sign with, so the
 * answer is that, not a comparison with an invented number. Below the $10
 * minimum — or with no ETH price to measure the minimum by — it cannot be
 * staked either.
 */
export function depositProblem(eth: number, balanceEth: number | null, ethPriceUsd: number): string | null {
  if (balanceEth === null) return 'Connect a wallet to stake.';
  if (!Number.isFinite(eth) || eth <= 0) return 'Enter an amount to stake.';
  const min = minDepositEth(ethPriceUsd);
  if (min === null) return `The ETH price is not known yet, so the $${MIN_DEPOSIT_USD} minimum cannot be checked.`;
  if (eth < min) return `Minimum $${MIN_DEPOSIT_USD} — about ${min.toFixed(4)} ETH at today's price.`;
  if (eth > balanceEth) return `That is above your balance of ${balanceEth} ETH.`;
  return null;
}

/** 14 buckets of 12h folded into 7 days, oldest first, for the daily bars. */
export function dailyFromHalfDays(buckets: number[]): number[] {
  const days: number[] = [];
  for (let i = 0; i + 1 < buckets.length; i += 2) days.push(buckets[i] + buckets[i + 1]);
  return days;
}
