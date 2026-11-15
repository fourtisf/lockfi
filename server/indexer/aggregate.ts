/**
 * The aggregations: `weth_usd_hourly`, `pool_flow_hourly`, `pool_fee_hourly`
 * and `pool_state`, all in SQL (§4.2).
 *
 * Two rules shape every query in this file.
 *
 * REBUILT, NEVER INCREMENTED. Each table is recomputed by aggregation over
 * rows keyed `(tx_hash, log_index)`. An increment is order-dependent and
 * double-counts on replay; a rebuild gives the same answer no matter how many
 * times the same logs arrive, in what order, or in what range sizes. That is
 * what makes §9's "byte-identical" provable rather than hopeful, and it is
 * why re-scanning the last 32 blocks every pass (§4.1) costs nothing.
 *
 * STAGED, SO A REBUILD IS NOT A FULL SCAN. The naive version of this file
 * summed the raw event tables for every pool on every pass and recomputed the
 * anchor's whole price series with a correlated subquery per hour. It was
 * correct and unusable: 5-9 seconds a pass on a four-thousand-swap fixture,
 * and a full table scan per second against a real chain. So the work is
 * staged into hourly tables, and each pass rebuilds only the hours it touched:
 *
 *     swap_events, liquidity_events        (raw, append-only)
 *       -> weth_usd_hourly                 the one USD anchor
 *       -> pool_flow_hourly                signed token flow, for reserves
 *       -> pool_fee_hourly                 fees and volume, valued in USD
 *       -> pool_state                      latest price, reserves, TVL
 *
 * Pricing follows §4.3 exactly: one anchor, one path.
 *
 *   WETH/USDG pool  ->  WETH in USD
 *   any TOKEN/WETH  ->  TOKEN in WETH  ->  TOKEN in USD
 *   any TOKEN/USDG  ->  TOKEN in USD
 *   anything else   ->  unpriced, and it stays unpriced
 *
 * No averaging across venues and no third-party feed. A pool with neither
 * WETH nor USDG on a side is left unpriced rather than guessed at.
 */

import { prisma } from '../db';

/** Tokens that can anchor a price, and the pool that prices WETH itself. */
export interface PriceAnchors {
  weth: string;
  usdg: string;
  wethDecimals: number;
  usdgDecimals: number;
  /** The one WETH/USDG pool. Null means nothing on the site has a USD figure. */
  anchorPoolId: string | null;
}

export interface Bounds {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Bounds beyond which a derived figure is not a market, it is a broken input.
 *
 * A pool can be initialised at any tick, including one that makes a token's
 * derived price 1e24 USD. Three things then go wrong, worst last: the figure
 * is nonsense; a clamped value renders as a real TVL of ten quintillion
 * dollars; and `numeric(38,18)` overflows, which throws and stops the
 * aggregation for EVERY pool, not just the broken one. A fixture at a nonsense
 * tick is how this was found.
 *
 * So a figure outside these bounds is unpriced — null, which becomes zero and
 * which the API declines to list — rather than clamped. §4.3 allows one path
 * to a price; when that path returns nonsense the honest answer is silence,
 * not a big number.
 */
const MAX_SANE_PRICE_USD = '1e12'; // no traded token is worth $1tn a unit
const MAX_SANE_TOTAL_USD = '1e15'; // no pool holds a quadrillion dollars

/** Null unless the value is inside the bound. */
function sane(expr: string, bound: string): string {
  return `(CASE WHEN (${expr}) IS NOT NULL AND abs(${expr}) < ${bound}::numeric THEN (${expr}) ELSE NULL END)`;
}

/**
 * Identifiers are interpolated rather than bound, because Postgres will not
 * accept a parameter in some of the positions below. Everything interpolated
 * is checked first — these values come from config and log topics, not from a
 * request, so this is a belt over braces, but a cheap one.
 */
function safeIdentifier(value: string, what: string): string {
  if (!/^(v3:|v4:)?0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`Refusing to interpolate ${what} into SQL: ${JSON.stringify(value)}`);
  }
  return value;
}

