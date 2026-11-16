'use client';

import { zeroAddress } from 'viem';
import { useBalance, useReadContracts } from 'wagmi';
import { useWallet } from '@/hooks/useWallet';
import { CHAIN } from '@/lib/chain';
import { signingStatus } from '@/lib/contracts/status';
import {
  WALLET_READS_PER_VAULT,
  parseWalletReads,
  vaultAbi,
  walletReadCalls,
  type WalletVaultReads,
} from '@/lib/contracts/vault';
import { DATA_SOURCE } from '@/lib/data';

type Address = `0x${string}`;

/** Chain reads happen only for the live site. The simulator's pools exist nowhere. */
const LIVE = DATA_SOURCE === 'live';

/** How often a connected wallet's figures are re-read; claimable grows as fees are collected. */
const WALLET_REFRESH_MS = 15_000;

/**
 * What a vault says about itself, before anyone signs: the protocol fee the
 * stake form discloses (§7) — read from the contract, never assumed — and
 * whether it takes deposits.
 */
export function useVaultInfo(vault: Address | undefined) {
  const address = vault ?? zeroAddress;
  const { data, isPending, isError } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address, abi: vaultAbi, functionName: 'protocolFeeBps', chainId: CHAIN.id },
      { address, abi: vaultAbi, functionName: 'depositsOpen', chainId: CHAIN.id },
    ],
    query: { enabled: LIVE && vault !== undefined, staleTime: 60_000, refetchInterval: 60_000 },
  });
  const [fee, open] = data ?? [];
  return {
    protocolFeeBps: fee?.status === 'success' ? Number(fee.result) : null,
    depositsOpen: open?.status === 'success' ? Boolean(open.result) : null,
    loading: vault !== undefined && isPending,
    failed: isError || [fee, open].some((r) => r?.status === 'failure'),
  };
}

/** One deployed vault, as the connected wallet stands in it. */
export type WalletVault = WalletVaultReads;

/**
 * The connected wallet in every deployed vault, read from the chain in this
 * browser. Never from the snapshot: that is cached once for every visitor.
 * Only vaults the wallet holds shares in, or has fees to claim from, come back.
 */
export function useWalletVaults(): { vaults: WalletVault[]; loading: boolean; failed: boolean } {
  const { address } = useWallet();
  const deployed = signingStatus().vaults;
  const enabled = LIVE && address !== undefined && deployed.length > 0;

  const first = useReadContracts({
    allowFailure: true,
    contracts: deployed.flatMap((v) => walletReadCalls(v.address, address ?? zeroAddress)),
    query: { enabled, refetchInterval: WALLET_REFRESH_MS },
  });

  const parsed = deployed.map((deployment, i) =>
    first.data ? parseWalletReads(deployment, first.data.slice(i * WALLET_READS_PER_VAULT, (i + 1) * WALLET_READS_PER_VAULT)) : null,
  );
  const held = parsed.filter(
    (r): r is NonNullable<typeof r> => r !== null && (r.shares > 0n || r.claimable0 > 0n || r.claimable1 > 0n),
  );

  // What the shares are worth depends on how many there are: a second read.
  const holding = held.filter((r) => r.shares > 0n);
  const second = useReadContracts({
    allowFailure: true,
    contracts: holding.map((r) => ({
      address: r.deployment.address,
      abi: vaultAbi,
      functionName: 'amountsForLiquidity' as const,
      args: [r.shares] as const,
      chainId: CHAIN.id,
    })),
    query: { enabled: enabled && holding.length > 0, refetchInterval: WALLET_REFRESH_MS },
  });

  let k = 0;
  const vaults: WalletVault[] = held.map((r) => {
    // No shares: worth nothing, and that is known. Shares: known only once
    // the read of what they are worth has answered for this many shares.
    if (r.shares === 0n) return { ...r, amount0: 0n, amount1: 0n, amountsKnown: true };
    const res = second.data?.[k++];
    if (res?.status === 'success') {
      const [amount0, amount1] = res.result as readonly [bigint, bigint];
      return { ...r, amount0, amount1, amountsKnown: true };
    }
    return { ...r, amount0: 0n, amount1: 0n, amountsKnown: false };
  });

  return {
    vaults,
    loading: enabled && (first.isPending || (holding.length > 0 && second.isPending)),
    failed: first.isError || (first.data !== undefined && parsed.some((r) => r === null)),
  };
}

/** The connected wallet's spendable ETH on Robinhood Chain, in wei; null with no wallet. */
export function useEthBalance(): bigint | null {
  const { address } = useWallet();
  const { data } = useBalance({
    address,
    chainId: CHAIN.id,
    query: { enabled: LIVE && address !== undefined, refetchInterval: WALLET_REFRESH_MS },
  });
  return LIVE && address && data ? data.value : null;
}
