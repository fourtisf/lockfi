'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { createWagmiConfig } from '@/lib/wallet/config';

/**
 * Wallet and chain-read context for the whole tree.
 *
 * The config and the query cache are made once per browser tab, inside the
 * component, never at module scope: on the server a module is shared by
 * every request, and a cache there would hand one visitor's reads to the
 * next. Per-wallet data is only ever read here, in the browser — the snapshot
 * the web server caches is the same for everyone and must stay that way.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [config] = useState(createWagmiConfig);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 2 },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