function checkAnchors(anchors: PriceAnchors): PriceAnchors {
  return {
    ...anchors,
    weth: safeIdentifier(anchors.weth, 'WETH address'),
    usdg: safeIdentifier(anchors.usdg, 'USDG address'),
    anchorPoolId: anchors.anchorPoolId
      ? safeIdentifier(anchors.anchorPoolId, 'anchor pool id')
      : null,
  };
}

/**
 * `(sqrtPriceX96 / 2^96)^2 * 10^(d0 - d1)` — token1 per token0, in human
 * units, over `numeric`.
 *
 * The decimals shift is applied to the numerator before the division rather
 * than after, so a pair like WETH(18)/USDG(6) — whose wei ratio is about
 * 4e8 one way and 2.5e-9 the other — keeps its significant digits instead of
 * being divided down into numeric's minimum scale first.
 */
function ratioSql(sqrt: string, dec0: string, dec1: string): string {
  return `(
    (power(${sqrt}::numeric, 2) * power(10::numeric, GREATEST(${dec0} - ${dec1}, 0)))
    / power(2::numeric, 192)
    / power(10::numeric, GREATEST(${dec1} - ${dec0}, 0))
  )`;
}

const SWAP_RATIO = ratioSql('sw.sqrt_price_x96', 't0.decimals', 't1.decimals');

/**
 * Which side of a pool is the TOKEN and which is the QUOTE.
 *
 * One rule, exported, used by both this file and the API's snapshot query —
 * because they disagreed once and the WETH/USDG pool rendered as "WETH ·
 * $1.00": the row picked WETH as the token while the price came from USDG.
 *
 * The rule: the token is whichever side is not the quote, and **USDG outranks
 * WETH as a quote**. So a WETH/USDG pool is the WETH market priced in
 * dollars, not the USDG market priced in ether — which is both the useful
 * reading and the one that agrees with how the anchor is used (§4.3).
 *
 * `whenToken0` is the expression to use when token0 is the traded side, and
 * `whenToken1` when token1 is. Callers pass whatever they need selected:
 * a price column, a token's symbol, its decimals.
 */
export function tradedSide(args: {
  addr0: string;
  addr1: string;
  weth: string;
  usdg: string;
  whenToken0: string;
  whenToken1: string;
  otherwise?: string;
}): string {
  const { addr0, addr1, weth, usdg, whenToken0, whenToken1 } = args;
  return `CASE
    WHEN lower(${addr1}) = lower('${usdg}') THEN ${whenToken0}
    WHEN lower(${addr0}) = lower('${usdg}') THEN ${whenToken1}
    WHEN lower(${addr1}) = lower('${weth}') THEN ${whenToken0}
    WHEN lower(${addr0}) = lower('${weth}') THEN ${whenToken1}
    ELSE ${args.otherwise ?? 'NULL'}
  END`;
}

/** The hours a block range touched, as a SQL scalar subquery. */
function touchedHours(bounds: Bounds | undefined, table: string): string {
  if (!bounds) return `SELECT DISTINCT date_trunc('hour', block_time) AS hour FROM ${table}`;
  return `
    SELECT DISTINCT date_trunc('hour', block_time) AS hour
    FROM ${table}
    WHERE block_num >= ${bounds.fromBlock} AND block_num <= ${bounds.toBlock}`;
}

/**
 * Step 1 — `weth_usd_hourly`: WETH in USD, per hour, from the anchor pool.
 *
 * The last anchor swap in each hour sets that hour's price. Hours with no
 * anchor swap get no row; readers carry the previous price forward, because a
 * quiet hour in the anchor pool is not WETH becoming worthless.
 */
