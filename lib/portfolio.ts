/**
 * How the latest seven days of fees compare with the weeks before them.
 *
 * The prototype printed "Best week so far" under the 7d figure as a constant
 * string. It was true of the seed data and would have kept saying so in a
 * week that was the worst on record. This computes it.
 *
 * `daily` is oldest first; whole weeks are counted back from the newest day,
 * and a partial week at the old end is ignored rather than compared unfairly.
 */
export function weekOverWeek(daily: number[]): {
  lastWeek: number;
  /** Percent change against the week before, or null with no week before. */
  changePct: number | null;
  /** True when the latest week beats every complete week before it. */
  isBest: boolean;
} {
  const weeks: number[] = [];
  for (let end = daily.length; end - 7 >= 0; end -= 7) {
    weeks.push(daily.slice(end - 7, end).reduce((a, v) => a + v, 0));
  }
  const [lastWeek = 0, prev, ...older] = weeks;
  if (prev === undefined) return { lastWeek, changePct: null, isBest: false };
  const changePct = prev > 0 ? ((lastWeek - prev) / prev) * 100 : null;
  const isBest = [prev, ...older].every((w) => lastWeek > w);
  return { lastWeek, changePct, isBest };
}
