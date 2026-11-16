'use client';

import { useQuery } from '@tanstack/react-query';
import { DATA_SOURCE } from '@/lib/data';
import type { TokenLive } from '@/lib/token-curve';

const API_BASE = (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';
const LIVE = DATA_SOURCE === 'live';

/**
 * The token on its launchpad curve, from /api/token (server/api/token-curve.ts),
 * every 15 seconds. Null in the simulator, before the first answer, and when
 * the API cannot read the curve.
 */
export function useTokenLive(): { token: TokenLive | null; failed: boolean } {
  const { data, isError } = useQuery({
    queryKey: ['token-live'],
    enabled: LIVE,
    refetchInterval: 15_000,
    queryFn: async (): Promise<TokenLive> => {
      const r = await fetch(`${API_BASE}/api/token`);
      if (!r.ok) throw new Error(`token ${r.status}`);
      return (await r.json()) as TokenLive;
    },
  });
  return { token: data ?? null, failed: isError };
}
