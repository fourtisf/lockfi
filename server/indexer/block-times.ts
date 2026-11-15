/**
 * Block timestamps from anchors, so a dense stretch does not cost one RPC
 * call per block.
 *
 * Every event needs chain time (§7). Where a launch is swapped on almost
 * every block, that was a timestamp request per block: the public endpoint
 * rate-limits after a few hundred, and a 500-block pass took 45 seconds —
 * slower than the chain makes blocks, so the indexer could never catch up.
 *
 * Arbitrum timestamps never go backwards, so a block between two others has
 * a time between theirs. Fetch exact times only at fixed anchors — every
 * 64th block — and every block between two anchors is bounded by them:
 *
 *   - If both anchors fall in the same clock hour, so does every block
 *     between: the hour, which is all `pool_fee_hourly` uses, is EXACT.
 *   - If they are also within five minutes of each other, the block's time
 *     is interpolated between them, so a stored `block_time` is at most that
 *     far off — and its hour is still exact. (A minute was tried first: in
 *     the chain's early months blocks came about once a second, 64 of them
 *     spanned just over a minute, and nearly every block was fetched anyway.)
 *     Fixed anchors make it a pure function of the block number,
 *     so a replay with different windows stores the same value (§9).
 *   - Otherwise — an hour boundary between them, or a quiet stretch where 64
 *     blocks span more than five minutes — the block's own time is fetched.
 *     Quiet stretches have few events, so that is cheap exactly where it
 *     happens.
 */

export const ANCHOR_SPACING = 64n;
export const MAX_ANCHOR_GAP_S = 300;

const HOUR_MS = 3_600_000;

/** The anchors around a block: the multiple of the spacing at or below it, and the next. */
export function anchorsOf(block: bigint): [bigint, bigint] {
  const lower = block - (block % ANCHOR_SPACING);
  return [lower, lower + ANCHOR_SPACING];
}

/**
 * What to fetch for these blocks: the anchors, and the blocks that must be
 * fetched themselves because an anchor would lie beyond `head`.
 */
export function plan(blocks: Iterable<bigint>, head: bigint): { anchors: Set<bigint>; exact: Set<bigint> } {
  const anchors = new Set<bigint>();
  const exact = new Set<bigint>();
  for (const block of blocks) {
    const [lower, upper] = anchorsOf(block);
    if (block === lower) anchors.add(block);
    else if (upper > head) exact.add(block);
    else {
      anchors.add(lower);
      anchors.add(upper);
    }
  }
  return { anchors, exact };
}

/**
 * Times for the blocks the anchors can bound, and the blocks they cannot.
 * `known` holds exact times (anchors and any block fetched itself).
 */
export function resolve(
  blocks: Iterable<bigint>,
  known: Map<bigint, Date>,
): { times: Map<bigint, Date>; unresolved: bigint[] } {
  const times = new Map<bigint, Date>();
  const unresolved: bigint[] = [];
  for (const block of blocks) {
    const own = known.get(block);
    if (own) {
      times.set(block, own);
      continue;
    }
    const [lower, upper] = anchorsOf(block);
    const a = known.get(lower);
    const b = known.get(upper);
    if (
      a &&
      b &&
      Math.floor(a.getTime() / HOUR_MS) === Math.floor(b.getTime() / HOUR_MS) &&
      b.getTime() - a.getTime() <= MAX_ANCHOR_GAP_S * 1000
    ) {
      const spanS = (b.getTime() - a.getTime()) / 1000;
      const offset = Math.floor((spanS * Number(block - lower)) / Number(ANCHOR_SPACING));
      times.set(block, new Date(a.getTime() + offset * 1000));
    } else {
      unresolved.push(block);
    }
  }
  return { times, unresolved };
}
