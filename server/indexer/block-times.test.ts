/**
 * Block times from anchors: exact hours, bounded seconds, the same answer
 * however the windows fall.
 */

import { describe, expect, it } from 'vitest';
import { ANCHOR_SPACING, anchorsOf, plan, resolve } from './block-times';

const t = (iso: string) => new Date(iso);

describe('block times from anchors', () => {
  it('asks only for the anchors around a dense run of blocks', () => {
    const blocks = Array.from({ length: 500 }, (_, i) => 4_408_304n + BigInt(i));
    const { anchors, exact } = plan(blocks, 5_000_000n);
    // 500 blocks with a log in every one: 9 anchors instead of 500 requests.
    expect(anchors.size).toBeLessThanOrEqual(10);
    expect(exact.size).toBe(0);
  });

  it('fetches a block itself when its upper anchor does not exist yet', () => {
    const { exact } = plan([1_000_001n], 1_000_010n);
    expect([...exact]).toEqual([1_000_001n]);
  });

  it('interpolates inside an hour and five minutes, never outside the anchors', () => {
    const [lo, hi] = anchorsOf(4_408_330n);
    const known = new Map([
      [lo, t('2026-07-08T10:20:00Z')],
      [hi, t('2026-07-08T10:20:06Z')],
    ]);
    const { times, unresolved } = resolve([4_408_330n], known);
    expect(unresolved).toEqual([]);
    const got = times.get(4_408_330n)!.getTime();
    expect(got).toBeGreaterThanOrEqual(known.get(lo)!.getTime());
    expect(got).toBeLessThanOrEqual(known.get(hi)!.getTime());
    // Whole seconds, so it is a pure function of the block number.
    expect(got % 1000).toBe(0);
  });

  it('will not guess across an hour boundary, or across more than five minutes', () => {
    const block = 3n * ANCHOR_SPACING + 5n;
    const [lo, hi] = anchorsOf(block);
    const acrossHour = new Map([
      [lo, t('2026-07-08T10:59:58Z')],
      [hi, t('2026-07-08T11:00:03Z')],
    ]);
    expect(resolve([block], acrossHour).unresolved).toEqual([block]);
    const quiet = new Map([
      [lo, t('2026-07-08T10:00:00Z')],
      [hi, t('2026-07-08T10:10:00Z')],
    ]);
    expect(resolve([block], quiet).unresolved).toEqual([block]);
  });

  it('uses a block\'s own time whenever it has one', () => {
    const own = t('2026-07-08T10:20:03Z');
    const { times } = resolve([4_408_330n], new Map([[4_408_330n, own]]));
    expect(times.get(4_408_330n)).toEqual(own);
  });
});
