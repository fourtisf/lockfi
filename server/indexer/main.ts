/**
 * The indexer process (§4, §8 P1).
 *
 *   npm run indexer
 *
 * Runs passes until caught up, then keeps polling. Every pass re-scans the
 * last 32 blocks, so a shallow reorg is absorbed without a special case.
 *
 * It does not exit on an RPC failure. An indexer that dies quietly is the
 * failure mode §7 and the P3 criterion both warn about: the site keeps showing
 * the last numbers it had as though they were live. Instead it logs, backs
 * off, and keeps the lag figure honest — the top bar shows how far behind it
 * is, and the number grows until someone looks.
 */

// First, so `.env` is in process.env before anything reads it. See
// server/load-env.ts — Node does not read `.env` files and neither does PM2.
import '../load-env';

import { CHAIN, CONTRACTS } from '../../lib/chain';
import { deploymentFor } from '../../lib/contracts/deployments';
import { assertChainId, getHead } from '../chain/client';
import { findDeploymentBlock } from '../chain/deployment';
import { env } from '../env';
import { prisma } from '../db';
import { publishTick } from '../api/bus';
import { Poller } from './poller';
import { defaultLogoSources } from './logo-sources';
import { ViemLogSource } from './viem-source';
import { contractsConfig } from './contracts-config';

