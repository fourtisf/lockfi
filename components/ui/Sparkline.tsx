'use client';

import { useState } from 'react';

/**
 * A row sparkline: the shape of recent fees.
 *
 * Neutral ink, not green or red. It encodes shape, not gain or loss, and §5
 * gives green and red to numbers that are positive or negative. The latest
 * point carries a dot so the eye lands on "now".
 *
 * Drawn in a viewBox the size it renders at, so the dot stays round.
 */
export function Spark({
  values,
  w = 64,
  h = 24,
  className = 'mini',
}: {
  values: number[];
  w?: number;
  h?: number;
  className?: string;
}) {
  const pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => [
    pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2),
    pad + (1 - (v - min) / range) * (h - pad * 2),
  ]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1] ?? [0, 0];

  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} style={{ width: w, height: h }} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.4} fill="var(--fg-2)" />
    </svg>
  );
}

/**
 * The featured card's area chart.
 *
 * Geometry is a stretched SVG; every label is HTML. Nothing text-shaped is
 * ever scaled, and nothing is drawn over a number — the prototype's
 * full-bleed chart ran straight through the metrics above it. The y-range is
 * anchored at zero so the area's height means what it looks like it means.
 */
export function AreaChart({
  values,
  axis,
  pointLabel,
  formatValue,
  height = 140,
  caption,
}: {
  values: number[];
  /** Labels spread evenly under the chart, oldest first. */
  axis: string[];
  /** Names a point for the hover readout, e.g. "36h ago". */
  pointLabel: (index: number) => string;
  formatValue: (v: number) => string;
  height?: number;
  caption: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const max = Math.max(...values, 0) * 1.15 || 1;
  // The right edge is kept clear for the endpoint label.
  const xMax = 88;
  const x = (i: number) => (i / Math.max(1, n - 1)) * xMax;
  const y = (v: number) => 100 - (v / max) * 92;
  const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const last = n - 1;
  const at = hover ?? last;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width / (xMax / 100);
    setHover(Math.max(0, Math.min(last, Math.round(frac * last))));
  };

  return (
    <figure style={{ margin: 0 }}>
      <div
        className="area"
        style={{ height }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${caption}. Latest ${formatValue(values[last] ?? 0)}.`}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--ac)" stopOpacity=".2" />
              <stop offset="1" stopColor="var(--ac)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[25, 50, 75].map((g) => (
            <line key={g} x1="0" x2={xMax} y1={g} y2={g} stroke="var(--bd-n)" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1="0" x2={xMax} y1="100" y2="100" stroke="var(--bd)" vectorEffect="non-scaling-stroke" />
          <polygon points={`0,100 ${line} ${x(last)},100`} fill="url(#area-fill)" />
          <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1="0" y2="100" stroke="var(--fg-3)" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <span className="end" style={{ left: `${x(at)}%`, top: `${y(values[at] ?? 0)}%` }} />
        <span
          // Sits above-left of the point, so it can never run off the card's
          // right edge; near the left edge it swaps sides.
          className={`end-l${hover !== null ? ' hov' : ''}${x(at) < 45 ? ' right' : ''}`}
          style={{ left: `${x(at)}%`, top: `${y(values[at] ?? 0)}%` }}
        >
          {formatValue(values[at] ?? 0)}
          {hover !== null && <span className="muted"> · {pointLabel(hover)}</span>}
        </span>
      </div>
      <figcaption className="area-axis" style={{ paddingRight: `${100 - xMax}%` }}>
        {axis.map((a) => (
          <span key={a}>{a}</span>
        ))}
      </figcaption>
    </figure>
  );
}
