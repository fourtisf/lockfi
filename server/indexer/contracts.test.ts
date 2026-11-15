/**
 * Tidewell's own contracts, indexed the way §9 demands of everything else:
 * a one-shot sync from the deployment block, an incremental sync a few
 * hundred blocks at a time, and a forced replay of an already-indexed stretch
 * must all leave byte-identical contract_events, vaults and stakes — because
 * the raw rows are keyed by log coordinates and the tables the site reads are
 * rebuilt from them, never incremented (§14).
 *
 * The logs are ABI-encoded from the generated contract ABIs, so the decoder
 * is on the path being proven, not mocked out of it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, toHex, type Abi } from 'viem';
import { tidewellRouterAbi, tidewellRouterFactoryAbi, tidewellVaultAbi } from '../../lib/contracts/abis';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader, type FixtureChain } from '../test/fixture';
import { contractCursorKey, decodeContractLog, type ContractsConfig } from './contracts';
import { Poller } from './poller';

const VAULT = '0x000000000000000000000000000000000000a017';
const FACTORY = '0x000000000000000000000000000000000000fac7';
const ROUTER = '0x000000000000000000000000000000000000b0b0';
const KEEPER = '0x00000000000000000000000000000000000000c1';
const OWNER = '0x00000000000000000000000000000000000000c0';
const TREASURY = '0x00000000000000000000000000000000000000c3';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const ZAP = '0x0000000000000000000000000000000000002a90';
const TOKEN = '0x0000000000000000000000000000000000000001';
/** Fixture pool a1: NVDA / WETH, 0.30%, spacing 60. */
const POOL_HEX = `0x${'a1'.padStart(64, '0')}` as `0x${string}`;
const POOL_ID = `v4:${POOL_HEX}`;
const E18 = 10n ** 18n;

/** One ABI-encoded log, the way a node returns it. */
function event(abi: Abi, address: string, eventName: string, args: Record<string, unknown>, block: number, logIndex: number) {
  const item = abi.find((x) => x.type === 'event' && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const indexed = Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]));
  const plain = item.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args: indexed } as never) as string[],
    data: encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never),
    blockNumber: BigInt(block),
    logIndex,
    // Unique per (block, logIndex), and apart from the fixture's own hashes.
    transactionHash: toHex(BigInt(block) * 1_000_000n + 900_000n + BigInt(logIndex), { size: 32 }),
  };
}

const vault = (name: string, args: Record<string, unknown>, block: number, i: number) =>
  event(tidewellVaultAbi as unknown as Abi, VAULT, name, args, block, 100 + i);
const router = (name: string, args: Record<string, unknown>, block: number, i: number) =>
  event(tidewellRouterAbi as unknown as Abi, ROUTER, name, args, block, 200 + i);

function chainWithContracts(): FixtureChain {
  const chain = buildFixtureChain();
  const t = (block: number) => Math.floor(chain.blockTime(block).getTime() / 1000);
  chain.logs.push(
    // Deployment: the constructor's events. No keeper: vaults need none.
    vault('OwnershipTransferred', { previousOwner: '0x0000000000000000000000000000000000000000', newOwner: OWNER }, 6_000, 0),
    vault('TreasurySet', { treasury: TREASURY }, 6_000, 1),
    vault('ProtocolFeeSet', { bps: 1000 }, 6_000, 2),
    event(tidewellRouterFactoryAbi as unknown as Abi, FACTORY, 'RouterCreated', { router: ROUTER, token: TOKEN, owner: OWNER, poolId: POOL_HEX }, 6_050, 300),
    router('OwnershipTransferred', { previousOwner: '0x0000000000000000000000000000000000000000', newOwner: OWNER }, 6_050, 0),
    router('KeeperSet', { keeper: KEEPER }, 6_050, 1),
    // Stakers: Bob's shares came through the zap and belong to him.
    vault('Deposited', { sender: ALICE, recipient: ALICE, liquidity: 1n * E18, amount0: 5n * E18, amount1: 2n * E18 }, 6_100, 0),
    vault('Deposited', { sender: ZAP, recipient: BOB, liquidity: 3n * E18, amount0: 15n * E18, amount1: 6n * E18 }, 6_200, 0),
    router('Observed', { timestamp: t(6_300), tick: -25_900 }, 6_300, 0),
    // Someone pokes: fees collected and credited per share, 10% set aside.
    vault('FeesCollected', { amount0: 4n * E18, amount1: 10n ** 15n, protocolCut0: 4n * 10n ** 17n, protocolCut1: 10n ** 14n }, 7_000, 0),
    vault('Claimed', { account: ALICE, recipient: ALICE, amount0: 9n * 10n ** 17n, amount1: 2n * 10n ** 14n }, 8_000, 0),
    vault('DepositsOpenSet', { open: false }, 8_500, 0),
    // Alice leaves: the withdraw collects first.
    vault('FeesCollected', { amount0: 2n * E18, amount1: 5n * 10n ** 14n, protocolCut0: 2n * 10n ** 17n, protocolCut1: 5n * 10n ** 13n }, 9_000, 0),
    vault('Withdrawn', { account: ALICE, recipient: ALICE, liquidity: 1n * E18, amount0: 5n * E18, amount1: 2n * E18 }, 9_000, 1),
    // ...and claims after leaving: her fees stayed hers.
    vault('Claimed', { account: ALICE, recipient: ALICE, amount0: 4n * 10n ** 17n, amount1: 10n ** 14n }, 9_100, 0),
    router('Routed', { wethIn: 10n ** 17n, wethSwapped: 5n * 10n ** 16n, tokenBought: 123n, liquidity: 456n, twapTick: -25_900, spotTick: -25_890 }, 9_500, 0),
    router('Paused', { paused: true }, 9_600, 0),
    vault('ProtocolFeesPaid', { treasury: TREASURY, amount0: 6n * 10n ** 17n, amount1: 15n * 10n ** 13n }, 10_500, 0),
  );
  chain.logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  return chain;
}

