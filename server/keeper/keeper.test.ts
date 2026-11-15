/**
 * The keeper's decisions, against a mocked viem client and the real test
 * database (keeper_runs).
 *
 * The keeper drives routers only — vaults need no keeper. The client is a
 * small chain of its own: a poke that lands moves the router's newest
 * observation to the block time, a route clears due(), exactly as the
 * contract does — which is what lets "decided from the chain, not memory" be
 * shown across a restart.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  parseAbiParameters,
  type Abi,
  type Hash,
} from 'viem';
import { tidewellRouterAbi } from '../../lib/contracts/abis';
import { prisma } from '../db';
import type { RouterRef } from '../indexer/contracts';
import { isReachable, resetDatabase } from '../test/db';
import type { KeeperClient, ReadArgs, ReceiptLike, WriteArgs } from './client';
import { Keeper } from './keeper';

const NOW = 1_800_000_000;
const SIGNER = '0x00000000000000000000000000000000000000c1';
const OTHER = '0x00000000000000000000000000000000000000c2';
const ROUTER = '0x000000000000000000000000000000000000b0b0';
const ROUTER_ABI = tidewellRouterAbi as unknown as Abi;

/** A revert exactly as viem raises it from simulateContract. */
function revert(errorName: string, args: readonly unknown[] = [], functionName = 'route'): Error {
  const data = encodeErrorResult({ abi: ROUTER_ABI, errorName, args } as never);
  const cause = new ContractFunctionRevertedError({ abi: ROUTER_ABI, data, functionName });
  return new ContractFunctionExecutionError(cause, { abi: ROUTER_ABI, functionName, args: [], contractAddress: ROUTER });
}

class MockChain implements KeeperClient {
  now = BigInt(NOW);
  block = 5_000n;
  router = { keeper: SIGNER, paused: false, observedAt: NOW - 10 * 60, due: false };
  /** Per function name: what simulating it throws. */
  simulateErrors: Record<string, Error> = {};
  writes: { functionName: string; args: readonly unknown[] }[] = [];
  simulations: WriteArgs[] = [];
  nonce = { pending: 3, latest: 3 };
  reads = 0;

  async getBlock() {
    return { number: this.block, timestamp: this.now };
  }

  async readContract(args: ReadArgs): Promise<unknown> {
    this.reads++;
    if (args.address.toLowerCase() !== ROUTER) throw new Error(`unmocked read ${args.address}.${args.functionName}`);
    switch (args.functionName) {
      case 'keeper': return this.router.keeper;
      case 'paused': return this.router.paused;
      case 'observationIndex': return 7;
      case 'observations': return [this.router.observedAt, 0n];
      case 'due': return this.router.due;
    }
    throw new Error(`unmocked read ${args.functionName}`);
  }

  async simulateContract(args: WriteArgs) {
    this.simulations.push(args);
    const error = this.simulateErrors[args.functionName];
    if (error) throw error;
    return { request: args };
  }

  async writeContract(request: unknown): Promise<Hash> {
    const call = request as WriteArgs;
    this.writes.push({ functionName: call.functionName, args: call.args ?? [] });
    // Mined in the next block, like the contract would.
    this.block += 1n;
    if (call.functionName === 'poke') this.router.observedAt = Number(this.now);
    if (call.functionName === 'route') this.router.due = false;
    return `0x${this.writes.length.toString(16).padStart(64, '0')}` as Hash;
  }

  async waitForTransactionReceipt(): Promise<ReceiptLike> {
    const last = this.writes[this.writes.length - 1];
    const logs = [];
    if (last.functionName === 'route') {
      logs.push({
        address: ROUTER,
        topics: encodeEventTopics({ abi: tidewellRouterAbi, eventName: 'Routed' }) as string[],
        data: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint128, int24, int24'), [10n ** 17n, 5n * 10n ** 16n, 123n, 456n, -23_000, -22_990]),
      });
    }
    return { status: 'success', blockNumber: this.block, logs };
  }

  async getTransactionCount(args: { blockTag: 'pending' | 'latest' }) {
    return args.blockTag === 'pending' ? this.nonce.pending : this.nonce.latest;
  }

  async getBalance() {
    return 10n ** 16n;
  }
}

let wall = 1_000_000;
const routerRef: RouterRef = {
  address: ROUTER,
  token: '0x0000000000000000000000000000000000000001',
  owner: OTHER,
  poolId: `v4:0x${'a1'.padStart(64, '0')}`,
  createdBlock: 1n,
  createdAt: new Date((NOW - 30 * 86_400) * 1000),
};

function keeper(chain: MockChain, options: { account?: string | null; routers?: RouterRef[] } = {}) {
  const account = options.account === undefined ? SIGNER : options.account;
  return new Keeper({
    client: chain,
    account: account as `0x${string}` | null,
    signerProblem: account ? null : 'KEEPER_PRIVATE_KEY is not set, so the keeper cannot sign',
    routers: async () => options.routers ?? [routerRef],
    wallNow: () => wall,
  });
}

const runs = () => prisma.keeperRun.findMany({ orderBy: { startedAt: 'asc' } });
const names = (chain: MockChain) => chain.writes.map((w) => w.functionName);

beforeEach(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  await resetDatabase();
  wall += 10 * 3_600_000;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the keeper', () => {
  it('does nothing — reads nothing on chain — with no router deployed', async () => {
    const chain = new MockChain();
    await keeper(chain, { routers: [] }).tick();
    expect(chain.reads).toBe(0);
    expect(chain.writes).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
  });
});

