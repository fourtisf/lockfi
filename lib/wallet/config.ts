/**
 * The wagmi configuration: one chain, injected wallets only.
 *
 * Browser-extension wallets announce themselves over EIP-6963 (MetaMask,
 * Rabby, Coinbase Wallet, Brave, Phantom…), which wagmi listens for by
 * default; `injected()` is the fallback for one that only sets
 * `window.ethereum`. No WalletConnect, no hosted SDK: nothing here talks to a
 * third party, and nothing is imported from `wagmi/connectors`, whose other
 * connectors would pull their SDKs into the bundle.
 *
 * `ssr: true` keeps the server render and the first client render identical
 * (disconnected); the stored connection is restored after hydration.
 */
import { createConfig, http, injected } from 'wagmi';
import { PUBLIC_RPC } from '../chain';
import { robinhoodChain } from './chain';

export function createWagmiConfig() {
  return createConfig({
    chains: [robinhoodChain],
    connectors: [injected({ shimDisconnect: true })],
    transports: { [robinhoodChain.id]: http(PUBLIC_RPC, { batch: true }) },
    ssr: true,
  });
}

export type WagmiConfig = ReturnType<typeof createWagmiConfig>;

declare module 'wagmi' {
  interface Register {
    config: WagmiConfig;
  }
}
