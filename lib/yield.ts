import type { FeeYield } from './data/types';

/** The trailing window. Seven days, everywhere, always (§1). */
export const YIELD_WINDOW_HOURS = 168;
/** Below this much data there is no honest number to show (§7). */
export const MIN_DATA_HOURS = 24;

/** The label that goes next to the figure. Never "APY", never "APR". */
export const FEE_YIELD_LABEL = 'fee yield, trailing 7d';

/**
 * Said wherever a pool's fee yield is shown next to a vault. The figure is
 * the pool's average over all its liquidity; the vault holds a full-range
 * position, which earns less per dollar than the average whenever other LPs
 * concentrate near the price. Showing the pool figure as the vault's own
 * would overstate it (§7).
 */
export const VAULT_YIELD_NOTE =
  "The whole pool's average. A full-range stake usually earns less than this when other liquidity in the pool is concentrated near the price.";

/**
 * fees_window / tvl_now, annualised over the window that actually exists.
 * Lives next to the provider on purpose — components never compute yield.
 */
export function computeFeeYield(args: {
  feesWindowUsd: number;
  tvlUsd: number;
  windowHours: number;
  ageHours: number;
}): FeeYield {
  const { feesWindowUsd, tvlUsd, windowHours, ageHours } = args;
  if (ageHours < MIN_DATA_HOURS || windowHours <= 0) return { basis: 'insufficient', reason: 'young' };
  if (tvlUsd <= 0) return { basis: 'insufficient', reason: 'no-depth' };
  const pct = (feesWindowUsd / tvlUsd) * ((365 * 24) / windowHours) * 100;
  if (ageHours < YIELD_WINDOW_HOURS) {
    return { basis: 'estimate', pct, windowHours };
  }
  return { basis: 'trailing7d', pct };
}

/**
 * "148%", "5.6%" — or an em dash when there is not enough data to say
 * anything. One decimal under 10%, where a whole number would round a
 * full-range vault's 5.6% to 6%.
 */
export function feeYieldValue(y: FeeYield): string {
  if (y.basis === 'insufficient') return '—';
  return `${Math.abs(y.pct) < 10 ? y.pct.toFixed(1) : y.pct.toFixed(0)}%`;
}

/** What the figure is qualified with in the row: "est." plus the pool age. */
export function feeYieldQualifier(y: FeeYield, ageText: string): string | null {
  if (y.basis === 'insufficient') return null;
  if (y.basis === 'estimate') return `est. · ${ageText}`;
  return null;
}

/** Why there is no yield figure, in a few words for under the dash. */
export function feeYieldReason(y: FeeYield): string | null {
  if (y.basis !== 'insufficient') return null;
  if (y.reason === 'no-depth') return 'depth not known yet';
  if (y.reason === 'unread') return 'under 24h read yet';
  return 'under 24h of fees';
}

/** Why a pool shows an em dash, for the title attribute. */
export function feeYieldTitle(y: FeeYield): string {
  switch (y.basis) {
    case 'insufficient':
      if (y.reason === 'no-depth') return "This pool's depth is not known yet, so there is nothing honest to divide its fees by.";
      if (y.reason === 'unread')
        return 'The indexer has read under 24 hours of trading so far (it is still catching up). No yield figure is honest yet.';
      return 'Less than 24h of fee data. No yield figure is honest yet.';
    case 'estimate':
      return `Under 7 days of fees: the pool is younger than a week, or the indexer has not read a full week of it yet. Annualised from ${Math.round(
        y.windowHours,
      )}h of fees — arithmetic, not a forecast.`;
    default:
      return 'Fees earned over the trailing 7 days, annualised. Not a forecast.';
  }
}

/** Sortable yield. Pools without enough data rank last rather than first. */
export function yieldPct(y: FeeYield): number {
  return y.basis === 'insufficient' ? -1 : y.pct;
}
