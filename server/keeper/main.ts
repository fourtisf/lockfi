/**
 * The keeper process (§8 P3, P4).
 *
 *   npm run keeper
 *
 * Pokes and routes every router the factory created, and records each
 * attempt that did not simply succeed in keeper_runs. Vaults need no keeper:
 * they credit fees whenever anyone deposits, withdraws, claims or pokes.
 *
 * It also runs the vault watcher (vault-watch.ts), on its own loop: each
 * vault's pool read live from the chain every minute, so the vault figures
 * on the site are today's while the pool indexer is still crossing history.
 * It only reads — no key, no transaction.
 *
 * It never exits on its own. With no router factory deployed, or no key, it
 * says why once and stays up idle: an exit would be restarted by PM2 into a
 * crash loop that fixes nothing and buries the reason (§17). /api/health is
 * what says a router is not being kept — from the router's own last Observed
 * event, which no amount of this process being "online" can fake.
 */

// First, so `.env` is in process.env before anything reads it (load-env.ts).
import '../load-env';

import { CHAIN } from '../../lib/chain';
import { deploymentFor } from '../../lib/contracts/deployments';
import { prisma } from '../db';
import { contractsConfig } from '../indexer/contracts-config';
import { routersFromFactory } from '../indexer/contracts';
import { viemKeeperClient } from './client';
import { LOOP_SECONDS, readSigner } from './config';
import { Keeper } from './keeper';
import { VaultWatcher, viemWatchClient } from './vault-watch';

/** Seconds between vault watcher passes. */
const WATCH_SECONDS = 60;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

let stopping = false;
/** Every loop's current sleep, so a stop signal wakes all of them. */
const sleepers = new Set<() => void>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} — stopping after the current pass`);
    stopping = true;
    for (const wake of [...sleepers]) wake();
  });
}

/** Sleep, cut short by a stop signal. Holds a timer, so the process stays up. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      sleepers.delete(done);
      resolve();
    }
    sleepers.add(done);
  });
}

/** The vault watcher's loop. Never throws: tick() logs and retries. */
async function watchVaults(watcher: VaultWatcher): Promise<void> {
  while (!stopping) {
    await watcher.tick();
    if (!stopping) await sleep(WATCH_SECONDS * 1000);
  }
}

async function main(): Promise<void> {
  // The key first: it leaves process.env here, whatever else happens.
  const signer = readSigner();
  const deployment = deploymentFor(CHAIN.id);
  const config = contractsConfig(deployment);

  const vaults = deployment?.vaults ?? [];
  const watching =
    vaults.length > 0
      ? watchVaults(new VaultWatcher({ client: viemWatchClient(), vaults, log }))
      : Promise.resolve(log('no vault deployed (config/deployments.json): nothing to watch'));

  if (!config.routerFactory) {
    log(
      'routers: none to keep — no router factory is deployed (config/deployments.json). ' +
        'Vaults need no keeper.',
    );
    await watching;
    while (!stopping) await sleep(3_600_000);
    return;
  }

  if (signer.account) log(`signing as ${signer.account.address}`);
  else log(`NOT SIGNING: ${signer.problem}`);
  // The address new routers are told is Tidewell's keeper. A different key
  // here is refused by every router that names that address, per router.
  const recorded = deployment?.keeper?.toLowerCase();
  if (signer.account && recorded && recorded !== signer.account.address.toLowerCase()) {
    log(
      `WARNING: config/deployments.json records the keeper as ${recorded}, but this key is ` +
        `${signer.account.address.toLowerCase()} — routers that name the recorded keeper will be refused`,
    );
  }
  log(`following routers from the factory ${config.routerFactory.address}`);

  const client = viemKeeperClient(signer.account);
  if (signer.account) {
    try {
      const balance = await client.getBalance({ address: signer.account.address });
      log(`keeper wallet holds ${(Number(balance) / 1e18).toFixed(6)} ETH for gas`);
    } catch {
      /* reported by the first pass if the chain is unreachable */
    }
  }

  const factory = config.routerFactory.address;
  const keeper = new Keeper({
    client,
    account: signer.account,
    signerProblem: signer.problem,
    routers: () => routersFromFactory(factory),
    log,
  });

  // The first pass runs immediately: a router left unobserved while this
  // process was down is poked now, decided by its own on-chain observation.
  const keeping = (async () => {
    while (!stopping) {
      await keeper.tick();
      if (!stopping) await sleep(LOOP_SECONDS * 1000);
    }
  })();
  await Promise.all([keeping, watching]);
}

let exitCode = 0;
main()
  .catch((error) => {
    // Unreachable in practice — tick() never throws. If it happens, say it
    // and exit non-zero: PM2's restart budget (ecosystem.config.js) turns a
    // fast failure loop into a visible `errored`, not an endless spin.
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    log('stopped');
    process.exit(exitCode);
  });
