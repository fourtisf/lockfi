/**
 * The arithmetic every Tidewell transaction is built from. Pure, so it is
 * tested rather than trusted: a wrong number here is a reverted transaction
 * at best and a bad fill at worst.
 *
 * Amounts are bigint wei throughout. Floats appear only where the result is a
 * fraction of a deposit (the split between the two sides), never an amount.
 */
import { formatEther, parseEther } from 'viem';
import { deadlineFromNow, EXPLORER } from '../chain';

/** 0.5%: the most a quote may degrade between building and landing. */
export const SLIPPAGE_BPS = 50n;

/** Ten minutes, as a timestamp — never a block number on ~100ms blocks (§2). */
export const DEADLINE_SECONDS = 600;

/**
 * ETH kept back from "Max" for gas. Robinhood Chain is an Orbit L2 where a
 * zap costs cents, but the L1 data fee moves, and a Max that leaves nothing
 * for gas is a transaction the wallet refuses. 0.001 ETH covers a 60-bin mint
 * many times over at today's prices.
 */
export const GAS_RESERVE_WEI = parseEther('0.001');

/** The deadline every Tidewell call carries: now + 10 minutes, in seconds. */
export function txDeadline(now = Date.now()): bigint {
  return BigInt(deadlineFromNow(DEADLINE_SECONDS, now));
}

/** `x` less the slippage allowance, rounded down. */
export function minusSlippage(x: bigint, bps: bigint = SLIPPAGE_BPS): bigint {
  if (x <= 0n) return 0n;
  return (x * (10_000n - bps)) / 10_000n;
}

/** Precision of a deposit split passed to `swapAmountForShare`. */
export const SHARE_SCALE = 1_000_000n;

/**
 * How much of a one-sided deposit to swap so that, after the pool's fee, the
 * swapped side holds `share` of the deposit's value.
 *
 * Swapping `s` of `A` leaves `A − s` on the input side and buys `s·(1 − f)`
 * worth of the other. Solving `s·(1 − f) = share · (A − s·f)` gives
 *
 *     s = A · share / (1 − f · (1 − share))
 *
 * For a full-range vault the share is one half, so `s = A / (2 − f)`: a hair
 * over half, to cover the fee. Price impact is not modelled — whatever the
 * deposit cannot use is returned by the contract, and `minLiquidity` refuses
 * a fill that came out materially worse than quoted.
 *
 * @param share 0–1, the fraction of value that must end up on the other side.
 * @param feePips the pool's LP fee in hundredths of a bip (3000 = 0.30%).
 */
export function swapAmountForShare(amountIn: bigint, share: number, feePips: number): bigint {
  if (amountIn <= 0n || !(share > 0)) return 0n;
  if (share >= 1) return amountIn;
  const t = BigInt(Math.round(share * Number(SHARE_SCALE)));
  const f = BigInt(Math.max(0, Math.min(999_999, Math.round(feePips))));
  const swap = (amountIn * t * 1_000_000n) / (SHARE_SCALE * 1_000_000n - f * (SHARE_SCALE - t));
  return swap > amountIn ? amountIn : swap;
}

/** A full-range position takes the two sides in equal value: swap about half. */
export function zapStakeSwapAmount(amountIn: bigint, feePips: number): bigint {
  return swapAmountForShare(amountIn, 0.5, feePips);
}

/**
 * The most of a deposit's value a zap may lose to its own swap before the
 * site refuses to send it: 2%.
 *
 * `minLiquidity` cannot catch this. It is quoted from a simulation that
 * already includes the swap's price impact, so it guards against the price
 * moving between quote and landing — not against a deposit that is simply
 * too large for the pool. Measured on a fork of mainnet: 500 ETH zapped into
 * the chain's deepest hookless ETH/USDG pool sold the price to a fraction of
 * a dollar and minted liquidity worth about 1% of what went in, every check
 * passing. The fee on the swapped half costs at most 0.5% (a 1% pool), which
 * leaves 1.5% for impact before the guard trips.
 */
export const MAX_ZAP_LOSS_BPS = 200;

/**
 * The value in ETH, at the price `sqrtPriceX96`, of `amount0` and `amount1`
 * of a pool whose ETH side is currency `ethIndex`. Exact integer maths:
 * price = token1 per token0 = sqrtPriceX96² / 2¹⁹².
 */
export function ethValueAt(amount0: bigint, amount1: bigint, sqrtPriceX96: bigint, ethIndex: 0 | 1): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  if (p2 === 0n) return 0n;
  const q192 = 1n << 192n;
  return ethIndex === 0 ? amount0 + (amount1 * q192) / p2 : amount1 + (amount0 * p2) / q192;
}

/** Basis points of `amountIn` that `valueOut` falls short of; 0 when it does not. */
export function lossBps(amountIn: bigint, valueOut: bigint): number {
  if (amountIn <= 0n || valueOut >= amountIn) return 0;
  return Number(((amountIn - valueOut) * 10_000n) / amountIn);
}

/** The most a wallet can put in and still pay for gas. Never negative. */
export function maxSpendableWei(balance: bigint, reserve: bigint = GAS_RESERVE_WEI): bigint {
  return balance > reserve ? balance - reserve : 0n;
}

/**
 * An amount typed into an ETH field, as wei, or null when it is not one.
 * Rejects what parseEther would quietly accept or choke on: blanks, signs,
 * exponents, more than 18 decimals.
 */
export function parseEthInput(text: string): bigint | null {
  const s = text.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [, frac = ''] = s.split('.');
  if (frac.length > 18) return null;
  try {
    return parseEther(s.startsWith('.') ? `0${s}` : s);
  } catch {
    return null;
  }
}

/**
 * Wei as a short decimal string, rounded DOWN to `digits` places — a balance
 * or a Max that rounds up offers an amount the wallet does not have.
 */
export function formatEthDown(wei: bigint, digits = 4): string {
  const unit = 10n ** BigInt(18 - digits);
  const floored = (wei / unit) * unit;
  const text = formatEther(floored);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Shares for a percentage of a balance; 100% is the whole balance, exactly. */
export function sharesForPct(balance: bigint, pct: number): bigint {
  if (balance <= 0n || !(pct > 0)) return 0n;
  if (pct >= 100) return balance;
  return (balance * BigInt(Math.round(pct * 100))) / 10_000n;
}

/**
 * Bounds on a pool's sqrt price after a swap: ±0.5% in PRICE, which is about
 * ±0.25% in sqrt price. sqrt(0.995) = 0.9974969 and sqrt(1.005) = 1.0024969,
 * each rounded outward to the millionth so the bound is never narrower than
 * ±0.5%.
 */
export function sqrtPriceBounds(sqrtPriceX96: bigint): { min: bigint; max: bigint } {
  return {
    min: (sqrtPriceX96 * 997_496n) / 1_000_000n,
    max: (sqrtPriceX96 * 1_002_497n + 999_999n) / 1_000_000n,
  };
}

/** The bytes32 pool id of a v4 pool from the indexer's `v4:0x…` id. */
export function v4PoolId(poolId: string): `0x${string}` | null {
  const m = /^v4:(0x[0-9a-fA-F]{64})$/.exec(poolId);
  return m ? (m[1].toLowerCase() as `0x${string}`) : null;
}

export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

/** Wei to a JS number of ETH, for display and USD maths only — never for an amount sent. */
export function weiToNumber(wei: bigint, decimals = 18): number {
  if (decimals <= 0) return Number(wei);
  const unit = 10n ** BigInt(decimals);
  const whole = wei / unit;
  const frac = wei % unit;
  return Number(whole) + Number(frac) / Number(unit);
}
