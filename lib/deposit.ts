/**
 * The ways into a vault, and the arithmetic each needs. Pure.
 *
 * A Tidewell vault holds one full-range position in its pool's two tokens,
 * and takes a deposit three ways — none of which needs a contract change:
 *
 *   ETH      TidewellZap.zapStake with native ETH: about half is swapped
 *            into the other token in the same transaction.
 *   token    zapStake with the pool's other token (USDG on ETH/USDG), after
 *            an approval of exactly that amount to the zap.
 *   both     TidewellVault.deposit with both tokens in the pool's ratio: no
 *            swap, so no swap fee and no price impact. The ratio comes from
 *            the vault's own previewDeposit, and the token side is approved
 *            to the vault for exactly what it may pull.
 *
 * Either single-token route sells part of the deposit; depositing both does
 * not. Each is said where it is offered.
 */
import { zeroAddress } from 'viem';
import { CONTRACTS } from './chain';
import type { PoolKey, VaultCurrency } from './data/types';

type Address = `0x${string}`;

/** A single side, by currency index, or both together. */
export type DepositRoute = 0 | 1 | 'both';

export interface DepositSide {
  index: 0 | 1;
  currency: Address;
  /** "ETH" for native ETH; WETH stays "WETH" (it is an ERC-20 in a two-token deposit). */
  symbol: string;
  /** Null until known: an amount cannot be read without it. */
  decimals: number | null;
  /** Native ETH, paid as the transaction's value. */
  native: boolean;
  /** Native ETH or WETH: a single-side deposit of it is paid in native ETH. */
  isEth: boolean;
  priceUsd: number | null;
}

export interface DepositOption {
  route: DepositRoute;
  label: string;
  /** One line on what the route does, under the choice. */
  note: string;
}

const WETH = CONTRACTS.weth.toLowerCase();

/** A vault pool's two sides, from its key and whatever is known of the tokens. */
export function depositSides(
  key: Pick<PoolKey, 'currency0' | 'currency1'>,
  known: (VaultCurrency | { symbol?: string; decimals?: number | null; priceUsd?: number | null } | undefined)[],
): [DepositSide, DepositSide] {
  const side = (index: 0 | 1): DepositSide => {
    const currency = (index === 0 ? key.currency0 : key.currency1).toLowerCase() as Address;
    const native = currency === zeroAddress;
    const isEth = native || currency === WETH;
    const k = known[index];
    return {
      index,
      currency,
      symbol: native ? 'ETH' : (k?.symbol ?? (currency === WETH ? 'WETH' : 'token')),
      decimals: native ? 18 : (k?.decimals ?? null),
      native,
      isEth,
      priceUsd: k?.priceUsd ?? null,
    };
  };
  return [side(0), side(1)];
}

/** The routes a vault offers, its ETH side first. */
export function depositOptions(sides: [DepositSide, DepositSide]): DepositOption[] {
  const ordered = sides[1].isEth && !sides[0].isEth ? [sides[1], sides[0]] : [sides[0], sides[1]];
  const singles = ordered.map(
    (s): DepositOption => ({
      route: s.index,
      // The ETH side is always paid in native ETH: the zap wraps it for a WETH pool.
      label: s.isEth ? 'ETH' : s.symbol,
      note: `Only ${s.isEth ? 'ETH' : s.symbol}: about half is swapped into ${otherLabel(sides, s.index)} in the same transaction, at the pool's price and fee.`,
    }),
  );
  const both: DepositOption = {
    route: 'both',
    label: `${ordered[0].symbol} + ${ordered[1].symbol}`,
    note: 'Both tokens in the pool’s ratio: nothing is swapped, so no swap fee and no price impact.',
  };
  return [...singles, both];
}

function otherLabel(sides: [DepositSide, DepositSide], index: 0 | 1): string {
  const o = sides[index === 0 ? 1 : 0];
  return o.isEth ? 'ETH' : o.symbol;
}

/** The order sides are shown in for a two-token deposit: the ETH side first. */
export function displayOrder(sides: [DepositSide, DepositSide]): [DepositSide, DepositSide] {
  return sides[1].isEth && !sides[0].isEth ? [sides[1], sides[0]] : sides;
}

/**
 * An amount typed for a token with `decimals` places, in its smallest unit,
 * or null when it is not one. Rejects signs, exponents and more places than
 * the token has.
 */
export function parseAmount(text: string, decimals: number | null): bigint | null {
  if (decimals === null || decimals < 0) return null;
  const s = text.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole = '', frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  const digits = `${whole === '' ? '0' : whole}${frac.padEnd(decimals, '0')}`;
  return BigInt(digits);
}

/** Smallest units as a decimal string, rounded DOWN to `digits` places. */
export function formatAmountDown(raw: bigint, decimals: number, digits: number): string {
  if (raw <= 0n) return '0';
  const places = Math.max(0, Math.min(digits, decimals));
  const unit = 10n ** BigInt(decimals - places);
  const floored = raw / unit;
  const s = floored.toString().padStart(places + 1, '0');
  const whole = s.slice(0, s.length - places);
  const frac = places > 0 ? s.slice(s.length - places).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

/** Smallest units as a plain number of whole tokens: display and USD only. */
export function toNumber(raw: bigint, decimals: number): number {
  const unit = 10n ** BigInt(decimals);
  return Number(raw / unit) + Number(raw % unit) / Number(unit);
}

/**
 * A stand-in for "as much as it takes" on the side being matched, when
 * asking the vault's previewDeposit what one side needs of the other. Large
 * enough never to be the limit; small enough that the vault's liquidity
 * maths does not overflow uint128 (a trillion whole tokens).
 */
export function unlimited(decimals: number): bigint {
  return 10n ** BigInt(decimals + 12);
}

/** `x` plus a margin, rounded up: what a two-token deposit may pull of the matched side. */
export function plusMargin(x: bigint, bps: bigint = 50n): bigint {
  if (x <= 0n) return 0n;
  return (x * (10_000n + bps) + 9_999n) / 10_000n;
}

/** A deposit's dollar value, or null when an amount in it has no price. */
export function depositUsd(parts: { amount: number; priceUsd: number | null }[]): number | null {
  let total = 0;
  for (const p of parts) {
    if (!(p.amount > 0)) continue;
    if (p.priceUsd === null || !(p.priceUsd > 0)) return null;
    total += p.amount * p.priceUsd;
  }
  return total;
}
