import { DATA_SOURCE } from './index';
import { internalApiUrl } from './initial-snapshot';

/** What /api/share/:wallet answers (server/api/share.ts). */
export interface ShareCardData {
  wallet: string;
  asOf: string;
  feesEarnedUsd: number | null;
  claimedUsd: number | null;
  claimableUsd: number | null;
  stakedUsd: number | null;
  vaults: { poolId: string; label: string; stakedUsd: number | null }[];
  since: string | null;
}

export const WALLET = /^0x[0-9a-fA-F]{40}$/;

/**
 * A wallet's share card, from the API on this machine (server-side only).
 * Null in the simulator, for a malformed address, or when the API cannot
 * read the vaults: the page and the image then say so instead of a figure.
 */
export async function fetchShareCard(address: string): Promise<ShareCardData | null> {
  if (DATA_SOURCE !== 'live' || !WALLET.test(address)) return null;
  try {
    const r = await fetch(`${internalApiUrl()}/api/share/${address}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    return r.ok ? ((await r.json()) as ShareCardData) : null;
  } catch {
    return null;
  }
}

export function shortWallet(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function sinceLabel(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
}
