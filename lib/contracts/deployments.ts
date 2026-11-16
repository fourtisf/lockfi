/**
 * Where Tidewell's contracts live, per chain (config/deployments.json).
 *
 * Read by the site, the indexer and the keeper. An empty entry is the honest
 * default: nothing is deployed, so nothing can be staked or signed, and every
 * surface says so. Uniswap's own contracts are not here — they are facts
 * about the chain, in lib/chain.ts.
 */
import raw from '../../config/deployments.json';

export interface VaultDeployment {
  /** The vault contract. */
  address: `0x${string}`;
  /** The indexer's pool id, `v4:0x<poolId>`. */
  poolId: string;
  /** Block the vault was deployed in, where its event scan starts. */
  deployedBlock: number;
}

export interface Deployment {
  network: string;
  /** False until an external audit has signed off (CLAUDE.md §8, P5). */
  audited: boolean;
  /** Where the audit report is, when there is one. */
  auditReport?: string | null;
  zap: `0x${string}` | null;
  /** Block the zap was deployed in: where a wallet's ZapMinted events are read from. */
  zapDeployedBlock?: number | null;
  shaper: `0x${string}` | null;
  /** Block the shaper was deployed in: where a wallet's ShapeMinted events are read from. */
  shaperDeployedBlock?: number | null;
  routerFactory: `0x${string}` | null;
  /** Block the router factory was deployed in, where its event scan starts. */
  routerFactoryDeployedBlock?: number | null;
  /**
   * Tidewell's keeper: the address new token-team routers are told may
   * trigger routes (it never receives funds). Optional — until it is
   * recorded here the router page says a keeper address is needed.
   */
  keeper?: `0x${string}` | null;
  vaults: VaultDeployment[];
}

const table = raw as unknown as Record<string, Deployment | string>;

export function deploymentFor(chainId: number): Deployment | null {
  const entry = table[String(chainId)];
  return entry && typeof entry === 'object' ? entry : null;
}

/** The vault deployed for an indexer pool id, if any. */
export function vaultForPool(chainId: number, poolId: string): VaultDeployment | null {
  return deploymentFor(chainId)?.vaults.find((v) => v.poolId.toLowerCase() === poolId.toLowerCase()) ?? null;
}
