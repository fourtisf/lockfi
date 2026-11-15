import { signOf } from '@/lib/format';
import { FULL_DAY_REF_HOURS } from '@/lib/pools';

/**
 * A 24h move. Green up, red down — the only two colours a number gets (§19).
 * No move at all is neither: a live pool with no swaps in a day showed
 * "▲ +0.0%" in green. And no figure at all is an em dash, not 0.0%.
 */
export function Change({ pct, refHours }: { pct: number | null; refHours?: number | null }) {
  // No price to compare against: unknown, which is not the same as flat.
  if (pct === null) {
    return (
      <span className="chg muted" title="No trade to compare against in the last 24h">
        —
      </span>
    );
  }
  // Measured from the first trade inside the day rather than from 24h ago:
  // said, with how long ago, so a launch-day move is not read as a day's.
  const partial = refHours != null && refHours < FULL_DAY_REF_HOURS;
  const since = partial ? `${Math.max(1, Math.round(refHours))}h` : null;
  const title = partial
    ? `Change since this pool's first trade in the last 24h, ${since} ago — it has no trade from 24h ago to compare with`
    : undefined;
  const s = signOf(pct, 1);
  if (s === 0)
    return (
      <span className="chg" title={title}>
        0.0%{since && <small className="chg-since"> {since}</small>}
      </span>
    );
  return (
    <span className={`chg ${s > 0 ? 'up' : 'down'}`} title={title}>
      {s > 0 ? '▲' : '▼'} {s > 0 ? '+' : '−'}
      {Math.abs(pct).toFixed(1)}%{since && <small className="chg-since"> {since}</small>}
    </span>
  );
}
