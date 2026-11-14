'use client';

import { useEffect, useState } from 'react';
import { DATA_SOURCE } from '@/lib/data';

/**
 * What the site shows when there is no snapshot.
 *
 * The honest state — §7 forbids placeholder numbers — but "waiting for the
 * indexer" on its own is a blank wall: true, and no use to whoever opens the
 * site to find out what is wrong. It had exactly that problem in production,
 * where the real answer was a missing USDG_ADDRESS and nothing on the page
 * said so.
 *
 * So it asks `/api/health`, which knows, and shows the reason. Three states
 * it can report, each meaning something different:
 *
 *   misconfigured   the indexer cannot start — the message says what to set
 *   never-indexed   configured, running, has not written its first block yet
 *   no-anchor       indexing, but no WETH/USDG pool yet, so no dollar figure
 *   anything else   data exists and is on its way: a loading state, not an alarm
 *   (no answer)     the API itself is down
 *
 * In live mode the server now renders with the snapshot already in hand
 * (lib/data/initial-snapshot.ts), so this card only appears when the API was
 * slow or down at that moment, or genuinely has nothing to show.
 */

interface Health {
  status?: string;
  message?: string;
  indexed?: { lastBlock?: string } | null;
  pools?: number;
}

const API_BASE =
  (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';

/** Long enough not to hammer a struggling API, short enough to notice a fix. */
const RETRY_MS = 15_000;

export function AwaitingIndexer() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    if (DATA_SOURCE !== 'live') return;
    let cancelled = false;

    const check = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
        // 503 is the expected answer here, and it carries the reason — so the
        // body is read whether or not the status is ok.
        const body = (await response.json()) as Health;
        if (cancelled) return;
        setHealth(body);
        setUnreachable(false);
      } catch {
        if (cancelled) return;
        setUnreachable(true);
      }
    };

    void check();
    const timer = setInterval(check, RETRY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Only "never-indexed" means there is nothing yet. Everything else that
  // lands here is a snapshot on its way — and this card used to say "No
  // indexed blocks yet" for all of it, including while 143 indexed pools
  // loaded, on every visit.
  const loading =
    DATA_SOURCE === 'live' &&
    !unreachable &&
    (health === null || ['ok', 'catching-up', 'stalled'].includes(health.status ?? ''));

  const eyebrow =
    DATA_SOURCE !== 'live'
      ? 'Loading'
      : unreachable
        ? 'The API is not answering'
        : health?.status === 'misconfigured'
          ? 'The indexer is misconfigured'
          : // Indexing, but no WETH/USDG pool found yet, so nothing has a
            // dollar figure. Transient and self-healing: it resolves itself
            // the moment that pool is indexed.
            health?.status === 'no-anchor'
            ? 'Looking for the USD anchor'
            : loading
              ? 'Loading live data'
              : 'Waiting for the indexer';

  return (
    <div className="awaiting" role="status">
      <div className="aw-in">
        <span className="eyebrow">{eyebrow}</span>
        <p>
          {loading
            ? 'Fetching the latest figures from the indexer.'
            : health?.status === 'no-anchor'
              ? 'Blocks are being indexed, but no WETH/USDG pool has turned up yet, ' +
                'so nothing has a dollar figure. This resolves itself as soon as one ' +
                'is indexed — no placeholder numbers in the meantime.'
              : 'No indexed blocks yet, so there is nothing honest to show. The boards ' +
                'appear as soon as the first swap is attributed — no placeholder ' +
                'numbers in the meantime.'}
        </p>
        {health?.message ? <p className="aw-why">{health.message}</p> : null}
        {unreachable ? (
          <p className="aw-why">
            The front end is up but the API behind it is not responding. On the
            server, <code>bash deploy/doctor.sh</code> says which process is
            down and why.
          </p>
        ) : null}
      </div>
    </div>
  );
}
