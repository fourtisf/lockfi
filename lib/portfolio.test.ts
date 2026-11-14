import { describe, expect, it } from 'vitest';
import { weekOverWeek } from './portfolio';

const week = (v: number) => Array<number>(7).fill(v / 7);

describe('weekOverWeek', () => {
  it('calls the latest week the best only when it beats every earlier one', () => {
    expect(weekOverWeek([...week(1), ...week(2), ...week(3)]).isBest).toBe(true);
    expect(weekOverWeek([...week(5), ...week(2), ...week(3)]).isBest).toBe(false);
  });

  it('is not "best" on a tie', () => {
    expect(weekOverWeek([...week(3), ...week(3)]).isBest).toBe(false);
  });

  it('compares with the week before', () => {
    const r = weekOverWeek([...week(2), ...week(3)]);
    expect(r.lastWeek).toBeCloseTo(3);
    expect(r.changePct).toBeCloseTo(50);
  });

  it('has nothing to compare with a single week', () => {
    expect(weekOverWeek(week(3))).toEqual({ lastWeek: expect.closeTo(3), changePct: null, isBest: false });
  });

  it('ignores a partial week at the old end', () => {
    // Two loose days of 100 must not make the latest week look worse.
    const r = weekOverWeek([100, 100, ...week(1), ...week(2)]);
    expect(r.isBest).toBe(true);
  });
});
