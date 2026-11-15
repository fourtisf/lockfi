/**
 * config/deployments.json to what the indexer reads (contracts.ts).
 *
 * Shared by the indexer and the keeper so the two follow the same contracts.
 * A malformed entry is dropped and said, never guessed at: an address typo
 * would read nothing and look exactly like a vault nobody uses.
 */

import type { Deployment } from '../../lib/contracts/deployments';
import type { ContractsConfig } from './contracts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID = /^v4:0x[0-9a-fA-F]{64}$/;

export function contractsConfig(
  deployment: Deployment | null,
  log: (message: string) => void = () => {},
): ContractsConfig {
  if (!deployment) {
    log('no deployment for this chain in config/deployments.json — no Tidewell contracts to read');
    return { vaults: [], routerFactory: null };
  }
  const vaults = deployment.vaults.filter((v) => {
    const ok = ADDRESS.test(v.address) && POOL_ID.test(v.poolId) && Number.isInteger(v.deployedBlock) && v.deployedBlock >= 0;
    if (!ok) log(`config/deployments.json: vault entry ${JSON.stringify(v)} is malformed — not followed`);
    return ok;
  });

  let routerFactory: ContractsConfig['routerFactory'] = null;
  const factory = deployment.routerFactory;
  if (factory && !ADDRESS.test(factory)) {
    log(`config/deployments.json: routerFactory ${JSON.stringify(factory)} is not an address — routers not followed`);
  } else if (factory) {
    // Where the factory's RouterCreated scan starts: routerFactoryDeployedBlock
    // (scripts/apply-deployment.mjs writes it from the deploy's own record).
    // Failing that, the earliest vault's block — the same script deploys the
    // vaults after the factory, in the same broadcast — so a hand-edited entry
    // missing the field is still read rather than ignored.
    const explicit = deployment.routerFactoryDeployedBlock;
    const fromVaults = vaults.length > 0 ? Math.min(...vaults.map((v) => v.deployedBlock)) : null;
    const fromBlock = typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0 ? explicit : fromVaults;
    if (fromBlock === null) {
      log(
        'config/deployments.json names a routerFactory but no block to start reading it from ' +
          '(routerFactoryDeployedBlock, or a vault deployedBlock) — routers are not followed until one is set',
      );
    } else {
      routerFactory = { address: factory.toLowerCase(), fromBlock: BigInt(fromBlock) };
    }
  }

  if (vaults.length === 0 && !routerFactory) {
    log('no vaults or router factory deployed (config/deployments.json) — nothing of ours to read yet');
  } else {
    log(
      `following ${vaults.length} vault(s)` +
        (routerFactory ? ` and the router factory ${routerFactory.address} from block ${routerFactory.fromBlock}` : ''),
    );
  }
  return { vaults, routerFactory };
}
