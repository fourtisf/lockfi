/**
 * Formatting only. No maths that decides what a number *means* lives here —
 * that belongs in the provider (§4: compute it in SQL, never in the component).
 */

/** $1.23B / $1.23M / $12.3K / $123 — the prototype's `fmt`. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Exact dollars with separators, for headline figures. */
export function usdExact(n: number, fractionDigits = 0): string {
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/**
 * Dollars for fees, which on a small stake are fractions of a cent for hours:
 * $18 at 5% a year earns about $0.0001 an hour. To the cent that is "$0.00",
 * which reads as nothing earned while fees are arriving. Under a cent, two
 * significant digits ("$0.000065"); from a cent, cents.
 */
export function usdFee(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '$0.00';
  const sign = n < 0 ? '−' : '';
  if (a < 0.000001) return `${sign}< $0.000001`;
  if (a < 0.01) return `${sign}$${a.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;
  return usdExact(n, 2);
}

/** The precision usdFee shows, for tone(): a fee of $0.00007 is a gain, not a zero. */
export const FEE_DIGITS = 8;

/**
 * The sign a figure carries AT THE PRECISION IT IS SHOWN: 1 above zero, -1
 * below, 0 for anything that renders as zero. Zero is neither a gain nor a
 * loss, so it gets no sign and no colour — "+$0" in green and "−$0" in red
 * both claimed a direction that did not exist, and a live site with nothing
 * staked yet showed them on every card.
 */
export function signOf(n: number, digits = 0): 1 | 0 | -1 {
  if (!Number.isFinite(n)) return 0;
  const shown = Number(Math.abs(n).toFixed(digits));
  return shown === 0 ? 0 : n > 0 ? 1 : -1;
}

/** The class a number's colour comes from (§19): green up, red down, none at zero. */
export function tone(n: number, digits = 0): '' | 'up' | 'down' {
  const s = signOf(n, digits);
  return s > 0 ? 'up' : s < 0 ? 'down' : '';
}

/** A signed percentage, e.g. +11.2% / −4.0% / 0.0%. */
export function signedPct(n: number, digits = 1): string {
  const s = signOf(n, digits);
  return `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`;
}

/**
 * Signed exact dollars, e.g. +$1,204 / −$812 / $0. The sign is judged at the
 * digits shown, so pair it with tone(n, digits) at the same precision: a
 * −$0.40 printed to the dollar is "$0", and colouring it red says a zero lost.
 */
export function signedUsd(n: number, digits = 0): string {
  const s = signOf(n, digits);
  return `${s > 0 ? '+' : s < 0 ? '−' : ''}${usdExact(Math.abs(n), digits)}`;
}

/**
 * How far behind head the indexer is, in the largest unit that reads at a
 * glance: 42s, 15m, 3h, 41d. A first sync is days behind for hours, and the
 * top bar printed that as "3542400s behind" — unreadable, and wide enough to
 * push a phone's page sideways.
 */
export function lagLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function count(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function weth(n: number, digits = 3): string {
  return `${n.toFixed(digits)} WETH`;
}

/** Token prices swing over orders of magnitude; sub-$1 tokens need 4 places. */
export function price(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 })}`;
}

/** 1656 -> "69d", 24 -> "1d", 1 -> "1h". Matches the prototype's age column. */
export function ageLabel(hours: number): string {
  if (hours < 24) return `${Math.max(1, Math.floor(hours))}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** 385_200 -> "4d 11h left" */
export function countdown(seconds: number): string {
  if (seconds <= 0) return 'complete';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function inHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h >= 1) return `in ${h}h`;
  return `in ${Math.max(1, Math.floor(seconds / 60))}m`;
}

export function shortWallet(hex: string): string {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
