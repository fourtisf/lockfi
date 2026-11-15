/**
 * The vault watcher against a scripted chain and the real database: where a
 * first run starts, that a restart resumes rather than re-reads, that a
 * re-read changes nothing, that a range the endpoint refuses is narrowed,
 * and that the snapshot turns what was read into the right figures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { prisma } from '../db';
import { queryVaultLive } from '../api/vault-live';
import { isReachable, resetDatabase } from '../test/db';
import { VaultWatcher, vaultSwapCursorKey, type RawSwap, type WatchClient } from './vault-watch';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const VAULT = '0x901deabd094bd204cbe02854b1924e5ab4c41597' as Address;
const POOL = 'v4:0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982';
// ETH at exactly $2,000 in USDG: sqrt(2000 · 10⁶ / 10¹⁸) · 2⁹⁶.
const SQRT_2000 = BigInt(Math.round(Math.sqrt(2000e-12) * 2 ** 60)) * 2n ** 36n;
const L = 10n ** 17n;
const BLOCKS_PER_SECOND = 10;
const T0 = 1_780_000_000; // block 0's timestamp

class ScriptedChain implements WatchClient {
  headBlock = 10_000_000n;
  swaps: RawSwap[] = [];
  refuseOver: bigint | null = null;
  calls = { logs: 0, refused: 0 };
  supply = 0n;

  time(b: bigint) {
    return T0 + Math.floor(Number(b) / BLOCKS_PER_SECOND);
  }
  async head() {
    return { number: this.headBlock, timestamp: this.time(this.headBlock) };
  }
  async blockTime(b: bigint) {
    return this.time(b);
  }
  async swapLogs(_id: Hex, from: bigint, to: bigint) {
    this.calls.logs++;
    if (this.refuseOver !== null && to - from + 1n > this.refuseOver) {
      this.calls.refused++;
      throw new Error('getLogs failed on all 1 endpoints:\n  x: query returned more than 10000 results');
    }
    return this.swaps.filter((s) => s.blockNumber >= from && s.blockNumber <= to);
  }
  async poolState() {
    return { sqrtPriceX96: SQRT_2000, tick: -200311, liquidity: L, feeGrowth0X128: 1n, feeGrowth1X128: 2n };
  }
  async vaultKey() {
    return { currency0: '0x0000000000000000000000000000000000000000', currency1: USDG, fee: 500 };
  }
  async vaultSupply() {
    return this.supply;
  }
  async token() {
    return { symbol: 'USDG', decimals: 6 };
  }
  /** One ETH sold into the pool at `block`, charged 625 pips (500 to LPs). */
  ethIn(block: bigint, logIndex = 0) {
    this.swaps.push({
      blockNumber: block,
      logIndex,
      txHash: `0x${block.toString(16).padStart(64, '0')}`,
      amount0: -(10n ** 18n),
      amount1: 1_999_000_000n,
      sqrtPriceX96: SQRT_2000,
      liquidity: L,
      tick: -200311,
      fee: 625,
    });
  }
}

const deployment = { address: VAULT, poolId: POOL, deployedBlock: 9_000_000 };
const blocksAgo = (chain: ScriptedChain, seconds: number) => chain.headBlock - BigInt(seconds * BLOCKS_PER_SECOND);

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});
beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('VaultWatcher', () => {
  it('starts a first run at the window and reads only the window', async () => {
    const chain = new ScriptedChain();
    chain.ethIn(blocksAgo(chain, 9 * 86_400)); // before the 8-day window
    chain.ethIn(blocksAgo(chain, 3 * 86_400));
    chain.ethIn(blocksAgo(chain, 3_600));
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();

    expect(await prisma.vaultSwap.count()).toBe(2);
    const state = await prisma.vaultPoolState.findUniqueOrThrow({ where: { poolId: POOL } });
    expect(state.blockNum).toBe(chain.headBlock);
    expect(state.historyFromBlock).toBe(blocksAgo(chain, 8 * 86_400));
    expect(state.symbol0).toBe('ETH');
    expect(state.symbol1).toBe('USDG');
    expect(state.decimals1).toBe(6);
    const cursor = await prisma.indexerCursor.findUniqueOrThrow({ where: { contract: vaultSwapCursorKey(POOL) } });
    expect(cursor.lastIndexedBlock).toBe(chain.headBlock);
  });

  it('resumes after a restart instead of re-reading, and a re-read adds nothing', async () => {
    const chain = new ScriptedChain();
    chain.ethIn(blocksAgo(chain, 600));
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    chain.headBlock += 6_000n;
    chain.ethIn(chain.headBlock - 10n); // inside the 32-block re-scan
    chain.ethIn(chain.headBlock - 3_000n);
    const before = chain.calls.logs;
    // A new process: nothing in memory, everything from the database.
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    expect(chain.calls.logs - before).toBe(1);
    expect(await prisma.vaultSwap.count()).toBe(3);
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    expect(await prisma.vaultSwap.count()).toBe(3);
  });

  it('narrows a range the endpoint refuses, and loses nothing', async () => {
    const chain = new ScriptedChain();
    chain.refuseOver = 30_000n;
    for (let i = 1; i <= 5; i++) chain.ethIn(blocksAgo(chain, i * 86_400));
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    expect(chain.calls.refused).toBeGreaterThan(0);
    expect(await prisma.vaultSwap.count()).toBe(5);
  });

  it('starts again at the window after being down longer than it', async () => {
    const chain = new ScriptedChain();
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    chain.headBlock += BigInt(10 * 86_400 * BLOCKS_PER_SECOND);
    chain.ethIn(blocksAgo(chain, 86_400));
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    const state = await prisma.vaultPoolState.findUniqueOrThrow({ where: { poolId: POOL } });
    expect(state.historyFromBlock).toBe(blocksAgo(chain, 8 * 86_400));
  });

  it('keeps going when a vault cannot be read, and says so once', async () => {
    const chain = new ScriptedChain();
    chain.vaultKey = async () => {
      throw new Error('poolKey failed on all 4 endpoints');
    };
    const said: string[] = [];
    const watcher = new VaultWatcher({ client: chain, vaults: [deployment], log: (m) => said.push(m) });
    await watcher.tick();
    await watcher.tick();
    expect(said.filter((m) => m.includes('poolKey failed'))).toHaveLength(1);
  });
});

