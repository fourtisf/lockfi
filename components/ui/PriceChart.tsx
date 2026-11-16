'use client';

import { useState } from 'react';

/**
 * A price line: one close an hour (server/api/chart.ts), one series in the
 * brand colour (§19: a single chart series is identity, not gain or loss).
 *
 * Not anchored at zero, unlike the featured card's area chart: a price lives
 * far from zero and a zero-anchored line is flat. So the range it draws is
 * printed beside it — the high and the low — and the hover reads the exact
 * close, so the line's slope cannot be read as larger than it is.
 *
 * Points are placed by their time, not their index: an hour nobody traded
 * has no point, and the line runs straight across it rather than squeezing
 * the gap shut.
 */
export function PriceChart({
  points,
  formatValue,
  height = 200,
  caption,
}: {
  points: { t: string; p: number }[];
  formatValue: (v: number) => string;
  height?: number;
  caption: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  if (n < 2) return null;
  const times = points.map((p) => new Date(p.t).getTime());
  const t0 = times[0];
  const span = Math.max(1, times[n - 1] - t0);
  const values = points.map((p) => p.p);
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const pad = (hi - lo) * 0.12 || hi * 0.02 || 1;
  const top = hi + pad;
  const bottom = lo - pad;
  // The right edge is kept clear for the high / low labels.
  const xMax = 86;
  const x = (i: number) => ((times[i] - t0) / span) * xMax;
  const y = (v: number) => ((top - v) / (top - bottom)) * 100;
  const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const last = n - 1;
  const at = hover ?? last;
  const when = (i: number) =>
    new Date(points[i].t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC' }) + ' UTC';

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width / (xMax / 100);
    const target = t0 + Math.max(0, Math.min(1, frac)) * span;
    // The nearest close in time.
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(times[i] - target) < Math.abs(times[best] - target)) best = i;
    setHover(best);
  };

  return (
    <figure className="pc" style={{ margin: 0 }}>
      <div
        className="area pc-area"
        style={{ height }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${caption}. High ${formatValue(hi)}, low ${formatValue(lo)}, latest ${formatValue(values[last])}.`}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[25, 50, 75].map((g) => (
            <line key={g} x1="0" x2={xMax} y1={g} y2={g} stroke="var(--bd-n)" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1="0" x2={xMax} y1={y(hi)} y2={y(hi)} stroke="var(--bd)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={xMax} y1={y(lo)} y2={y(lo)} stroke="var(--bd)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1="0" y2="100" stroke="var(--fg-3)" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <span className="pc-lim num" style={{ top: `${y(hi)}%` }}>
          {formatValue(hi)}
        </span>
        <span className="pc-lim num" style={{ top: `${y(lo)}%` }}>
          {formatValue(lo)}
        </span>
        <span className="end" style={{ left: `${x(at)}%`, top: `${y(values[at])}%` }} />
        <span
          className={`end-l${hover !== null ? ' hov' : ''}${x(at) < 45 ? ' right' : ''}`}
          style={{ left: `${x(at)}%`, top: `${y(values[at])}%` }}
        >
          {formatValue(values[at])}
          <span className="muted"> · {hover !== null ? when(hover) : 'latest close'}</span>
        </span>
      </div>
      <figcaption className="area-axis" style={{ paddingRight: `${100 - xMax}%` }}>
        <span>{when(0)}</span>
        <span>{when(last)}</span>
      </figcaption>
    </figure>
  );
}
