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

function apiUrl(): string {
  return process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`;
}

export async function initialSnapshot(): Promise<MarketSnapshot | null> {
  if (DATA_SOURCE !== 'live') return null;
  try {
    const response = await fetch(`${apiUrl()}/api/snapshot`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 503 is the API saying there is nothing honest to show yet; the browser
    // then shows why, exactly as it did before.
    if (!response.ok) return null;
    return (await response.json()) as MarketSnapshot;
  } catch {
    return null;
  }
}