describe('pokes', () => {
  it('pokes a router whose newest on-chain observation is four minutes old', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 250;
    await keeper(chain).tick();
    expect(names(chain)).toEqual(['poke']);
    // A successful poke is a log line and an indexed Observed event, not a run.
    expect(await runs()).toHaveLength(0);
  });

  it('decides from the chain, not memory: no second poke a minute later, or after a restart', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 600;
    const first = keeper(chain);
    await first.tick();
    chain.now += 60n;
    await first.tick();
    chain.now += 60n;
    await keeper(chain).tick(); // a restarted process
    expect(names(chain)).toEqual(['poke']);
    // Four minutes after the poke, the next one.
    chain.now = BigInt(NOW + 240);
    await keeper(chain).tick();
    expect(names(chain)).toEqual(['poke', 'poke']);
  });

  it('records a poke that fails in simulation, and sends nothing', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 600;
    chain.simulateErrors.poke = revert('NotKeeper', [], 'poke');
    await keeper(chain).tick();
    expect(chain.writes).toHaveLength(0);
    const [run] = await runs();
    expect(run.kind).toBe('poke');
    expect(run.status).toBe('skipped');
    expect(run.reason).toMatch(/not this contract's keeper \(NotKeeper\)/);
  });

  it('leaves a paused router alone', async () => {
    const chain = new MockChain();
    chain.router.paused = true;
    chain.router.observedAt = NOW - 3_000;
    chain.router.due = true;
    await keeper(chain).tick();
    expect(chain.simulations).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
  });
});

describe('routes', () => {
  it('routes when due(), with a timestamp deadline, and records what Routed said', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 30;
    chain.router.due = true;
    await keeper(chain).tick();
    expect(names(chain)).toEqual(['route']);
    expect(chain.writes[0].args).toEqual([BigInt(NOW + 300)]);
    const [run] = await runs();
    expect(run.kind).toBe('route');
    expect(run.status).toBe('ok');
    expect(run.txHash).toMatch(/^0x/);
    const details = run.details as Record<string, unknown>;
    expect(details.wethIn).toBe((10n ** 17n).toString());
    expect(details.twapTick).toBe(-23_000);
  });

  it('pokes first, then routes, when both are due', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 300;
    chain.router.due = true;
    await keeper(chain).tick();
    expect(names(chain)).toEqual(['poke', 'route']);
  });

  it('records a route that would revert TwapUnavailable as skipped, decoded, and sends nothing', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 30;
    chain.router.due = true;
    chain.simulateErrors.route = revert('TwapUnavailable');
    await keeper(chain).tick();
    expect(chain.writes).toHaveLength(0);
    const [run] = await runs();
    expect(run.status).toBe('skipped');
    expect(run.reason).toMatch(/simulation reverted, nothing sent/);
    expect(run.reason).toMatch(/under 30 minutes of its own price history/);
    expect((run.details as Record<string, unknown>).revert).toBe('TwapUnavailable');
  });

  it('asks again five minutes after TwapUnavailable, not after a growing backoff', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 30;
    chain.router.due = true;
    chain.simulateErrors.route = revert('TwapUnavailable');
    const k = keeper(chain);
    await k.tick();
    wall += 4 * 60_000;
    await k.tick();
    expect(chain.simulations).toHaveLength(1);
    wall += 2 * 60_000;
    delete chain.simulateErrors.route;
    await k.tick();
    expect(names(chain)).toEqual(['route']);
  });

  it.each([
    ['TwapDeviation', [-21_000, -23_000], /spot tick -21000 .* average -23000/],
    ['Slippage', [100n, 150n], /buy 100 of the token, under the 150/],
    ['NoMilestoneReached', [5n * 10n ** 18n, 10n ** 19n], /FDV of 5\.00000 WETH is below the next milestone of 10\.0000 WETH/],
    ['NothingToRoute', [], /no WETH waiting/],
  ] as const)('decodes %s with its arguments', async (name, args, sentence) => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 30;
    chain.router.due = true;
    chain.simulateErrors.route = revert(name, args);
    await keeper(chain).tick();
    expect(chain.writes).toHaveLength(0);
    expect((await runs())[0].reason).toMatch(sentence);
  });

  it('does not send over a transaction of its own that is still pending', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 30;
    chain.router.due = true;
    chain.nonce = { pending: 4, latest: 3 };
    await keeper(chain).tick();
    expect(chain.writes).toHaveLength(0);
    expect((await runs())[0].reason).toMatch(/still pending/);
  });
});

describe('refusals', () => {
  it("refuses to poke or route a router whose keeper() is not the signer — both are keeper-only — and says so once an hour", async () => {
    const chain = new MockChain();
    chain.router.keeper = OTHER;
    chain.router.observedAt = NOW - 600;
    chain.router.due = true;
    const k = keeper(chain);
    await k.tick();
    await k.tick();
    expect(chain.simulations).toHaveLength(0);
    expect(chain.writes).toHaveLength(0);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('skipped');
    expect(all[0].reason).toMatch(/is not this router's keeper/);
    expect(all[0].reason).toContain(OTHER);
    wall += 61 * 60_000;
    await k.tick();
    expect(await runs()).toHaveLength(2);
  });

  it('records a skip, and simulates nothing, without a key', async () => {
    const chain = new MockChain();
    chain.router.observedAt = NOW - 600;
    await keeper(chain, { account: null }).tick();
    expect(chain.simulations).toHaveLength(0);
    const [run] = await runs();
    expect(run.kind).toBe('poke');
    expect(run.status).toBe('skipped');
    expect(run.reason).toMatch(/KEEPER_PRIVATE_KEY is not set/);
  });

  it('asks for nothing at all when the router needs neither a poke nor a route', async () => {
    const chain = new MockChain();
    chain.router.keeper = OTHER; // would be refused — but nothing is needed
    chain.router.observedAt = NOW - 30;
    await keeper(chain, { account: null }).tick();
    expect(await runs()).toHaveLength(0);
  });
});