const USDG = process.env.USDG_ADDRESS;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<void> {
  // No USDG_ADDRESS is no longer fatal. The anchor is discovered from the
  // chain's own tokens once pools are indexed (see indexer/anchor.ts) — the
  // indexer refusing to start meant the site sat on a "not configured" page
  // waiting for a step only a person could take.
  if (!USDG) {
    log('USDG_ADDRESS not set — the USD anchor will be discovered from indexed tokens');
  }

  log(`chain check against ${env.rpcUrls.length} endpoint(s)`);
  await assertChainId();
  const head = await getHead();
  log(`head is block ${head.number} at ${head.timestamp.toISOString()}`);

  const v3Factory = process.env.V3_FACTORY ?? null;
  if (!v3Factory) {
    log(
      'V3_FACTORY is not set — v3 pools will only be those named in V3_POOLS. ' +
        '§4 says some older pools on this chain are v3, so this will omit real pools.',
    );
  }

  // Where to start. Left at 0 this scans from genesis — 62 million blocks of
  // mostly nothing on this chain — so if it is unset, find the PoolManager's
  // deployment block by bisection first. About 26 calls against an archive
  // node, against thirty thousand passes of empty range.
  let startBlock = env.startBlock;
  if (startBlock === 0n) {
    log('START_BLOCK is 0 — looking for the PoolManager\'s deployment block');
    const found = await findDeploymentBlock(CONTRACTS.poolManager, head.number);
    log(`  ${found.note}`);
    if (found.block !== null && found.block > 0n) {
      startBlock = found.block;
      log(`  starting at ${startBlock}; set START_BLOCK=${startBlock} to skip this next time`);
    } else {
      log('  starting from 0. This will take a long time — set START_BLOCK to shorten it.');
    }
  }

  // Tidewell's own contracts (P2/P4): the vaults and the router factory in
  // config/deployments.json. Empty there means nothing is deployed, and
  // nothing is read for them.
  const contracts = contractsConfig(deploymentFor(CHAIN.id), log);

  const poller = new Poller({
    source: new ViemLogSource(),
    usdgAddress: USDG,
    startBlock,
    v3Factory,
    v3Pools: (process.env.V3_POOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // Logos from GeckoTerminal, DexScreener and Blockscout for tokens the
    // curated list does not cover. Image URLs only (§4). LOGO_SOURCES=off
    // turns it off.
    logoSources: defaultLogoSources(),
    // Swaps only for the last SWAP_WINDOW_DAYS; older ranges are read for
    // pools and liquidity alone (see poller.ts).
    swapWindowSeconds: env.swapWindowDays > 0 ? env.swapWindowDays * 86_400 : null,
    // Resolving the anchor scans a million pools; it was done on every pass.
    anchorRefreshMs: 10 * 60_000,
    // Vault rows were rebuilt after every pool pass, every few seconds.
    vaultRebuildEveryMs: 60_000,
    contracts,
    log,
  });
  if (env.swapWindowDays > 0) {
    log(`swaps indexed for the last ${env.swapWindowDays} days; older ranges: pools and liquidity only`);
  }

  let backoffMs = 1_000;
  let lastTickAt = 0;
  /** Passes failed in a row, and the last distinct reason logged in full. */
  let failures = 0;
  let lastReason = '';
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal} — finishing the current pass then stopping`);
      shuttingDown = true;
    });
  }

  while (!shuttingDown) {
    try {
      const passStarted = Date.now();
      const result = await poller.runPass();
      const passSeconds = ((Date.now() - passStarted) / 1000).toFixed(1);
      backoffMs = 1_000;
      if (failures > 0) log(`passing again after ${failures} failed pass(es)`);
      failures = 0;
      lastReason = '';
      // Every pass while backfilling, not only the ones that found something:
      // on a 62-million-block chain most ranges are empty, and silence for an
      // hour is indistinguishable from a hang.
      const behind = Number(result.headBlock - result.toBlock);
      // A refused pass logged its own line; a progress line for it would read
      // as progress on a block that did not move.
      if (!result.refused && (result.events > 0 || result.poolsFound > 0 || !result.caughtUp)) {
        const pct = ((Number(result.toBlock) / Number(result.headBlock)) * 100).toFixed(2);
        log(
          `blocks ${result.fromBlock}-${result.toBlock} of ${result.headBlock} (${pct}%, ` +
            `${behind.toLocaleString()} behind, window ${result.blockRange.toLocaleString()}): ` +
            `${result.events} events, +${result.swapsWritten} swaps, ` +
            `+${result.liquidityWritten} liquidity, +${result.poolsFound} pools, ` +
            `+${result.tokensFound} tokens, in ${passSeconds}s` +
            (result.timings
              ? ` [logs ${(result.timings.logs / 1000).toFixed(1)}s, times ${(result.timings.times / 1000).toFixed(1)}s, ` +
                `write ${(result.timings.write / 1000).toFixed(1)}s, aggregate ${(result.timings.aggregate / 1000).toFixed(1)}s, ` +
                `contracts ${((result.timings.contracts ?? 0) / 1000).toFixed(1)}s, ` +
                // Whatever the named phases do not cover. If this is the big
                // number, the slow part is somewhere nobody has timed yet.
                `other ${Math.max(0, (Date.now() - passStarted - result.timings.logs - result.timings.times - result.timings.write - result.timings.aggregate - (result.timings.contracts ?? 0)) / 1000).toFixed(1)}s]`
              : '') +
            (result.structureOnly ? ' (older than the swap window: pools and liquidity only)' : ''),
        );
        // Tell the API something changed; it debounces before pushing (§4.4).
        // A structure pass changes nothing the snapshot shows except the lag,
        // and a snapshot rebuild per pass — every two seconds while crossing
        // history — only competed with the indexer for the database.
        if (!result.structureOnly || Date.now() - lastTickAt >= 30_000) {
          lastTickAt = Date.now();
          await publishTick({ toBlock: result.toBlock.toString(), lagSeconds: result.lagSeconds });
        }
      }
      if (result.caughtUp) {
        await sleep(env.pollIntervalMs);
      }
    } catch (error) {
      // Log and keep going. The lag figure in the top bar is what tells a
      // user the numbers are behind; dying would leave them looking live.
      // Every line of it, and the stack, once per distinct reason: the first
      // line alone ("… failed on all 4 endpoints:") named neither the
      // endpoint's answer nor the step, and a stalled indexer whose log says
      // only that cannot be diagnosed from outside the box.
      failures++;
      const reason = (error as Error)?.message ?? String(error);
      if (reason !== lastReason || failures % 20 === 0) {
        log(`pass failed (${failures} in a row): ${reason}`);
        const stack = (error as Error)?.stack?.split('\n').slice(1, 8).join('\n');
        if (stack) log(`  at:\n${stack}`);
        lastReason = reason;
      } else {
        log(`pass failed again (${failures} in a row) — same reason`);
      }
      if (failures >= 3) log(`  narrowing the window to ${poller.narrowAfterFailure()} blocks to isolate it`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  await prisma.$disconnect();
  log('stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