const CONFIG: ContractsConfig = {
  vaults: [{ address: VAULT, poolId: POOL_ID, deployedBlock: 6_000 }],
  routerFactory: { address: FACTORY, fromBlock: 6_000n },
};

interface Dump {
  events: unknown[];
  vaults: unknown[];
  stakes: unknown[];
}

/** Everything the contracts produce, as text: §9 says byte-identical. */
async function dump(): Promise<Dump> {
  const [events, vaults, stakes] = await Promise.all([
    prisma.$queryRaw<unknown[]>`
      SELECT tx_hash, log_index, contract, source, block_num::text, to_char(block_time, 'YYYY-MM-DD HH24:MI:SS') AS t,
             kind, account, args::text
      FROM contract_events ORDER BY block_num, log_index`,
    prisma.$queryRaw<unknown[]>`
      SELECT pool_id, address, total_staked::text, total_staked_usd::text, stakers, protocol_fee_bps, deposits_open,
             fees_collected0::text, fees_collected1::text, protocol_cut0::text, protocol_cut1::text,
             claimed0::text, claimed1::text, protocol_paid0::text, protocol_paid1::text,
             to_char(staked_since, 'YYYY-MM-DD HH24:MI:SS') AS staked_since,
             to_char(last_collected_at, 'YYYY-MM-DD HH24:MI:SS') AS last_collected_at,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
      FROM vaults ORDER BY pool_id`,
    prisma.$queryRaw<unknown[]>`
      SELECT wallet, vault_id, shares::text, claimed0::text, claimed1::text, to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
      FROM stakes ORDER BY vault_id, wallet`,
  ]);
  return { events, vaults, stakes };
}

const chain = chainWithContracts();
let oneShot: Dump;

