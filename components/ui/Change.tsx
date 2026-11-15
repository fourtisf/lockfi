import { signOf } from '@/lib/format';

/**
 * A 24h move. Green up, red down — the only two colours a number gets (§19).
 * No move at all is neither: a live pool with no swaps in a day showed
 * "▲ +0.0%" in green. And no figure at all is an em dash, not 0.0%.
 */
export function Change({ pct }: { pct: number | null }) {
  // No price to compare against: unknown, which is not the same as flat.
  if (pct === null) {
    return (
      <span className="chg muted" title="No trade to compare against in the last 24h">
        —
      </span>
    );
  }
  const s = signOf(pct, 1);
  if (s === 0) return <span className="chg">0.0%</span>;
  return (
    <span className={`chg ${s > 0 ? 'up' : 'down'}`}>
      {s > 0 ? '▲' : '▼'} {s > 0 ? '+' : '−'}
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}
