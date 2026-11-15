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

import { CONTRACTS } from '../../lib/chain';
import { assertChainId, getHead } from '../chain/client';
import { findDeploymentBlock } from '../chain/deployment';
import { env } from '../env';
import { prisma } from '../db';
import { publishTick } from '../api/bus';
import { Poller } from './poller';
import { defaultLogoSources } from './logo-sources';
import { ViemLogSource } from './viem-source';

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
    log,
  });

  let backoffMs = 1_000;
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
            `+${result.tokensFound} tokens, in ${passSeconds}s`,
        );
        // Tell the API something changed; it debounces before pushing (§4.4).
        await publishTick({ toBlock: result.toBlock.toString(), lagSeconds: result.lagSeconds });
      }
      if (result.caughtUp) {
        await sleep(env.pollIntervalMs);
      }
    } catch (error) {
      // Log and keep going. The lag figure in the top bar is what tells a
      // user the numbers are behind; dying would leave them looking live.
      log(`pass failed: ${(error as Error).message}`);
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