describe('queryVaultLive', () => {
  it("prices, sums and annualises what the watcher read: the vault's own figures", async () => {
    const chain = new ScriptedChain();
    chain.supply = L / 100n; // the vault holds 1% of the in-range liquidity
    chain.ethIn(blocksAgo(chain, 3_600)); // in the last 24h
    chain.ethIn(blocksAgo(chain, 3 * 86_400)); // in the week, not the day
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();

    const live = (await queryVaultLive(USDG, null)).get(POOL)!;
    expect(live.ethPriceUsd).toBeCloseTo(2000, 6);
    expect(live.currencies.map((c) => c.symbol)).toEqual(['ETH', 'USDG']);
    expect(live.currencies[1].priceUsd).toBe(1);
    // One ETH in, 500 pips to LPs: 0.0005 ETH = $1, on $2,000 of volume.
    expect(live.fees24hUsd).toBeCloseTo(1, 6);
    expect(live.volume24hUsd).toBeCloseTo(2000, 6);
    expect(live.trades24h).toBe(1);
    // A swap three days ago at the same price as now: no move.
    expect(live.change24hPct).toBeCloseTo(0, 9);
    expect(live.feeHistory.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 6);
    expect(live.feeHistory[13]).toBeCloseTo(1, 6);
    expect(live.historyHours).toBe(168);

    // Full range: the week's fee growth per unit of liquidity over the value
    // of a unit, 2√P. Two swaps of 0.0005 ETH each on L liquidity:
    const sqrtP = Number(SQRT_2000) / 2 ** 96;
    const growthInEth = (2 * 0.0005e18) / Number(L);
    const weekReturn = (growthInEth * sqrtP * sqrtP) / (2 * sqrtP);
    expect(live.fullRangeYield.basis).toBe('trailing7d');
    if (live.fullRangeYield.basis === 'trailing7d') {
      expect(live.fullRangeYield.pct).toBeCloseTo(weekReturn * (365 / 7) * 100, 6);
    }
    // What the vault's own liquidity is worth: L/100 of full range at $2,000.
    const usdgPerUnit = (2 * sqrtP) / 1e6;
    expect(live.stakedUsd!).toBeCloseTo(Number(L / 100n) * usdgPerUnit, 2);
  });

  it('gives no yield under a day of history, and an estimate under a week (§7)', async () => {
    const chain = new ScriptedChain();
    chain.ethIn(blocksAgo(chain, 600));
    await new VaultWatcher({ client: chain, vaults: [deployment] }).tick();
    // The pool itself is twelve hours old: history cannot begin before it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tokens (address, symbol, name, decimals, first_seen) VALUES ('0x0bd7d308f8e1639fab988df18a8011f41eacad73','WETH','WETH',18, now()), ('${USDG}','USDG','USDG',6, now()) ON CONFLICT DO NOTHING`,
    );
    const createdAt = new Date((chain.time(chain.headBlock) - 12 * 3600) * 1000).toISOString();
    await prisma.$executeRawUnsafe(
      `INSERT INTO pools (id, address, chain_id, token0, token1, fee_tier, tick_spacing, protocol, created_block, created_at, stakeable)
       VALUES ('${POOL}', '${POOL.slice(3)}', 4663, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '${USDG}', 500, 10, 'v4', 1, '${createdAt}', true)`,
    );
    let live = (await queryVaultLive(USDG, null)).get(POOL)!;
    expect(live.historyHours).toBeCloseTo(12, 1);
    // No swap 24h back to measure a move from: unknown, not 0%.
    expect(live.change24hPct).toBeNull();
    expect(live.fullRangeYield).toEqual({ basis: 'insufficient', reason: 'young' });

    await prisma.$executeRawUnsafe(`UPDATE pools SET created_at = created_at - interval '2 days'`);
    live = (await queryVaultLive(USDG, null)).get(POOL)!;
    expect(live.fullRangeYield.basis).toBe('estimate');
  });

  it('is empty before the watcher has read anything', async () => {
    expect((await queryVaultLive(USDG, 1800)).size).toBe(0);
  });
});