export async function rebuildAnchorPrices(
  anchors: PriceAnchors,
  bounds?: Bounds,
): Promise<number> {
  const { usdg, anchorPoolId } = checkAnchors(anchors);
  if (!anchorPoolId) return 0;

  const hourFilter = bounds
    ? `AND date_trunc('hour', sw.block_time) IN (${touchedHours(bounds, 'swap_events')})`
    : '';

  return prisma.$executeRawUnsafe(`
    INSERT INTO weth_usd_hourly (hour, weth_usd)
    SELECT DISTINCT ON (date_trunc('hour', sw.block_time))
      date_trunc('hour', sw.block_time) AS hour,
      ${sane(
        `CASE
           WHEN lower(p.token1) = lower('${usdg}') THEN ${SWAP_RATIO}
           WHEN lower(p.token0) = lower('${usdg}') THEN 1 / NULLIF(${SWAP_RATIO}, 0)
           ELSE NULL
         END`,
        MAX_SANE_PRICE_USD,
      )}::numeric(38,18) AS weth_usd
    FROM swap_events sw
    JOIN pools  p  ON p.id = sw.pool_id
    JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
    JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
    WHERE sw.pool_id = '${anchorPoolId}' ${hourFilter}
    ORDER BY date_trunc('hour', sw.block_time), sw.block_num DESC, sw.log_index DESC
    ON CONFLICT (hour) DO UPDATE SET weth_usd = EXCLUDED.weth_usd
  `);
}

/**
 * Step 2 — `pool_flow_hourly`: signed token flow per pool per hour.
 *
 * Swaps and liquidity events together, summed. A pool's reserves are the sum
 * of this table over all its hours, which is 24 rows a day per pool rather
 * than every event the pool ever emitted.
 */
export async function rebuildFlowHours(bounds?: Bounds): Promise<number> {
  const hourList = bounds
    ? `(${touchedHours(bounds, 'swap_events')})
       UNION
       (${touchedHours(bounds, 'liquidity_events')})`
    : `SELECT DISTINCT hour FROM (
         (SELECT DISTINCT date_trunc('hour', block_time) AS hour FROM swap_events)
         UNION
         (SELECT DISTINCT date_trunc('hour', block_time) AS hour FROM liquidity_events)
       ) h`;

  return prisma.$executeRawUnsafe(`
    WITH target AS (${hourList}),
    flows AS (
      SELECT pool_id, date_trunc('hour', block_time) AS hour, amount0, amount1
      FROM swap_events
      WHERE date_trunc('hour', block_time) IN (SELECT hour FROM target)
      UNION ALL
      SELECT pool_id, date_trunc('hour', block_time) AS hour, amount0, amount1
      FROM liquidity_events
      WHERE date_trunc('hour', block_time) IN (SELECT hour FROM target)
    )
    INSERT INTO pool_flow_hourly (pool_id, hour, delta0, delta1)
    SELECT pool_id, hour,
           SUM(amount0)::numeric(78,0),
           SUM(amount1)::numeric(78,0)
    FROM flows
    GROUP BY pool_id, hour
    ON CONFLICT (pool_id, hour) DO UPDATE SET
      delta0 = EXCLUDED.delta0,
      delta1 = EXCLUDED.delta1
  `);
}

/**
 * Step 3 — `pool_fee_hourly`: fees and volume per pool per hour, in USD.
 *
 * Scoped by hour rather than rebuilding the table, but an hour is recomputed
 * from every swap row in it, not from the new ones — so the result is
 * identical to a full rebuild, which is the §9 comparison.
 *
 * `fees_token0` and `fees_token1` are exact integer sums in the tokens
 * themselves: no price, no rounding, and the columns §9 compares byte for
 * byte. The USD columns are those sums valued at the hour's prices.
 */
