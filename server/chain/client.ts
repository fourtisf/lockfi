/**
 * The RPC layer, with failover.
 *
 * §4 puts all pool data on-chain, which makes the RPC endpoint the single
 * point of failure for every number on the site. Public endpoints rate-limit,
 * time out and occasionally serve a stale head, so every call goes through
 * `withFailover`: try each endpoint in order, and only surface an error once
 * all of them have refused.
 *
 * There is deliberately no price API here and no third-party indexer. The
 * only thing this module talks to is a node (§4).
 */

import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
  type Transport,
} from 'viem';
import { CHAIN } from '../../lib/chain';
import { RPC_URLS } from './endpoints';

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [...RPC_URLS] } },
});

/** One client per endpoint, so a failover is a different socket, not a retry. */
const clients: PublicClient<Transport, typeof robinhoodChain>[] = RPC_URLS.map((url) =>
  createPublicClient({
    chain: robinhoodChain,
    transport: http(url, {
      timeout: 20_000,
      // viem's own retry handles a blip; withFailover handles an endpoint
      // that is down. Keep the inner retry short so failover happens quickly.
      retryCount: 1,
      retryDelay: 250,
      // Calls made together go as one JSON-RPC batch: block timestamps for a
      // dense range are fetched a hundred at a time (viem-source.ts).
      batch: { batchSize: 100, wait: 0 },
    }),
  }),
);

if (clients.length === 0) throw new Error('No RPC endpoints configured. Set RPC_URLS.');

/** Endpoint currently believed good. Stays put until it fails. */
let preferred = 0;

export interface FailoverResult<T> {
  value: T;
  /** Which endpoint answered. Logged, so a silently-degraded run is visible. */
  endpoint: string;
}

export async function withFailover<T>(
  fn: (client: PublicClient<Transport, typeof robinhoodChain>) => Promise<T>,
  label = 'rpc',
): Promise<FailoverResult<T>> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < clients.length; attempt++) {
    const index = (preferred + attempt) % clients.length;
    try {
      const value = await fn(clients[index]);
      // Stick with whatever worked; rotating on success would spread load but
      // also spread any single endpoint's stale head across our writes.
      preferred = index;
      return { value, endpoint: RPC_URLS[index] };
    } catch (error) {
      errors.push(`${RPC_URLS[index]}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`${label} failed on all ${clients.length} endpoints:\n  ${errors.join('\n  ')}`);
}

/** Convenience for the common case: the value, without the endpoint. */
export async function rpc<T>(
  fn: (client: PublicClient<Transport, typeof robinhoodChain>) => Promise<T>,
  label?: string,
): Promise<T> {
  return (await withFailover(fn, label)).value;
}

/** Current head. Used for the lag figure in the top bar (§7). */
export async function getHead(): Promise<{ number: bigint; timestamp: Date }> {
  const block = await rpc((c) => c.getBlock({ blockTag: 'latest' }), 'getBlock(latest)');
  return { number: block.number, timestamp: new Date(Number(block.timestamp) * 1000) };
}

/**
 * Confirm the endpoints are actually the chain we think they are. Indexing a
 * different chain's logs into this database would be worse than not indexing.
 */
export async function assertChainId(): Promise<void> {
  const id = await rpc((c) => c.getChainId(), 'getChainId');
  if (id !== CHAIN.id) {
    throw new Error(`RPC reports chainId ${id}, expected ${CHAIN.id} (${CHAIN.name}).`);
  }
}