function poller(source: FixtureLogSource, blockRange: number, maxBlockRange: number) {
  return new Poller({
    source,
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange,
    maxBlockRange,
    tokenReader: fixtureTokenReader,
    contracts: CONFIG,
    contractEveryMs: 0,
  });
}

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  await resetDatabase();
  await poller(new FixtureLogSource(chain), chain.headBlock + 1, chain.headBlock + 1).syncToHead();
  oneShot = await dump();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('contract events', () => {
  it('stores every vault, factory and router event, decoded', () => {
    const kinds = (oneShot.events as { kind: string }[]).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'Deposited')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'FeesCollected')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'Claimed')).toHaveLength(2);
    expect(kinds).toContain('ProtocolFeesPaid');
    expect(kinds).toContain('RouterCreated');
    expect(kinds).toContain('Observed');
    expect(kinds).toContain('Routed');
    expect(oneShot.events).toHaveLength(18);
  });

  it('rebuilds the vault from them: staked, stakers, fee, fees collected, cut, claimed, paid', async () => {
    const [row] = await prisma.vault.findMany();
    expect(row.address).toBe(VAULT);
    expect(row.poolId).toBe(POOL_ID);
    expect(row.totalStaked.toFixed(0)).toBe((3n * E18).toString());
    expect(row.stakers).toBe(1); // Alice left
    expect(row.protocolFeeBps).toBe(1000);
    expect(row.depositsOpen).toBe(false);
    expect(row.feesCollected0.toFixed(0)).toBe((6n * E18).toString());
    expect(row.feesCollected1.toFixed(0)).toBe((15n * 10n ** 14n).toString());
    expect(row.protocolCut0.toFixed(0)).toBe((6n * 10n ** 17n).toString());
    expect(row.protocolCut1.toFixed(0)).toBe((15n * 10n ** 13n).toString());
    expect(row.claimed0.toFixed(0)).toBe((13n * 10n ** 17n).toString());
    expect(row.claimed1.toFixed(0)).toBe((3n * 10n ** 14n).toString());
    expect(row.protocolPaid0.toFixed(0)).toBe((6n * 10n ** 17n).toString());
    expect(row.protocolPaid1.toFixed(0)).toBe((15n * 10n ** 13n).toString());
    expect(row.stakedSince?.toISOString()).toBe(chain.blockTime(6_100).toISOString());
    expect(row.lastCollectedAt?.toISOString()).toBe(chain.blockTime(9_000).toISOString());
    // Valued at the pool's price like its TVL: real, and far below the pool's.
    expect(Number(row.totalStakedUsd)).toBeGreaterThan(0);
    const state = await prisma.poolState.findUniqueOrThrow({ where: { poolId: POOL_ID } });
    expect(Number(row.totalStakedUsd)).toBeLessThan(Number(state.tvlUsd));
  });

  it("rebuilds each staker's shares and claims; a wallet that left keeps what it claimed after leaving", async () => {
    const stakes = await prisma.stake.findMany({ orderBy: { wallet: 'asc' } });
    const by = new Map(stakes.map((s) => [s.wallet, s]));
    expect(by.get(BOB)?.shares.toFixed(0)).toBe((3n * E18).toString());
    expect(by.get(BOB)?.claimed0.toFixed(0)).toBe('0');
    expect(by.get(ZAP)).toBeUndefined();
    expect(by.get(ALICE)?.shares.toFixed(0)).toBe('0');
    expect(by.get(ALICE)?.claimed0.toFixed(0)).toBe((13n * 10n ** 17n).toString());
    expect(by.get(ALICE)?.claimed1.toFixed(0)).toBe((3n * 10n ** 14n).toString());
  });

  it('follows the router the factory announced, from its creation block', async () => {
    const cursor = await prisma.indexerCursor.findUnique({ where: { contract: contractCursorKey(ROUTER) } });
    expect(cursor?.lastIndexedBlock).toBe(BigInt(chain.headBlock));
  });

  it('produces byte-identical rows a few hundred blocks at a time, then through a forced replay', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain, 0);
    const p = poller(source, 300, 400);
    for (let head = 500; head < chain.headBlock + 700; head += 700) {
      source.setHead(head);
      await p.syncToHead();
    }
    // The pool pass and the contract pass reach head together on the last
    // pass, so the vault is valued at the final pool state in both runs.
    expect(await dump()).toEqual(oneShot);

    // Forced replay: rewind every cursor 2,000 blocks and read it all again.
    await prisma.$executeRaw`UPDATE indexer_cursors SET last_indexed_block = last_indexed_block - 2000`;
    const before = await prisma.contractEvent.count();
    await poller(source, 300, 400).syncToHead();
    expect(await prisma.contractEvent.count()).toBe(before);
    expect(await dump()).toEqual(oneShot);
  });

  it('decodes nothing it does not recognise, rather than guessing', () => {
    const foreign = { address: VAULT, topics: [`0x${'ab'.repeat(32)}`], data: '0x', blockNumber: 1n, logIndex: 0, transactionHash: `0x${'01'.repeat(32)}` };
    expect(decodeContractLog(foreign, 'vault', new Date())).toBeNull();
  });
});

describe('with nothing deployed', () => {
  it('reads nothing, queries nothing for contracts, and writes no vault', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
      contracts: { vaults: [], routerFactory: null },
      contractEveryMs: 0,
    }).syncToHead();
    expect(await prisma.contractEvent.count()).toBe(0);
    expect(await prisma.vault.count()).toBe(0);
    const cursors = await prisma.indexerCursor.findMany();
    expect(cursors.every((c) => !c.contract.startsWith('tidewell:'))).toBe(true);
  });
});