export async function rebuildFeeHours(
  anchors: PriceAnchors,
  bounds?: Bounds,
): Promise<number> {
  const { weth, usdg } = checkAnchors(anchors);

  const hourFilter = bounds
    ? `AND date_trunc('hour', sw.block_time) IN (${touchedHours(bounds, 'swap_events')})`
    : '';

  return prisma.$executeRawUnsafe(`
    WITH
    -- The anchor price for each hour, carrying the last known one forward
    -- across hours where the anchor pool did not trade. The window-function
    -- gap fill is O(n log n); the correlated subquery it replaces was O(n^2).
    dense AS (
      SELECT h.hour, w.weth_usd,
             count(w.weth_usd) OVER (ORDER BY h.hour) AS grp
      FROM (SELECT DISTINCT date_trunc('hour', block_time) AS hour FROM swap_events) h
      LEFT JOIN weth_usd_hourly w ON w.hour = h.hour
    ),
    weth_usd AS (
      SELECT hour,
             first_value(weth_usd) OVER (PARTITION BY grp ORDER BY hour) AS weth_usd
      FROM dense
    ),

    -- Each swap, with the USD price of both of its tokens at its own hour.
    priced AS (
      SELECT
        sw.pool_id,
        date_trunc('hour', sw.block_time) AS hour,
        sw.fee_amount,
        sw.fee_token,
        sw.amount0,
        sw.amount1,
        t0.decimals AS dec0,
        t1.decimals AS dec1,
        ${SWAP_RATIO} AS ratio,
        CASE
          WHEN lower(p.token1) = lower('${weth}') THEN wu.weth_usd
          WHEN lower(p.token1) = lower('${usdg}') THEN 1::numeric
          ELSE NULL
        END AS quote1_usd,
        CASE
          WHEN lower(p.token0) = lower('${weth}') THEN wu.weth_usd
          WHEN lower(p.token0) = lower('${usdg}') THEN 1::numeric
          ELSE NULL
        END AS quote0_usd
      FROM swap_events sw
      JOIN pools    p  ON p.id = sw.pool_id
      JOIN tokens   t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens   t1 ON lower(t1.address) = lower(p.token1)
      LEFT JOIN weth_usd wu ON wu.hour = date_trunc('hour', sw.block_time)
      WHERE true ${hourFilter}
    ),

    -- Resolve each token's USD price from whichever side is the quote, and
    -- discard anything outside a sane bound rather than carrying it forward.
    usd AS (
      SELECT
        pool_id, hour, fee_amount, fee_token, amount0, amount1, dec0, dec1,
        ${sane(
          `COALESCE(quote0_usd, CASE WHEN quote1_usd IS NOT NULL THEN ratio * quote1_usd END)`,
          MAX_SANE_PRICE_USD,
        )} AS price0_usd,
        ${sane(
          `COALESCE(quote1_usd, CASE WHEN quote0_usd IS NOT NULL AND ratio > 0 THEN quote0_usd / ratio END)`,
          MAX_SANE_PRICE_USD,
        )} AS price1_usd
      FROM priced
    )

    INSERT INTO pool_fee_hourly (pool_id, hour, fees_token0, fees_token1, fees_usd, volume_usd, swaps)
    SELECT
      pool_id,
      hour,
      SUM(CASE WHEN fee_token = 0 THEN fee_amount ELSE 0 END)::numeric(78,0),
      SUM(CASE WHEN fee_token = 1 THEN fee_amount ELSE 0 END)::numeric(78,0),
      -- Fees in USD, each valued in the token it was actually taken in.
      COALESCE(${sane(
        `SUM(
          CASE
            WHEN fee_token = 0 THEN fee_amount / power(10::numeric, dec0) * COALESCE(price0_usd, 0)
            WHEN fee_token = 1 THEN fee_amount / power(10::numeric, dec1) * COALESCE(price1_usd, 0)
            ELSE 0
          END
        )`,
        MAX_SANE_TOTAL_USD,
      )}, 0)::numeric(38,18),
      -- Volume is the side that entered the pool, valued the same way.
      COALESCE(${sane(
        `SUM(
          CASE
            WHEN amount0 > 0 THEN amount0 / power(10::numeric, dec0) * COALESCE(price0_usd, 0)
            WHEN amount1 > 0 THEN amount1 / power(10::numeric, dec1) * COALESCE(price1_usd, 0)
            ELSE 0
          END
        )`,
        MAX_SANE_TOTAL_USD,
      )}, 0)::numeric(38,18),
      COUNT(*)::int
    FROM usd
    GROUP BY pool_id, hour
    ON CONFLICT (pool_id, hour) DO UPDATE SET
      fees_token0 = EXCLUDED.fees_token0,
      fees_token1 = EXCLUDED.fees_token1,
      fees_usd    = EXCLUDED.fees_usd,
      volume_usd  = EXCLUDED.volume_usd,
      swaps       = EXCLUDED.swaps
  `);
}

