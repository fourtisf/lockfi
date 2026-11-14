'use client';

import { useState } from 'react';
import { monogram, tokenMark } from '@/lib/token-mark';
import type { TokenMeta } from '@/lib/data/types';

/**
 * The circular token badge.
 *
 * A real logo when a token list gave us one — §4 allows logos and token
 * metadata from external sources, and numbers from none — and otherwise a
 * mark derived from the token's own address: a fixed-weight disc whose hue is
 * unique to that address, with the ticker's first two characters on it.
 *
 * The derived mark is not a fallback in the apologetic sense. Most tokens on
 * a new chain are in no list and may never be, so this is what the badge will
 * usually be, and it is built to look deliberate: the hue comes from the
 * address so it never changes, and the ink is chosen per hue because yellow
 * at this lightness is far brighter than blue at the same lightness and no
 * single ink stays legible across the wheel.
 *
 * The colour is always painted underneath the image too, and a logo that
 * fails to load — a dead link on a third-party CDN — falls back to the
 * monogram rather than the browser's broken-image icon.
 */
export function TokenBadge({
  token,
  className = 'logo',
}: {
  token: TokenMeta;
  className?: string;
}) {
  // `logoColor` is what the provider supplies — the simulator's seed palette,
  // or a colour the indexer derived. The address-derived mark is the default
  // when there is none, so a badge is never unstyled.
  const mark = tokenMark(token.address);
  const background = token.logoColor || mark.bg;
  // Which URL failed, not just "failed": a corrected logo arriving in a later
  // snapshot gets its chance instead of staying on the monogram.
  const [failed, setFailed] = useState<string | null>(null);
  const logo = token.logoUrl && token.logoUrl !== failed ? token.logoUrl : null;

  return (
    <span
      className={className}
      style={{ background, color: mark.ink }}
      aria-hidden="true"
    >
      {logo ? (
        /* next/image would proxy these through our own server and needs every
           remote host whitelisted in `images.remotePatterns` up front. The
           host comes from a third-party token list, so it is not knowable in
           advance — and there is nothing to optimise about a 22px badge. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(logo)}
        />
      ) : (
        monogram(token.symbol)
      )}
    </span>
  );
}
