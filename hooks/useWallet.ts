'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from 'wagmi';
import { CHAIN } from '@/lib/chain';

export type WalletStatus = 'disconnected' | 'connecting' | 'wrong-chain' | 'ready';

/**
 * The connected wallet, reduced to the four states the UI distinguishes.
 *
 * `address` is only ever the address the wallet itself reported for this
 * connection; nothing here invents or remembers one.
 */
export function useWallet() {
  const account = useAccount();
  const { connectors, connect, isPending: connecting, error: connectError, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  // `window.ethereum` exists only in the browser; read it after mount so the
  // server render and the first client render agree.
  const [hasInjected, setHasInjected] = useState(false);
  useEffect(() => {
    setHasInjected(typeof window !== 'undefined' && 'ethereum' in window && Boolean((window as { ethereum?: unknown }).ethereum));
  }, []);

  // EIP-6963 wallets announce themselves with a name and an icon; the bare
  // `injected` connector is the fallback for one that only sets
  // window.ethereum, and would duplicate an announced wallet if listed too.
  const choices = useMemo<Connector[]>(() => {
    const announced = connectors.filter((c) => c.type === 'injected' && c.id !== 'injected');
    if (announced.length > 0) return announced;
    return hasInjected ? connectors.filter((c) => c.id === 'injected') : [];
  }, [connectors, hasInjected]);

  let status: WalletStatus;
  if (account.status === 'connected' && account.address) {
    status = account.chainId === CHAIN.id ? 'ready' : 'wrong-chain';
  } else if (account.status === 'connecting' || account.status === 'reconnecting' || connecting) {
    status = 'connecting';
  } else {
    status = 'disconnected';
  }

  return {
    status,
    address: account.status === 'connected' ? account.address : undefined,
    walletChainId: account.chainId,
    connectorName: account.connector?.name,
    choices,
    // No chainId here: connecting must not hinge on also agreeing to switch
    // networks. A wallet on another chain connects, and the UI then offers
    // the switch as its own step.
    connect: (connector: Connector) => connect({ connector }),
    connecting,
    connectError,
    resetConnect: reset,
    disconnect: () => disconnect(),
    /** Asks the wallet to switch; wagmi adds Robinhood Chain first if the wallet lacks it. */
    switchToChain: () => switchChain({ chainId: CHAIN.id }),
    switching,
    switchError,
  };
}
