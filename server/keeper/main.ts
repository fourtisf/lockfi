/**
 * The keeper process (§8 P3, P4).
 *
 *   npm run keeper
 *
 * Pokes and routes every router the factory created, and records each
 * attempt that did not simply succeed in keeper_runs. Vaults need no keeper:
 * they credit fees whenever anyone deposits, withdraws, claims or pokes.
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

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

let stopping = false;
let wake: (() => void) | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} — stopping after the current pass`);
    stopping = true;
    wake?.();
  });
}

/** Sleep, cut short by a stop signal. Holds a timer, so the process stays up. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
  });
}

async function main(): Promise<void> {
  // The key first: it leaves process.env here, whatever else happens.
  const signer = readSigner();
  const deployment = deploymentFor(CHAIN.id);
  const config = contractsConfig(deployment);

  if (!config.routerFactory) {
    log(
      'the keeper is not needed yet: vaults need no keeper, and no router factory is deployed ' +
        '(config/deployments.json). Idling until a deploy restarts it.',
    );
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
  while (!stopping) {
    await keeper.tick();
    if (!stopping) await sleep(LOOP_SECONDS * 1000);
  }
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
