'use client';

import { useId } from 'react';
import { BRAND } from '@/lib/site';

/**
 * The Tidewell mark: a well seen from above, filled to the tide line.
 *
 * The ring is the well; the water inside it is a wave, so the level reads as
 * something that rises and falls. That is the product's one promise in a
 * picture: the yield fills with real trading volume and drops when it drops.
 *
 * Construction, on a 32 × 32 grid:
 *
 *   ring           centre (16, 16), radius 12.2, stroke 2.4
 *   water          clipped to radius 11, so a 1.2-unit gap separates it from
 *                  the ring at every size down to a 16px favicon
 *   tide line      a sine wave of four half-periods from x = 3 to x = 29.4,
 *                  mean height y = 17.5, amplitude 2.4
 *
 * The distributable files in brand/ are generated from these same numbers by
 * scripts/build-brand.py — change one, rerun `npm run brand`.
 */

export const MARK = {
  ring: { cx: 16, cy: 16, r: 12.2, stroke: 2.4 },
  clipR: 11,
  water:
    'M3 17.5c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0 4.4 2.4 6.6 0V30H3z',
} as const;

export interface MarkProps {
  /** Rendered size in px. */
  size?: number;
  /** Any CSS colour. Defaults to the brand teal. */
  color?: string;
  title?: string;
  className?: string;
}

export function Mark({ size = 32, color = 'var(--ac)', title, className }: MarkProps) {
  // A clip path id has to be unique on the page; the mark appears more than once.
  const clip = `tw-${useId().replace(/:/g, '')}`;
  const labelled = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true };

  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} {...labelled}>
      <defs>
        <clipPath id={clip}>
          <circle cx={MARK.ring.cx} cy={MARK.ring.cy} r={MARK.clipR} />
        </clipPath>
      </defs>
      <circle
        cx={MARK.ring.cx}
        cy={MARK.ring.cy}
        r={MARK.ring.r}
        fill="none"
        stroke={color}
        strokeWidth={MARK.ring.stroke}
      />
      <path d={MARK.water} fill={color} clipPath={`url(#${clip})`} />
    </svg>
  );
}

/** Mark plus wordmark, in Sora at 600 — the display face the app ships. */
export function Lockup({
  size = 28,
  color,
  wordColor = 'var(--fg)',
}: {
  size?: number;
  color?: string;
  wordColor?: string;
}) {
  return (
    <span className="lockup" style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.34 }}>
      <Mark size={size} color={color} />
      <span
        style={{
          fontFamily: 'var(--disp)',
          fontSize: size * 0.76,
          fontWeight: 600,
          letterSpacing: '-.02em',
          color: wordColor,
          lineHeight: 1,
        }}
      >
        {BRAND}
      </span>
    </span>
  );
}