/**
 * Step 4 — `pool_state`: the latest price, tick, liquidity and the TVL
 * derived from reserves.
 *
 * Reserves come from `pool_flow_hourly`, not from the raw tables, so this is
 * a sum over a small table. The latest price comes from a `DISTINCT ON`
 * backed by the `(pool_id, block_num, log_index)` index.
 */
export async function rebuildPoolState(anchors: PriceAnchors): Promise<number> {
  const { weth, usdg } = checkAnchors(anchors);

  return prisma.$executeRawUnsafe(`
    WITH
    -- The most recent anchor price we have. One row.
    weth_usd AS (
      SELECT weth_usd AS usd FROM weth_usd_hourly ORDER BY hour DESC LIMIT 1
    ),

    -- Latest on-chain state per pool: the most recent swap wins.
    last_swap AS (
      SELECT DISTINCT ON (pool_id)
        pool_id, sqrt_price_x96, tick, liquidity, block_time
      FROM swap_events
      ORDER BY pool_id, block_num DESC, log_index DESC
    ),

    -- Reserves: the staged hourly flow, summed.
    reserves AS (
      SELECT pool_id, SUM(delta0) AS r0, SUM(delta1) AS r1
      FROM pool_flow_hourly
      GROUP BY pool_id
    ),

    base AS (
      SELECT
        p.id AS pool_id,
        COALESCE(ls.sqrt_price_x96, 0) AS sqrt_price_x96,
        COALESCE(ls.tick, 0) AS tick,
        COALESCE(ls.liquidity, 0) AS liquidity,
        COALESCE(ls.block_time, p.created_at) AS updated_at,
        COALESCE(r.r0, 0) AS r0,
        COALESCE(r.r1, 0) AS r1,
        t0.decimals AS dec0,
        t1.decimals AS dec1,
        t0.address  AS addr0,
        t1.address  AS addr1,
        t0.total_supply AS supply0,
        t1.total_supply AS supply1,
        CASE WHEN ls.sqrt_price_x96 IS NULL THEN NULL ELSE
          ${ratioSql('ls.sqrt_price_x96', 't0.decimals', 't1.decimals')}
        END AS ratio,
        (SELECT usd FROM weth_usd) AS weth_usd
      FROM pools p
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      LEFT JOIN last_swap ls ON ls.pool_id = p.id
      LEFT JOIN reserves  r  ON r.pool_id  = p.id
    ),

    quoted AS (
      SELECT *,
        CASE
          WHEN lower(addr0) = lower('${weth}') THEN weth_usd
          WHEN lower(addr0) = lower('${usdg}') THEN 1::numeric
          ELSE NULL
        END AS quote0_usd,
        CASE
          WHEN lower(addr1) = lower('${weth}') THEN weth_usd
          WHEN lower(addr1) = lower('${usdg}') THEN 1::numeric
          ELSE NULL
        END AS quote1_usd
      FROM base
    ),

    priced AS (
      SELECT *,
        ${sane(
          `COALESCE(quote0_usd, CASE WHEN quote1_usd IS NOT NULL THEN ratio * quote1_usd END)`,
          MAX_SANE_PRICE_USD,
        )} AS price0_usd,
        ${sane(
          `COALESCE(quote1_usd, CASE WHEN quote0_usd IS NOT NULL AND ratio > 0 THEN quote0_usd / ratio END)`,
          MAX_SANE_PRICE_USD,
        )} AS price1_usd
      FROM quoted
    )

    INSERT INTO pool_state (pool_id, tvl_usd, price_usd, mc_usd, sqrt_price_x96, tick, liquidity, updated_at)
    SELECT
      pool_id,
      -- Both sides at their own prices. Never doubled from one side, never
      -- negative, and zero rather than absurd.
      --
      -- Reserves negative on either side mean we never saw this pool's
      -- initial mint: START_BLOCK was above its creation block, so the
      -- events we have are outflows without the inflow that funded them.
      -- Its real depth is UNKNOWN, not zero. Zero is what we record, and the
      -- consequence is deliberate: a zero divisor makes the yield an em dash
      -- (§7) instead of a number divided by a divisor we know is wrong. The
      -- poller logs the skipped events so the cause is findable.
      CASE WHEN r0 < 0 OR r1 < 0 THEN 0 ELSE
        GREATEST(COALESCE(${sane(
          `COALESCE(r0 / power(10::numeric, dec0) * COALESCE(price0_usd, 0), 0)
           + COALESCE(r1 / power(10::numeric, dec1) * COALESCE(price1_usd, 0), 0)`,
          MAX_SANE_TOTAL_USD,
        )}, 0), 0)
      END::numeric(38,18),
      -- "The pool's price" is the traded side, by the one rule in tradedSide.
      GREATEST(COALESCE(${tradedSide({
        addr0: 'addr0',
        addr1: 'addr1',
        weth,
        usdg,
        whenToken0: 'price0_usd',
        whenToken1: 'price1_usd',
        otherwise: '0',
      })}, 0), 0)::numeric(38,18),
      -- Fully diluted value: the traded token's TOTAL supply times its price.
      --
      -- Not market cap. Circulating supply is not distinguishable on chain —
      -- locked, vested and treasury-held tokens are all inside totalSupply —
      -- so this figure is FDV and the UI labels it that way (§7). Calling it
      -- market cap would overstate every token with a vesting schedule.
      --
      -- Zero when the supply has not been read, which renders as an em dash.
      GREATEST(COALESCE(${sane(
        tradedSide({
          addr0: 'addr0',
          addr1: 'addr1',
          weth,
          usdg,
          whenToken0: 'supply0 / power(10::numeric, dec0) * price0_usd',
          whenToken1: 'supply1 / power(10::numeric, dec1) * price1_usd',
          otherwise: 'NULL',
        }),
        MAX_SANE_TOTAL_USD,
      )}, 0), 0)::numeric(38,18),
      sqrt_price_x96::numeric(78,0),
      tick,
      liquidity::numeric(78,0),
      updated_at
    FROM priced
    ON CONFLICT (pool_id) DO UPDATE SET
      tvl_usd        = EXCLUDED.tvl_usd,
      price_usd      = EXCLUDED.price_usd,
      mc_usd         = EXCLUDED.mc_usd,
      sqrt_price_x96 = EXCLUDED.sqrt_price_x96,
      tick           = EXCLUDED.tick,
      liquidity      = EXCLUDED.liquidity,
      updated_at     = EXCLUDED.updated_at
  `);
}

/**
 * All four steps, in order. The order is not arbitrary: fee valuation reads
 * the anchor series, and pool state reads the staged flow.
 */
export async function rebuildAggregates(
  anchors: PriceAnchors,
  bounds?: Bounds,
  options: { poolState?: boolean } = {},
): Promise<void> {
  await rebuildAnchorPrices(anchors, bounds);
  await rebuildFlowHours(bounds);
  await rebuildFeeHours(anchors, bounds);
  // Pool state is the one step that is NOT scoped to the hours a pass
  // touched: it reads every pool's last swap and sums every flow hour. The
  // poller skips it on most backfill passes and always runs it once caught
  // up — it is rebuilt from the tables below, so when it runs changes
  // nothing about what it produces.
  if (options.poolState !== false) await rebuildPoolState(anchors);
}
