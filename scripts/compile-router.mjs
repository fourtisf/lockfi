/**
 * Compiles contracts/ with the solc in node_modules and writes the ABIs to
 * lib/router/abi.json and the factory's creation bytecode to
 * lib/router/factory-bytecode.json, which the pages and the keeper read.
 *
 *   npm run router:compile
 *
 * Settings are fixed here so a rebuild is byte-identical: solc 0.8.26, via-IR,
 * optimizer 200 runs, EVM cancun (Robinhood Chain runs Uniswap v4, which needs
 * cancun's transient storage, so the chain has it).
 */
import solc from 'solc';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'contracts');
const sources = {};
for (const f of ['LockFiRouter.sol', 'LockFiRouterFactory.sol']) sources[f] = { content: readFileSync(join(SRC, f), 'utf8') };
for (const f of readdirSync(join(SRC, 'vendor'))) sources[`vendor/${f}`] = { content: readFileSync(join(SRC, 'vendor', f), 'utf8') };

const input = {
  language: 'Solidity',
  sources,
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
for (const e of out.errors ?? []) if (e.severity !== 'error' || errors.length) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const pick = (file, name) => out.contracts[file][name];
const factory = pick('LockFiRouterFactory.sol', 'LockFiRouterFactory');
const router = pick('LockFiRouter.sol', 'LockFiRouter');
const deployer = pick('LockFiRouter.sol', 'LockFiRouterDeployer');
const size = (c) => c.evm.deployedBytecode.object.length / 2;
console.log(`  compiler ${solc.version()}`);
console.log(`  LockFiRouterFactory runtime ${size(factory)} bytes, creation ${factory.evm.bytecode.object.length / 2}`);
console.log(`  LockFiRouter        runtime ${size(router)} bytes`);
console.log(`  LockFiRouterDeployer runtime ${size(deployer)} bytes`);
if ([factory, router, deployer].some((c) => size(c) > 24576)) throw new Error('over the 24,576-byte contract size limit');
// EIP-3860: a creation transaction's code is capped at twice the runtime limit
if (factory.evm.bytecode.object.length / 2 > 49152) throw new Error('factory creation code over the 49,152-byte initcode limit');
// The ABIs go in every bundle that calls a router; the factory's creation
// bytecode (22 KB) only in the page that deploys it, so it is its own file.
writeFileSync(
  join(ROOT, 'lib', 'router', 'abi.json'),
  JSON.stringify({ compiler: solc.version(), factory: factory.abi, router: router.abi }, null, 1) + '\n',
);
writeFileSync(
  join(ROOT, 'lib', 'router', 'factory-bytecode.json'),
  JSON.stringify({ compiler: solc.version(), bytecode: `0x${factory.evm.bytecode.object}` }) + '\n',
);
console.log('  lib/router/abi.json, lib/router/factory-bytecode.json');
