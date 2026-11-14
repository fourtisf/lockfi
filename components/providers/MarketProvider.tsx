'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { getProvider } from '@/lib/data';
import { AwaitingIndexer } from './AwaitingIndexer';
import type { MarketSnapshot, Pool, Vault } from '@/lib/data/types';

const MarketContext = createContext<MarketSnapshot | null>(null);

/**
 * The bridge between the DataProvider and the tree.
 *
 * `getSnapshot()` has always been allowed to return null — "null if none has
 * arrived yet (live, pre-connect)", in the interface P0 shipped. SimProvider
 * is synchronous so it never did; the live provider is a fetch and a socket,
 * so it does, on every first paint and whenever the indexer has not written a
 * block yet.
 *
 * That case gets its own state rather than zeros. A page of zeroed cards is
 * indistinguishable from a chain where nothing is happening, and §7 does not
 * allow the site to be ambiguous about whether a number is real.
 */
export function MarketProvider({
  children,
  initial = null,
}: {
  children: ReactNode;
  /**
   * The live snapshot the web server fetched while rendering (see
   * lib/data/initial-snapshot.ts), so the first paint has the real site
   * rather than a waiting card. Null for the simulator, which has its own.
   */
  initial?: MarketSnapshot | null;
}) {
  const provider = getProvider();

  const subscribe = useCallback(
    (onChange: () => void) => provider.subscribe(() => onChange()),
    [provider],
  );
  // The provider's own snapshot once it has one; until then, what the server
  // rendered with. The provider is never seeded on the server: it is a module
  // singleton there, shared by every request, and would serve one visitor's
  // snapshot to the next.
  const read = useCallback(() => provider.getSnapshot() ?? initial, [provider, initial]);

  // Server and client read the same first snapshot — the simulator's
  // deterministic one, or the server-fetched live one — so hydration matches
  // and the tick is the only thing that ever changes the numbers.
  const snapshot = useSyncExternalStore(subscribe, read, read);

  if (!snapshot) return <AwaitingIndexer />;

  return <MarketContext.Provider value={snapshot}>{children}</MarketContext.Provider>;
}

export function useMarket(): MarketSnapshot {
  const snapshot = useContext(MarketContext);
  if (!snapshot) {
    throw new Error('useMarket must be used inside <MarketProvider>');
  }
  return snapshot;
}

export function usePools(): Pool[] {
  return useMarket().pools;
}

export function usePool(poolId: string | null): Pool | undefined {
  const pools = usePools();
  return useMemo(() => pools.find((p) => p.id === poolId), [pools, poolId]);
}

export function useVaults(): Vault[] {
  return useMarket().vaults;
}
