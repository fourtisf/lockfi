#!/usr/bin/env node
// Merges contracts/deployments/<chainId>.json (written by script/Deploy.s.sol)
// into config/deployments.json, which the site, indexer and keeper read.
//
//   node scripts/apply-deployment.mjs 4663
//   node scripts/apply-deployment.mjs 4663 --add-vaults contracts/deployments/4663-added-vaults.json
//
// --add-vaults merges vaults deployed later by deploy/add-vaults.sh
// (script/AddVaults.s.sol) into the existing entry, keeping everything else.
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
const addIndex = process.argv.indexOf('--add-vaults');
const adding = addIndex !== -1;
const src = adding ? process.argv[addIndex + 1] : join(root, 'contracts/deployments', `${chainId}.json`);
if (!src) {
  console.error('usage: node scripts/apply-deployment.mjs <chainId> --add-vaults <file>');
  process.exit(1);
}
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
const vaultEntry = (v) => {
  const entry = { address: addr(v.address), poolId: String(v.poolId).toLowerCase(), deployedBlock: Number(v.deployedBlock) };
  if (!/^0x[0-9a-f]{40}$/.test(entry.address ?? '') || !/^v4:0x[0-9a-f]{64}$/.test(entry.poolId) || !Number.isInteger(entry.deployedBlock) || entry.deployedBlock <= 0) {
    console.error(`malformed vault entry: ${JSON.stringify(v)}`);
    process.exit(1);
  }
  return entry;
};

if (adding) {
  const existing = cfg[chainId];
  if (!existing?.zap) {
    console.error(`config/deployments.json has no deployment for ${chainId} to add vaults to: apply the first deployment first`);
    process.exit(1);
  }
  const added = [];
  for (const v of (dep.vaults ?? []).map(vaultEntry)) {
    const same = existing.vaults.find((x) => x.poolId === v.poolId);
    if (same && same.address === v.address) continue;
    if (same) {
      // One vault per pool on the site: a second vault for a pool is not
      // published over the first, whichever is newer.
      console.error(`${v.poolId} already has vault ${same.address}; ${v.address} is not added`);
      process.exit(1);
    }
    existing.vaults.push(v);
    added.push(v);
  }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`added ${added.length} vault(s) from ${src} -> config/deployments.json [${chainId}]: ${existing.vaults.length} in all`);
  process.exit(0);
}

cfg[chainId] = {
  network: cfg[chainId]?.network ?? (chainId === '4663' ? 'Robinhood Chain' : `chain ${chainId}`),
  audited: Boolean(dep.audited),
  auditReport: dep.auditReport || null,
  zap: addr(dep.zap),
  // Where a wallet's minted positions are read from (lib/positions.ts): the
  // receipts' blocks when contracts.sh recorded them, else the deployment's.
  zapDeployedBlock: dep.zap ? Number(dep.zapBlock ?? dep.block) : null,
  shaper: addr(dep.shaper),
  shaperDeployedBlock: dep.shaper ? Number(dep.shaperBlock ?? dep.block) : null,
  routerFactory: addr(dep.routerFactory),
  // The factory's own creation block when recorded (contracts.sh takes it from
  // the receipt), else the deployment's first block, which is earlier.
  routerFactoryDeployedBlock: dep.routerFactory ? Number(dep.routerFactoryBlock ?? dep.block) : null,
  keeper: addr(dep.keeper) ?? cfg[chainId]?.keeper ?? null,
  vaults: (dep.vaults ?? []).map(vaultEntry),
};
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`applied ${src} -> config/deployments.json [${chainId}]: ${cfg[chainId].vaults.length} vault(s)`);
