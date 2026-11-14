'use client';

import { weth } from '@/lib/format';

/** Rows of the screen-reader table; the visual grid is a week per column. */
const DAYS_PER_ROW = 7;

/**
 * Eight weeks of daily WETH fees. Brighter green = more fees.
 *
 * The grid itself is decorative — every value it encodes is also written out
 * in the summary below it, which is where a screen reader reads the data from.
 */
export function FeeHeatmap({ values }: { values: number[] }) {
  const max = Math.max(...values, 0.0001);
  const total = values.reduce((a, v) => a + v, 0);
  const best = values.reduce((a, v) => Math.max(a, v), 0);

  const weeks: number[][] = [];
  for (let i = 0; i < values.length; i += DAYS_PER_ROW) {
    weeks.push(values.slice(i, i + DAYS_PER_ROW));
  }

  return (
    <>
      <div className="cal" aria-hidden="true">
        {values.map((v, i) => {
          const intensity = v / max;
          return (
            <div
              key={i}
              style={{
                background:
                  intensity < 0.08
                    ? 'var(--raise)'
                    : `color-mix(in srgb, var(--ac) ${Math.round(
                        12 + intensity * 88,
                      )}%, var(--raise))`,
              }}
              title={weth(v)}
            />
          );
        })}
      </div>

      <div className="cal-axis" aria-hidden="true">
        <span>8 weeks ago</span>
        <span>this week</span>
      </div>

      <p className="hint">
        {weth(total)} over {values.length} days · best day {weth(best)}
      </p>

      {/* A block wrapper does the clipping: overflow:hidden is ignored on a
          table box, so an unwrapped sr-only table widens the whole page. */}
      <div className="sr-only">
        <table>
          <caption>Daily fees over the last 8 weeks, oldest first</caption>
          <tbody>
            {weeks.map((week, w) => (
              <tr key={w}>
                <th scope="row">
                  Days {w * DAYS_PER_ROW + 1}–{w * DAYS_PER_ROW + week.length}
                </th>
                {week.map((v, d) => (
                  <td key={d}>{weth(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
