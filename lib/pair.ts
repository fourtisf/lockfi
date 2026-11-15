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
  const pct = pool.key ? pool.key.fee / 10_000 : pool.feeTierBps / 100;
  return `${Number(pct.toFixed(4))}%`;
}

/** The two things a vault pays fees in, named as a person would: "ETH and USDG". */
export function feeTokensLabel(pool: Pick<Pool, 'token' | 'quote' | 'key'>): string {
  const [base, quote] = pairLabel(pool).split(' / ');
  return `${base} and ${quote}`;
}
