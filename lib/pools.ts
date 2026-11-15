import type { Pool } from './data/types';

/** One board row: a token, shown through its deepest pool. */
export interface TokenRow {
  /** The pool the row's figures come from: the token's deepest. */
  pool: Pool;
  /** The token's other pools in the same view, deepest first. */
  others: Pool[];
}

function deeper(a: Pool, b: Pool): number {
  return b.tvlUsd - a.tvlUsd || b.volume24hUsd - a.volume24hUsd || (a.id < b.id ? -1 : 1);
}

/**
 * One row per token, not per pool.
 *
 * Uniswap v4 lets anyone open another pool for the same token with a
 * different fee tier or hook, and on this chain the popular ones have dozens:
 * the board showed CASHCAT twenty times, each row a different pool with its
 * own price, so "the" CASHCAT had five different market caps on one screen.
 *
 * The row is the token's DEEPEST pool, whole: every figure on it comes from
 * that one pool, so nothing is re-derived here and the yield is still the one
 * SQL computed (§4). Deepest because a thin pool's price is the easiest to
 * push around — the same reason the USD anchor is chosen by depth. The other
 * pools ride along, deepest first, for the drawer to offer.
 *
 * Grouped by ADDRESS. A copycat calling itself CASHCAT is another token and
 * keeps its own row.
 */
export function tokenRows(pools: Pool[]): TokenRow[] {
  const byToken = new Map<string, Pool[]>();
  for (const pool of pools) {
    const key = pool.token.address.toLowerCase();
    const list = byToken.get(key);
    if (list) list.push(pool);
    else byToken.set(key, [pool]);
  }
  return [...byToken.values()].map((list) => {
    const [pool, ...others] = list.slice().sort(deeper);
    return { pool, others };
  });
}

/** Every pool of this pool's token, deepest first — the drawer's list. */
export function poolsOfToken(pools: Pool[], pool: Pool): Pool[] {
  const key = pool.token.address.toLowerCase();
  return pools.filter((p) => p.token.address.toLowerCase() === key).sort(deeper);
}

/**
 * How far a market cap may outrun the pool that prices it and still be ranked.
 *
 * Market cap here is supply × the pool's price, and a pool holding five
 * dollars sets a price five dollars can move: the live board once showed a
 * token at $2.27 trillion off exactly that. A valuation more than this many
 * times the pool's whole depth is not ranked among the others — it is still
 * shown, it is arithmetic, but it follows them. Small memecoins with a few
 * hundred dollars of depth stay in order: $20K on $300 is 67×. The $2.27T on
 * $5 was 450 billion×.
 *
 * A first version required $1K of depth outright. On the live board that sent
 * most memecoins below the line, and the "highest to lowest" ALFA asked for
 * stopped reading as one.
 */
export const MC_MAX_DEPTH_MULTIPLE = 10_000;

/** Whether a pool's market cap is backed by enough depth to be ranked. */
export function mcRanked(pool: Pool): boolean {
  return pool.marketCapUsd > 0 && pool.tvlUsd > 0 && pool.marketCapUsd <= pool.tvlUsd * MC_MAX_DEPTH_MULTIPLE;
}

/**
 * Highest market cap first: ranked pools by market cap, then the ones whose
 * depth cannot carry their figure, then those with no figure at all.
 */
export function byMarketCap(a: Pool, b: Pool): number {
  const tier = (p: Pool) => (mcRanked(p) ? 0 : p.marketCapUsd > 0 ? 1 : 2);
  return tier(a) - tier(b) || b.marketCapUsd - a.marketCapUsd || (a.id < b.id ? -1 : 1);
}
