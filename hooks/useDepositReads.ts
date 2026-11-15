'use client';

import { erc20Abi, zeroAddress } from 'viem';
import { useReadContracts } from 'wagmi';
import { useWallet } from '@/hooks/useWallet';
import { CHAIN } from '@/lib/chain';
import { DATA_SOURCE } from '@/lib/data';
import type { PoolKey } from '@/lib/data/types';

type Address = `0x${string}`;

const LIVE = DATA_SOURCE === 'live';
const REFRESH_MS = 15_000;

export interface TokenReads {
  symbol: string | null;
  decimals: number | null;
  /** The connected wallet's balance; null with no wallet or before it is read. */
  balance: bigint | null;
}

/**
 * What a deposit form needs to know about a vault pool's ERC-20 sides, read
 * from the chain in this browser: each token's symbol and decimals, and the
 * connected wallet's balance of it. Native ETH has none of these to read
 * (its balance is useEthBalance's). Approvals are read fresh at the moment
 * of signing (useActions), not here.
 */
export function useDepositReads(key: PoolKey | undefined): [TokenReads | null, TokenReads | null] {
  const { address } = useWallet();
  const currencies = key ? [key.currency0, key.currency1] : [];
  const erc20 = currencies.map((c) => (c.toLowerCase() === zeroAddress ? null : (c as Address)));
  const contracts = erc20.flatMap((token) =>
    token === null
      ? []
      : [
          { address: token, abi: erc20Abi, functionName: 'symbol' as const, chainId: CHAIN.id },
          { address: token, abi: erc20Abi, functionName: 'decimals' as const, chainId: CHAIN.id },
          { address: token, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address ?? zeroAddress] as const, chainId: CHAIN.id },
        ],
  );
  const { data } = useReadContracts({
    allowFailure: true,
    contracts,
    query: { enabled: LIVE && key !== undefined && contracts.length > 0, refetchInterval: REFRESH_MS },
  });

  let k = 0;
  const out = erc20.map((token): TokenReads | null => {
    if (token === null) return null;
    const [sym, dec, bal] = [data?.[k], data?.[k + 1], data?.[k + 2]];
    k += 3;
    return {
      symbol: sym?.status === 'success' ? String(sym.result) : null,
      decimals: dec?.status === 'success' ? Number(dec.result) : null,
      balance: address && bal?.status === 'success' ? (bal.result as bigint) : null,
    };
  });
  return [out[0] ?? null, out[1] ?? null];
}
