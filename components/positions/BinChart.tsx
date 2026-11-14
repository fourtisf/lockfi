'use client';

import type { ShapeId } from '@/lib/data/types';
import { price as fmtPrice } from '@/lib/format';

const H = 320;
const W = 800;
const PAD = 34;

export function BinChart({
  weights,
  minPct,
  maxPct,
  currentPrice,
  shape,
  symbol,
}: {
  weights: number[];
  minPct: number;
  maxPct: number;
  currentPrice: number;
  shape: ShapeId;
  symbol: string;
}) {
  const n = weights.length;
  const bw = (W - PAD * 2) / n;
  const max = Math.max(...weights);
  const span = maxPct - minPct || 1;
  // Where the current price sits inside the chosen range.
  const priceX = PAD + ((0 - minPct) / span) * (W - PAD * 2);
  const lo = currentPrice * (1 + minPct);
  const hi = currentPrice * (1 + maxPct);

  return (
    <div className="bins-wrap">
      <svg
        className="bins"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${shape} liquidity across ${n} bins, from ${fmtPrice(lo)} to ${fmtPrice(
          hi,
        )}, with ${symbol} at ${fmtPrice(currentPrice)}`}
      >
        {weights.map((w, i) => {
          const x = PAD + i * bw;
          const h = (w / max) * (H - 70);
          // Above the current price the bin is held as the token; below it, WETH.
          const tokenSide = x + bw / 2 > priceX;
          return (
            <rect
              key={i}
              x={x + 1}
              y={H - 40 - h}
              width={bw - 2}
              height={h}
              rx={2}
              fill={tokenSide ? 'var(--ac)' : 'var(--ac-3)'}
            />
          );
        })}
        <line
          x1={priceX}
          x2={priceX}
          y1={14}
          y2={H - 40}
          stroke="var(--fg-2)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="bins-now"
        style={{ left: `${(priceX / W) * 100}%` }}
        aria-hidden="true"
      >
        now
      </span>
      <div className="bins-axis num" aria-hidden="true">
        <span>{fmtPrice(lo)}</span>
        <span>{fmtPrice(hi)}</span>
      </div>
    </div>
  );
}
