'use client';

import { useMemo } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useEthBalance, useWalletVaults } from '@/hooks/useVaults';
import { useWallet } from '@/hooks/useWallet';
import { DATA_SOURCE } from '@/lib/data';
import type { Portfolio } from '@/lib/data/types';
import { walletPortfolio, walletStakes, type WalletStake } from '@/lib/wallet/portfolio';

/**
 * Where a portfolio's figures came from:
 *   sim       — the simulator's generated wallet;
 *   snapshot  — the live site with no wallet connected: the API's honest
 *               empty portfolio, the same for every visitor;
 *   wallet    — the connected wallet, read from the chain in this browser.
 */
export type PortfolioSource = 'sim' | 'snapshot' | 'wallet';

export interface PortfolioView {
  source: PortfolioSource;
  portfolio: Portfolio;
  /** The wallet's stakes with their raw chain figures; empty unless `wallet`. */
  stakes: WalletStake[];
  /** Spendable ETH in wei; null unless a live wallet is connected and read. */
  balanceWei: bigint | null;
  loading: boolean;
}

const LIVE = DATA_SOURCE === 'live';

export function usePortfolio(): PortfolioView {
  const market = useMarket();
  const { address } = useWallet();
  const { vaults, loading } = useWalletVaults();
  const balanceWei = useEthBalance();

  return useMemo(() => {
    if (!LIVE) return { source: 'sim', portfolio: market.portfolio, stakes: [], balanceWei: null, loading: false };
    if (!address) return { source: 'snapshot', portfolio: market.portfolio, stakes: [], balanceWei: null, loading: false };
    const eth = market.global.ethPriceUsd;
    const stakes = walletStakes(vaults, market.pools, eth);
    return {
      source: 'wallet',
      portfolio: walletPortfolio(market.portfolio, stakes, balanceWei, eth),
      stakes,
      balanceWei,
      loading,
    };
  }, [market.portfolio, market.pools, market.global.ethPriceUsd, address, vaults, balanceWei, loading]);
}
