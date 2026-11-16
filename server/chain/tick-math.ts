/**
 * The exact Uniswap tick maths lives in lib/tick-math.ts, so the indexer and
 * the browser (the portfolio values a wallet's positions with it) share one
 * definition. Re-exported here for the server code that imports it from
 * this path.
 */
export * from '../../lib/tick-math';
