import { CONTRACTS } from './chain';
import type { Pool } from './data/types';

const ZERO = '0x0000000000000000000000000000000000000000';

/** True when the pool holds native ETH rather than WETH (v4 names it address 0). */
export function holdsNativeEth(pool: Pick<Pool, 'key'>): boolean {
  return pool.key?.currency0.toLowerCase() === ZERO;
}

/**
 * What a person calls this pool: "CASHCAT / ETH", "ETH / USDG", "AAPL / USDG".
 *
 * The indexer records a v4 pool's native side as WETH so it can be priced
 * (CLAUDE.md §19), and the pages used to print every pair as "<token> / WETH"
 * — so the ETH/USDG vaults read "WETH / WETH". The pair is the pool's own: its
 * traded token, then its quote, with native ETH named ETH.
 */
export function pairLabel(pool: Pick<Pool, 'token' | 'quote' | 'key'>): string {
  const native = holdsNativeEth(pool);
  const isWeth = pool.token.address.toLowerCase() === CONTRACTS.weth.toLowerCase();
  const base = isWeth ? (native ? 'ETH' : 'WETH') : pool.token.symbol;
  const quote = pool.quote === 'USDG' ? 'USDG' : native ? 'ETH' : 'WETH';
  return `${base} / ${quote}`;
}

/**
 * The pool's swap fee as a percentage, exact: 460 → "0.046%", 500 → "0.05%",
 * 20000 → "2%". From the pool key when there is one, because `feeTierBps` is
 * whole basis points and rounds 0.046% and 0.05% to the same 5 — which made
 * the chain's two ETH/USDG vaults indistinguishable.
 */
export function feeTierLabel(pool: Pick<Pool, 'feeTierBps' | 'key'>): string {
  if (isDynamicFee(pool)) return 'Dynamic';
  const pct = pool.key ? pool.key.fee / 10_000 : pool.feeTierBps / 100;
  return `${Number(pct.toFixed(4))}%`;
}

/**
 * Uniswap v4's DYNAMIC_FEE_FLAG (LPFeeLibrary): a key whose fee is 0x800000
 * has no fixed fee — its hook sets the fee on every swap. Read as a number it
 * printed "838.8608%" on HOODIE's deepest pool.
 */
export const DYNAMIC_FEE_FLAG = 0x800000;

export function isDynamicFee(pool: Pick<Pool, 'key'>): boolean {
  return pool.key !== undefined && pool.key.fee === DYNAMIC_FEE_FLAG;
}

export interface PoolContract {
  symbol: string;
  address: `0x${string}`;
}

/**
 * The contracts a person would copy for this pool: each side that is a token
 * (native ETH has no contract), the traded token first. From the pool key, so
 * the ETH/USDG pools list USDG and not the WETH contract they never hold.
 */
export function poolContracts(pool: Pick<Pool, 'token' | 'quote' | 'key'>): PoolContract[] {
  const token = pool.token.address.toLowerCase();
  const quoteSymbol = pool.quote === 'USDG' ? 'USDG' : 'WETH';
  if (!pool.key) return [{ symbol: pool.token.symbol, address: pool.token.address as `0x${string}` }];
  const out: PoolContract[] = [];
  for (const c of [pool.key.currency0, pool.key.currency1]) {
    const a = c.toLowerCase();
    if (a === ZERO) continue;
    out.push({ symbol: a === token ? pool.token.symbol : quoteSymbol, address: c });
  }
  return out.sort((x, y) => Number(y.address.toLowerCase() === token) - Number(x.address.toLowerCase() === token));
}

/** The two things a vault pays fees in, named as a person would: "ETH and USDG". */
export function feeTokensLabel(pool: Pick<Pool, 'token' | 'quote' | 'key'>): string {
  const [base, quote] = pairLabel(pool).split(' / ');
  return `${base} and ${quote}`;
}
