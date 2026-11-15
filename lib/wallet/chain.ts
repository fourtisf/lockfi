/**
 * Robinhood Chain as viem and the wallets see it.
 *
 * The facts come from lib/chain.ts; this only shapes them for viem's
 * `defineChain`, which is also what a wallet is handed when it does not know
 * the chain yet (wallet_addEthereumChain), so the RPC and explorer a user's
 * wallet adds are ours and nobody else's.
 */
import { defineChain } from 'viem';
import { CHAIN, CONTRACTS, EXPLORER, PUBLIC_RPC } from '../chain';

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
  contracts: { multicall3: { address: CONTRACTS.multicall3 } },
});
