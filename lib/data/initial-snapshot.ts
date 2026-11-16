import { DATA_SOURCE } from './index';
import type { MarketSnapshot } from './types';

/**
 * The live snapshot, fetched by the web server while it renders the page.
 *
 * Without it, live mode rendered every first visit with no data — the server
 * has no socket and no fetch loop — so the page opened on "Waiting for the
 * indexer" and swapped to the real site a moment later, on every load. The
 * API is on the same machine, so asking it here costs a few milliseconds and
 * the page arrives already filled.
 *
 * Server-side only: it is imported by the root layout, a server component,
 * and reads the API's internal address, which no browser could reach.
 *
 * Bounded, and never fatal: if the API is slow or down the page renders
 * exactly as before, and the browser fetches the snapshot itself. A slow API
 * must cost a visitor a loading state, not a blank page that hangs.
 */
const TIMEOUT_MS = 3_000;
/** How old a remembered snapshot may be and still be served when the API is not answering. */
const LAST_GOOD_MAX_AGE_MS = 10 * 60_000;

/**
 * The last snapshot the API gave us, for when it does not answer in time — a
 * restart during a deploy, a slow moment. Served in place of the loading
 * card; the lag figure inside it still says how old the numbers are.
 *
 * Shared across requests on purpose, and safe because the live snapshot is
 * public and identical for every visitor: there is no wallet, so no portfolio
 * in it. When P2 adds wallets the portfolio becomes per-visitor and must be
 * stripped before anything is remembered here.
 */
let lastGood: { snapshot: MarketSnapshot; at: number } | null = null;

function remembered(): MarketSnapshot | null {
  return lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS ? lastGood.snapshot : null;
}

export function internalApiUrl(): string {
  return process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`;
}

export async function initialSnapshot(): Promise<MarketSnapshot | null> {
  if (DATA_SOURCE !== 'live') return null;
  try {
    const response = await fetch(`${internalApiUrl()}/api/snapshot`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 503 is the API saying there is nothing honest to show yet; the browser
    // then shows why, exactly as it did before.
    if (response.status === 503) return null;
    if (!response.ok) return remembered();
    const snapshot = (await response.json()) as MarketSnapshot;
    lastGood = { snapshot, at: Date.now() };
    return snapshot;
  } catch {
    // Slow or down: the last good snapshot rather than a loading card.
    return remembered();
  }
}
