/**
 * What the keeper needs from a chain: a structural subset of viem's public
 * and wallet clients, so the keeper's decisions run against a mocked client
 * in tests and against viem in production with no difference in the code
 * between them.
 */

import { createPublicClient, createWalletClient, fallback, http, type Abi, type Account, type Address, type Hash } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { robinhoodChain } from '../chain/client';
import { RPC_URLS } from '../chain/endpoints';

export interface ReadArgs {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Every read in one decision is pinned to one block, so they agree. */
  blockNumber?: bigint;
}

export interface WriteArgs {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  account: Account | Address;
}

export interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}

export interface KeeperClient {
  getBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  readContract(args: ReadArgs): Promise<unknown>;
  /** eth_call of the exact transaction: a revert here costs no gas. */
  simulateContract(args: WriteArgs): Promise<{ request: unknown }>;
  writeContract(request: unknown): Promise<Hash>;
  waitForTransactionReceipt(args: { hash: Hash; timeout: number }): Promise<ReceiptLike>;
  getTransactionCount(args: { address: Address; blockTag: 'pending' | 'latest' }): Promise<number>;
  getBalance(args: { address: Address }): Promise<bigint>;
}

/**
 * viem over every configured endpoint, in order (§4's failover, as viem's
 * own fallback transport, which a wallet client can sign through). Calls made
 * together go as one JSON-RPC batch.
 */
export function viemKeeperClient(account: PrivateKeyAccount | null): KeeperClient {
  const transport = fallback(
    RPC_URLS.map((url) => http(url, { timeout: 20_000, retryCount: 1, retryDelay: 250, batch: { batchSize: 50, wait: 0 } })),
  );
  const pub = createPublicClient({ chain: robinhoodChain, transport });
  const wallet = account ? createWalletClient({ account, chain: robinhoodChain, transport }) : null;
  return {
    getBlock: async () => {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return { number: block.number, timestamp: block.timestamp };
    },
    readContract: (args) => pub.readContract(args as never),
    simulateContract: (args) => pub.simulateContract(args as never) as Promise<{ request: unknown }>,
    writeContract: (request) => {
      if (!wallet) throw new Error('no signing account');
      return wallet.writeContract(request as never);
    },
    waitForTransactionReceipt: (args) => pub.waitForTransactionReceipt(args) as Promise<ReceiptLike>,
    getTransactionCount: (args) => pub.getTransactionCount(args),
    getBalance: (args) => pub.getBalance(args),
  };
}
