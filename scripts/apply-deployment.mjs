#!/usr/bin/env node
// Merges contracts/deployments/<chainId>.json (written by script/Deploy.s.sol)
// into config/deployments.json, which the site, indexer and keeper read.
//
//   node scripts/apply-deployment.mjs 4663
//
// Robinhood Chain mainnet is refused unless the deployment records an audit
// report or the owner's explicit decision to launch unaudited — the same gate
// as the deploy script, so a file copied by hand from a rehearsal cannot put
// vaults in front of users by accident (CLAUDE.md §8 P5, §20).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chainId = process.argv[2];
if (!/^\d+$/.test(chainId ?? '')) {
  console.error('usage: node scripts/apply-deployment.mjs <chainId>');
  process.exit(1);
}
const src = join(root, 'contracts/deployments', `${chainId}.json`);
const dep = JSON.parse(readFileSync(src, 'utf8'));
if (String(dep.chainId) !== chainId) {
  console.error(`${src} is for chain ${dep.chainId}, not ${chainId}`);
  process.exit(1);
}
if (chainId === '4663' && !(dep.audited && dep.auditReport) && dep.unauditedAccepted !== true) {
  console.error('Refused: a mainnet deployment with neither an audit report nor the unaudited acknowledgement is not applied (CLAUDE.md §8 P5, §20).');
  process.exit(1);
}
if (chainId === '4663' && !dep.audited) {
  console.warn('Applying an UNAUDITED mainnet deployment. The site will say so beside every signing button.');
}
const addr = (a) => (a ? String(a).toLowerCase() : null);
const cfgPath = join(root, 'config/deployments.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
cfg[chainId] = {
  network: cfg[chainId]?.network ?? (chainId === '4663' ? 'Robinhood Chain' : `chain ${chainId}`),
  audited: Boolean(dep.audited),
  auditReport: dep.auditReport || null,
  zap: addr(dep.zap),
  shaper: addr(dep.shaper),
  routerFactory: addr(dep.routerFactory),
  // The factory's own creation block when recorded (contracts.sh takes it from
  // the receipt), else the deployment's first block, which is earlier.
  routerFactoryDeployedBlock: dep.routerFactory ? Number(dep.routerFactoryBlock ?? dep.block) : null,
  keeper: addr(dep.keeper) ?? cfg[chainId]?.keeper ?? null,
  vaults: (dep.vaults ?? []).map((v) => ({
    address: addr(v.address),
    poolId: String(v.poolId).toLowerCase(),
    deployedBlock: Number(v.deployedBlock),
  })),
};
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`applied ${src} -> config/deployments.json [${chainId}]: ${cfg[chainId].vaults.length} vault(s)`);
