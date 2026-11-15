/**
 * What can be signed, and against what — from config/deployments.json.
 *
 * Pure, and the one place the site decides whether a button sends a
 * transaction. An empty deployment (today) answers "nothing", and every
 * surface keeps saying staking is not open.
 */
import { zeroAddress } from 'viem';
import { CHAIN, CONTRACTS } from '../chain';
import type { PoolKey } from '../data/types';
import { deploymentFor, vaultForPool, type VaultDeployment } from './deployments';
import { v4PoolId } from './tx';

type Address = `0x${string}`;

export interface SigningStatus {
  zap: Address | null;
  shaper: Address | null;
  vaults: VaultDeployment[];
  audited: boolean;
  /**
   * Something a wallet could sign against is deployed but no external audit
   * has signed off (CLAUDE.md §8, P5): every signing button carries a notice.
   */
  unaudited: boolean;
}

export function signingStatus(chainId: number = CHAIN.id): SigningStatus {
  const d = deploymentFor(chainId);
  const vaults = d?.vaults ?? [];
  const zap = d?.zap ?? null;
  const shaper = d?.shaper ?? null;
  const audited = d?.audited ?? false;
  const anything = vaults.length > 0 || zap !== null || shaper !== null || (d?.routerFactory ?? null) !== null;
  return { zap, shaper, vaults, audited, unaudited: anything && !audited };
}

/** The vault and zap a pool is staked through, or null when either is missing. */
export function stakeTarget(poolId: string, chainId: number = CHAIN.id): { vault: VaultDeployment; zap: Address } | null {
  const vault = vaultForPool(chainId, poolId);
  const zap = deploymentFor(chainId)?.zap ?? null;
  return vault && zap ? { vault, zap } : null;
}

const WETH = CONTRACTS.weth.toLowerCase();

function isEth(currency: string): boolean {
  const c = currency.toLowerCase();
  return c === zeroAddress || c === WETH;
}

export type MintAvailability =
  | {
      ok: true;
      shaper: Address;
      key: PoolKey;
      /** bytes32, for StateView.getSlot0. */
      poolId: Address;
      /** Whether the priced token is currency0 (false against native ETH). */
      tokenIsCurrency0: boolean;
    }
  | {
      ok: false;
      /** v3 or simulated pools carry no v4 key; USDG pairs have no ETH side to enter with. */
      reason: 'no-key' | 'no-shaper' | 'no-eth-side';
    };

/** Whether this pool can be minted into with ETH through TidewellShaper. */
export function mintAvailability(
  pool: { id: string; key?: PoolKey },
  chainId: number = CHAIN.id,
): MintAvailability {
  const poolId = v4PoolId(pool.id);
  if (!pool.key || !poolId) return { ok: false, reason: 'no-key' };
  const shaper = deploymentFor(chainId)?.shaper ?? null;
  if (!shaper) return { ok: false, reason: 'no-shaper' };
  const eth0 = isEth(pool.key.currency0);
  const eth1 = isEth(pool.key.currency1);
  if (eth0 === eth1) return { ok: false, reason: 'no-eth-side' };
  return { ok: true, shaper, key: pool.key, poolId, tokenIsCurrency0: eth1 };
}
