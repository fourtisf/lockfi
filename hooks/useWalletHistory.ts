'use client';

import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@/hooks/useWallet';
import { DATA_SOURCE } from '@/lib/data';
import type { WalletVaultHistory } from '@/lib/wallet/portfolio';

const API_BASE = (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';
const LIVE = DATA_SOURCE === 'live';

export interface WalletEvent {
  vault: string;
  poolId: string;
  kind: 'Deposited' | 'Withdrawn' | 'Claimed';
  at: string;
  txHash: string;
  amount0: string;
  amount1: string;
}

export interface WalletHistory {
  wallet: string;
  vaults: WalletVaultHistory[];
  events: WalletEvent[];
  asOf: string | null;
}

/**
 * The connected wallet's deposits, withdrawals and claims in Tidewell's
 * vaults, from /api/wallet/:address — the vaults' own events, which the
 * indexer reads to the chain head. Refreshed every 30 seconds; null with no
 * wallet, before the first answer, or when the API cannot be reached.
 */
export function useWalletHistory(): { history: WalletHistory | null; failed: boolean } {
  const { address } = useWallet();
  const { data, isError } = useQuery({
    queryKey: ['wallet-history', address?.toLowerCase()],
    enabled: LIVE && address !== undefined,
    refetchInterval: 30_000,
    queryFn: async (): Promise<WalletHistory> => {
      const response = await fetch(`${API_BASE}/api/wallet/${address}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as WalletHistory;
    },
  });
  return { history: data ?? null, failed: isError };
}
