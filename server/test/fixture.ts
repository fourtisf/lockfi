/**
 * A deterministic synthetic chain, for §9.
 *
 * The acceptance criterion is "re-running the indexer from block zero on a
 * fresh database produces byte-identical `pool_fee_hourly` rows to the
 * incremental run, and a forced 32-block reorg replay changes no row count".
 * That is only provable against a log source you can replay exactly, so this
 * builds one: real ABI-encoded logs, generated from a seeded PRNG, served
 * through the same `LogSource` interface viem implements.
 *
 * The logs are encoded rather than hand-written objects on purpose — the
 * decoder in events.ts is on the path being proven, not mocked out of it.
 *
 * One fixture liberty: blocks are 60 seconds apart rather than the chain's
 * ~100ms (§2), so a few hundred blocks spans the days a trailing-7d window
 * needs. The indexer reads every timestamp from the source, so block spacing
 * changes nothing about the logic under test.
 */

import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import { mulberry32 } from '../../lib/rng';
import { POOL_MANAGER_ABI, V3_FACTORY_ABI, V3_POOL_ABI } from '../chain/abi';
import { amountsForLiquidity, getSqrtRatioAtTick } from '../chain/tick-math';
import type { TokenFacts } from '../indexer/discovery';
import { poolKey } from '../indexer/events';
import type { LogSource } from '../indexer/poller';

const MANAGER = CONTRACTS.poolManager.toLowerCase();

/** 60s blocks: see the header. */
export const FIXTURE_BLOCK_SECONDS = 60;
/** Chain time at block 1. Fixed, so every run produces the same hours. */
export const FIXTURE_GENESIS = new Date('2026-03-01T00:00:00.000Z');

function address(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
}

function bytes32(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
}

/** WETH's real address, because the aggregation keys USD pricing off it. */
export const WETH = CONTRACTS.weth.toLowerCase() as `0x${string}`;
export const USDG = address(0xd6);

/**
 * `totalSupply` is set for most tokens and deliberately absent for one, so
 * both the fully-diluted figure and the "no supply read, show an em dash"
 * path are exercised. MOONCAT is the one whose contract does not answer.
 */
export const FIXTURE_TOKENS: Record<string, TokenFacts> = {
  [WETH]: { address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, totalSupply: 120_000n * 10n ** 18n },
  [USDG]: { address: USDG.toLowerCase(), symbol: 'USDG', name: 'Global Dollar', decimals: 6, totalSupply: 900_000_000n * 10n ** 6n },
  [address(0x01).toLowerCase()]: { address: address(0x01).toLowerCase(), symbol: 'NVDA', name: 'NVIDIA Token', decimals: 18, totalSupply: 112_000n * 10n ** 18n },
  [address(0x02).toLowerCase()]: { address: address(0x02).toLowerCase(), symbol: 'PONS', name: 'Pons', decimals: 18, totalSupply: 1_000_000_000n * 10n ** 18n },
  [address(0x03).toLowerCase()]: { address: address(0x03).toLowerCase(), symbol: 'MOONCAT', name: 'Mooncat', decimals: 18, totalSupply: null },
  [address(0x04).toLowerCase()]: { address: address(0x04).toLowerCase(), symbol: 'TWINE', name: 'Twine', decimals: 18, totalSupply: 1_000_000_000n * 10n ** 18n },
};

/** The fixture's token reader: no network, exact decimals, fixed supplies. */
export const fixtureTokenReader = async (addr: string): Promise<TokenFacts> => {
  const known = FIXTURE_TOKENS[addr.toLowerCase()];
  if (known) return known;
  return {
    address: addr.toLowerCase(),
    symbol: 'UNKNOWN',
    name: 'Unknown token',
    decimals: 18,
    totalSupply: null,
  };
};

/**
 * USD prices the fixture is built around, so trade sizes and reserves come
 * out at realistic magnitudes.
 *
 * This matters more than it looks. A fixture with absurd prices proves the
 * pipeline survives absurd prices and nothing else — it was a fixture at a
 * nonsense tick that first made this suite fail, and the bug it exposed (an
 * overflow that stops the aggregation for every pool, not just the bad one)
 * was real. So the fixture is priced like a market, and there is a separate
 * test for the absurd case.
 */
export const FIXTURE_USD: Record<string, number> = {
  [WETH]: 2500,
  [USDG.toLowerCase()]: 1,
  [address(0x01).toLowerCase()]: 187.2,
  [address(0x02).toLowerCase()]: 0.5937,
  [address(0x03).toLowerCase()]: 0.0525,
  [address(0x04).toLowerCase()]: 0.00163,
};

interface FixturePool {
  /** bytes32 pool id. */
  id: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  feePips: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  /**
   * Tick the pool initialises at, derived from FIXTURE_USD rather than picked:
   * `tick = log(price1_per_price0 * 10^(d1-d0)) / log(1.0001)`, rounded to the
   * spacing. A hand-picked tick is how the nonsense price got in.
   */
  tick: number;
  /** Liquidity seeded at the init block, chosen to give the pool real depth. */
  liquidity: bigint;
  /** Block the Initialize lands in. Staggers pool ages, so §7's three
   *  yield states all appear in one fixture. */
  initBlock: number;
}

/**
 * Four pools. The WETH/USDG one is the site's single USD anchor (§4.3), so
 * without it every figure downstream would read zero — which is itself worth
 * a fixture, and the test asserts the anchor produces non-zero USD.
 */
export const FIXTURE_POOLS: FixturePool[] = [
  // Anchor: USDG token0 (6 dec), WETH token1 (18 dec). $1 / $2500 -> +198080.
  // Deep, because a thin anchor makes every USD figure on the site jumpy for
  // reasons that have nothing to do with what is being tested.
  { id: bytes32(0xa0), currency0: USDG, currency1: WETH, feePips: 500, tickSpacing: 10, hooks: address(0), tick: 198_080, liquidity: 8n * 10n ** 18n, initBlock: 1 },
  // Old and deep: 7d+ of fees, so it reaches the plain trailing7d state.
  { id: bytes32(0xa1), currency0: address(0x01), currency1: WETH, feePips: 3000, tickSpacing: 60, hooks: address(0), tick: -25_920, liquidity: 25n * 10n ** 21n, initBlock: 1 },
  { id: bytes32(0xa2), currency0: address(0x02), currency1: WETH, feePips: 3000, tickSpacing: 60, hooks: address(0), tick: -83_460, liquidity: 25n * 10n ** 21n, initBlock: 2 },
  // Young: created three days in, so it lands in the `est.` state.
  { id: bytes32(0xa3), currency0: address(0x03), currency1: WETH, feePips: 10_000, tickSpacing: 200, hooks: address(0), tick: -107_800, liquidity: 8n * 10n ** 21n, initBlock: 4_400 },
];

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
}

function initializeLog(pool: FixturePool, block: number, logIndex: number): RawLog {
  const topics = encodeEventTopics({
    abi: POOL_MANAGER_ABI,
    eventName: 'Initialize',
    args: { id: pool.id, currency0: pool.currency0, currency1: pool.currency1 },
  });
  const data = encodeAbiParameters(
    parseAbiParameters('uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick'),
    [pool.feePips, pool.tickSpacing, pool.hooks, getSqrtRatioAtTick(pool.tick), pool.tick],
  );
  return {
    address: MANAGER,
    topics: topics as string[],
    data,
    blockNumber: BigInt(block),
    logIndex,
    transactionHash: txHash(block, logIndex),
  };
}

function swapLog(args: {
  poolId: `0x${string}`;
  sender: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
  tick: number;
  liquidity: bigint;
  feePips: number;
  block: number;
  logIndex: number;
}): RawLog {
  const topics = encodeEventTopics({
    abi: POOL_MANAGER_ABI,
    eventName: 'Swap',
    args: { id: args.poolId, sender: args.sender },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      'int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee',
    ),
    [
      args.amount0,
      args.amount1,
      getSqrtRatioAtTick(args.tick),
      args.liquidity,
      args.tick,
      args.feePips,
    ],
  );
  return {
    address: MANAGER,
    topics: topics as string[],
    data,
    blockNumber: BigInt(args.block),
    logIndex: args.logIndex,
    transactionHash: txHash(args.block, args.logIndex),
  };
}

function modifyLiquidityLog(args: {
  poolId: `0x${string}`;
  sender: `0x${string}`;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
  block: number;
  logIndex: number;
}): RawLog {
  const topics = encodeEventTopics({
    abi: POOL_MANAGER_ABI,
    eventName: 'ModifyLiquidity',
    args: { id: args.poolId, sender: args.sender },
  });
  const data = encodeAbiParameters(
    parseAbiParameters('int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt'),
    [args.tickLower, args.tickUpper, args.liquidityDelta, bytes32(0)],
  );
  return {
    address: MANAGER,
    topics: topics as string[],
    data,
    blockNumber: BigInt(args.block),
    logIndex: args.logIndex,
    transactionHash: txHash(args.block, args.logIndex),
  };
}

/** A USD amount in a token's own smallest units, at the fixture's prices. */
function toUnits(usd: number, token: `0x${string}`): bigint {
  const price = FIXTURE_USD[token.toLowerCase()] ?? 1;
  const decimals = FIXTURE_TOKENS[token.toLowerCase()]?.decimals ?? 18;
  // Scale through an integer so the result is exact and reproducible.
  return (BigInt(Math.round((usd / price) * 1e6)) * 10n ** BigInt(decimals)) / 1_000_000n;
}

/** Deterministic and unique per (block, logIndex): the row's primary key. */
function txHash(block: number, logIndex: number): string {
  return toHex(BigInt(block) * 1_000_000n + BigInt(logIndex), { size: 32 });
}

export interface FixtureChain {
  logs: RawLog[];
  headBlock: number;
  blockTime(block: number): Date;
}

/**
 * Build the chain. Same seed, same logs, byte for byte — which is what makes
 * the two runs in the §9 test comparable at all.
 */
export function buildFixtureChain(blocks = 11_000, seed = 4663): FixtureChain {
  const rng = mulberry32(seed);
  const logs: RawLog[] = [];

  // Liquidity is seeded once per pool, wide, at its init block.
  for (const pool of FIXTURE_POOLS) {
    logs.push(initializeLog(pool, pool.initBlock, 0));
    logs.push(
      modifyLiquidityLog({
        poolId: pool.id,
        sender: address(0xbeef),
        tickLower: pool.tick - 20 * pool.tickSpacing,
        tickUpper: pool.tick + 20 * pool.tickSpacing,
        liquidityDelta: pool.liquidity,
        block: pool.initBlock,
        logIndex: 1,
      }),
    );
  }

  const liveFrom = new Map(FIXTURE_POOLS.map((p) => [p.id, p.initBlock]));
  const tickNow = new Map(FIXTURE_POOLS.map((p) => [p.id, p.tick]));

  /**
   * Running reserves per pool, so the fixture conserves mass.
   *
   * Without this the generator emitted swaps larger than the pool held and
   * the derived reserves went negative — which no real AMM can do, and which
   * made the TVL clamp to zero and the whole test measure the clamp instead
   * of the pricing. A fixture has to be a plausible chain to be worth
   * anything.
   */
  const reserves = new Map<string, { r0: bigint; r1: bigint }>();
  for (const pool of FIXTURE_POOLS) {
    const seeded = amountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(pool.tick),
      tickLower: pool.tick - 20 * pool.tickSpacing,
      tickUpper: pool.tick + 20 * pool.tickSpacing,
      liquidityDelta: pool.liquidity,
    });
    reserves.set(pool.id, { r0: seeded.amount0, r1: seeded.amount1 });
  }

  /** No single swap takes more than this share of either side. */
  const MAX_SWAP_SHARE = 40n; // i.e. 1/40th, 2.5%

  for (let block = 2; block <= blocks; block++) {
    // Most blocks are empty, which is realistic and exercises the gaps in
    // pool_fee_hourly that the sparkline and the trailing sums have to span.
    if (rng() > 0.22) continue;

    let logIndex = 0;
    const swapsHere = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < swapsHere; i++) {
      const pool = FIXTURE_POOLS[Math.floor(rng() * FIXTURE_POOLS.length)];
      if (block <= (liveFrom.get(pool.id) ?? 0)) continue;

      // Walk the tick a little, so prices move and the 24h change is real.
      const drift = Math.round((rng() - 0.5) * 4) * pool.tickSpacing;
      const tick = (tickNow.get(pool.id) ?? pool.tick) + drift;
      tickNow.set(pool.id, tick);

      // Sized in dollars and then converted into each token's own units,
      // because the two sides can have different decimals — a single shared
      // scale made the anchor's USDG side a $900bn trade.
      const zeroForOne = rng() > 0.5;
      const tradeUsd = 120 + rng() * 24_000;
      const inToken = zeroForOne ? pool.currency0 : pool.currency1;
      const outToken = zeroForOne ? pool.currency1 : pool.currency0;
      const held = reserves.get(pool.id)!;
      const reserveIn = zeroForOne ? held.r0 : held.r1;
      const reserveOut = zeroForOne ? held.r1 : held.r0;
      if (reserveOut <= 0n) continue;

      // Cap the trade at a share of both sides, then let the smaller cap win.
      let amountIn = toUnits(tradeUsd, inToken);
      let amountOut = (toUnits(tradeUsd, outToken) * 997n) / 1000n;
      const capIn = reserveIn > 0n ? reserveIn / MAX_SWAP_SHARE : amountIn;
      const capOut = reserveOut / MAX_SWAP_SHARE;
      if (amountIn > capIn && capIn > 0n) {
        amountOut = (amountOut * capIn) / amountIn;
        amountIn = capIn;
      }
      if (amountOut > capOut) {
        amountIn = (amountIn * capOut) / (amountOut === 0n ? 1n : amountOut);
        amountOut = capOut;
      }
      if (amountIn <= 0n || amountOut <= 0n) continue;

      logs.push(
        swapLog({
          poolId: pool.id,
          sender: address(0x1000 + (block % 64)),
          amount0: zeroForOne ? amountIn : -amountOut,
          amount1: zeroForOne ? -amountOut : amountIn,
          tick,
          liquidity: pool.liquidity,
          feePips: pool.feePips,
          block,
          logIndex: logIndex++,
        }),
      );
      reserves.set(pool.id, {
        r0: zeroForOne ? held.r0 + amountIn : held.r0 - amountOut,
        r1: zeroForOne ? held.r1 - amountOut : held.r1 + amountIn,
      });
    }

    // Occasional liquidity change, so reserves move for reasons other than
    // swaps and the derived TVL is not a constant.
    if (rng() > 0.94) {
      const pool = FIXTURE_POOLS[Math.floor(rng() * FIXTURE_POOLS.length)];
      if (block > (liveFrom.get(pool.id) ?? 0)) {
        const add = rng() > 0.4;
        const delta = (add ? 1n : -1n) * (pool.liquidity / 20n);
        const moved = amountsForLiquidity({
          sqrtPriceX96: getSqrtRatioAtTick(tickNow.get(pool.id) ?? pool.tick),
          tickLower: pool.tick - 10 * pool.tickSpacing,
          tickUpper: pool.tick + 10 * pool.tickSpacing,
          liquidityDelta: delta,
        });
        const held = reserves.get(pool.id)!;
        // A burn cannot take out more than the pool holds.
        if (held.r0 + moved.amount0 >= 0n && held.r1 + moved.amount1 >= 0n) {
          logs.push(
            modifyLiquidityLog({
              poolId: pool.id,
              sender: address(0xbeef),
              tickLower: pool.tick - 10 * pool.tickSpacing,
              tickUpper: pool.tick + 10 * pool.tickSpacing,
              liquidityDelta: delta,
              block,
              logIndex: logIndex++,
            }),
          );
          reserves.set(pool.id, {
            r0: held.r0 + moved.amount0,
            r1: held.r1 + moved.amount1,
          });
        }
      }
    }
  }

  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  return {
    logs,
    headBlock: blocks,
    blockTime: (block: number) =>
      new Date(FIXTURE_GENESIS.getTime() + (block - 1) * FIXTURE_BLOCK_SECONDS * 1000),
  };
}

/**
 * A `LogSource` over a fixture chain.
 *
 * `headBlock` is settable so a test can advance head a range at a time — that
 * is how the incremental run is made to behave like a poller following a live
 * chain rather than one that sees the whole history at once.
 */
export class FixtureLogSource implements LogSource {
  private head: number;
  /** Every getLogs call, for asserting the re-scan actually happened. */
  readonly calls: { from: bigint; to: bigint }[] = [];

  constructor(
    private readonly chain: FixtureChain,
    head = chain.headBlock,
  ) {
    this.head = head;
  }

  setHead(block: number): void {
    this.head = Math.min(block, this.chain.headBlock);
  }

  async getHeadBlock(): Promise<{ number: bigint; timestamp: Date }> {
    return { number: BigInt(this.head), timestamp: this.chain.blockTime(this.head) };
  }

  async getBlockTimes(from: bigint, to: bigint): Promise<Map<bigint, Date>> {
    const times = new Map<bigint, Date>();
    for (let b = from; b <= to; b++) times.set(b, this.chain.blockTime(Number(b)));
    return times;
  }

  async getLogs(args: {
    address: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    this.calls.push({ from: args.fromBlock, to: args.toBlock });
    const wanted = new Set(
      (Array.isArray(args.address) ? args.address : [args.address]).map((a) => a.toLowerCase()),
    );
    return this.chain.logs.filter(
      (log) =>
        wanted.has(log.address.toLowerCase()) &&
        log.blockNumber >= args.fromBlock &&
        log.blockNumber <= args.toBlock,
    );
  }
}

/**
 * A minimal chain with one sane anchor and one pool initialised at an absurd
 * tick, for the case that first broke this suite.
 *
 * A pool at tick -276000 with a 6-decimal token0 and an 18-decimal token1
 * derives a WETH price near 1e24 USD. Nothing stops anyone creating such a
 * pool on the real chain, and the aggregation must not overflow on it — an
 * overflow throws, which stops the pass, which freezes every other pool's
 * data too.
 */
export function buildAbsurdPoolChain(): FixtureChain {
  const logs: RawLog[] = [];
  const anchor = FIXTURE_POOLS[0];
  const absurd: FixturePool = {
    id: bytes32(0xff),
    currency0: USDG,
    currency1: address(0x04),
    feePips: 3000,
    tickSpacing: 60,
    hooks: address(0),
    // The tick the broken fixture used. Keep it: it is the regression.
    tick: -276_000,
    liquidity: 10n ** 20n,
    initBlock: 1,
  };

  for (const pool of [anchor, absurd]) {
    logs.push(initializeLog(pool, pool.initBlock, logs.length));
    logs.push(
      modifyLiquidityLog({
        poolId: pool.id,
        sender: address(0xbeef),
        tickLower: pool.tick - 20 * pool.tickSpacing,
        tickUpper: pool.tick + 20 * pool.tickSpacing,
        liquidityDelta: pool.liquidity,
        block: pool.initBlock,
        logIndex: logs.length,
      }),
    );
  }

  // A handful of swaps in each, so both pools have fees to value.
  let block = 10;
  for (const pool of [anchor, absurd]) {
    for (let i = 0; i < 6; i++, block += 3) {
      const inToken = i % 2 === 0 ? pool.currency0 : pool.currency1;
      const outToken = i % 2 === 0 ? pool.currency1 : pool.currency0;
      logs.push(
        swapLog({
          poolId: pool.id,
          sender: address(0x1234),
          amount0: i % 2 === 0 ? toUnits(500, inToken) : -((toUnits(500, outToken) * 997n) / 1000n),
          amount1: i % 2 === 0 ? -((toUnits(500, outToken) * 997n) / 1000n) : toUnits(500, inToken),
          tick: pool.tick,
          liquidity: pool.liquidity,
          feePips: pool.feePips,
          block,
          logIndex: 0,
        }),
      );
    }
  }

  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  return {
    logs,
    headBlock: block + 10,
    blockTime: (b: number) =>
      new Date(FIXTURE_GENESIS.getTime() + (b - 1) * FIXTURE_BLOCK_SECONDS * 1000),
  };
}

/** The absurd pool's id, for asserting what happened to it. */
export const ABSURD_POOL_ID = `v4:${bytes32(0xff)}`;

// ------------------------------------------------------------------ native --

/** How v4 names native ETH as a pool currency. */
const NATIVE = address(0);

/**
 * The main fixture's anchor and PONS markets, but holding ETH itself — the
 * zero address as currency0 — the way most v4 ETH pairs do.
 *
 * The indexer once recognised only WETH, so on a chain like this it never
 * found the anchor and priced nothing. The ticks are the main fixture's
 * negated: native sorts first, so each pair is the other way round and
 * token1-per-token0 inverts. Same markets, same prices, same depth.
 */
export const NATIVE_POOLS: FixturePool[] = [
  // ETH / USDG: 2500e6 / 1e18 USDG units per wei -> -198080.
  { id: bytes32(0xb0), currency0: NATIVE, currency1: USDG, feePips: 500, tickSpacing: 10, hooks: address(0), tick: -198_080, liquidity: 8n * 10n ** 18n, initBlock: 1 },
  // ETH / PONS: 2500 / 0.5937 PONS per ETH -> +83460.
  { id: bytes32(0xb2), currency0: NATIVE, currency1: address(0x02), feePips: 3000, tickSpacing: 60, hooks: address(0), tick: 83_460, liquidity: 25n * 10n ** 21n, initBlock: 2 },
];

export function buildNativeEthChain(): FixtureChain {
  const logs: RawLog[] = [];
  // Native ETH is priced and sized as WETH: same asset, same decimals.
  const units = (usd: number, token: `0x${string}`) => toUnits(usd, token === NATIVE ? WETH : token);

  for (const pool of NATIVE_POOLS) {
    logs.push(initializeLog(pool, pool.initBlock, logs.length));
    logs.push(
      modifyLiquidityLog({
        poolId: pool.id,
        sender: address(0xbeef),
        tickLower: pool.tick - 20 * pool.tickSpacing,
        tickUpper: pool.tick + 20 * pool.tickSpacing,
        liquidityDelta: pool.liquidity,
        block: pool.initBlock,
        logIndex: logs.length,
      }),
    );
  }

  let block = 10;
  for (const pool of NATIVE_POOLS) {
    for (let i = 0; i < 6; i++, block += 3) {
      const inToken = i % 2 === 0 ? pool.currency0 : pool.currency1;
      const outToken = i % 2 === 0 ? pool.currency1 : pool.currency0;
      logs.push(
        swapLog({
          poolId: pool.id,
          sender: address(0x1234),
          amount0: i % 2 === 0 ? units(500, inToken) : -((units(500, outToken) * 997n) / 1000n),
          amount1: i % 2 === 0 ? -((units(500, outToken) * 997n) / 1000n) : units(500, inToken),
          tick: pool.tick,
          liquidity: pool.liquidity,
          feePips: pool.feePips,
          block,
          logIndex: 0,
        }),
      );
    }
  }

  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  return {
    logs,
    headBlock: block + 10,
    blockTime: (b: number) =>
      new Date(FIXTURE_GENESIS.getTime() + (b - 1) * FIXTURE_BLOCK_SECONDS * 1000),
  };
}

// ---------------------------------------------------------------------- v3 --

/** A stand-in v3 factory address for the fixture. */
export const V3_FACTORY = address(0xfac);
/** The v3 pool the factory announces. */
export const V3_POOL = address(0x3001);
export const V3_POOL_ID = poolKey('v3', V3_POOL);

function poolCreatedLog(args: {
  token0: `0x${string}`;
  token1: `0x${string}`;
  feePips: number;
  tickSpacing: number;
  pool: `0x${string}`;
  block: number;
  logIndex: number;
}): RawLog {
  const topics = encodeEventTopics({
    abi: V3_FACTORY_ABI,
    eventName: 'PoolCreated',
    args: { token0: args.token0, token1: args.token1, fee: args.feePips },
  });
  const data = encodeAbiParameters(parseAbiParameters('int24 tickSpacing, address pool'), [
    args.tickSpacing,
    args.pool,
  ]);
  return {
    address: V3_FACTORY.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: BigInt(args.block),
    logIndex: args.logIndex,
    transactionHash: txHash(args.block, args.logIndex),
  };
}

function v3SwapLog(args: {
  amount0: bigint;
  amount1: bigint;
  tick: number;
  block: number;
  logIndex: number;
}): RawLog {
  const topics = encodeEventTopics({
    abi: V3_POOL_ABI,
    eventName: 'Swap',
    args: { sender: address(0x1234), recipient: address(0x1234) },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      'int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick',
    ),
    [args.amount0, args.amount1, getSqrtRatioAtTick(args.tick), 10n ** 22n, args.tick],
  );
  return {
    address: V3_POOL.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: BigInt(args.block),
    logIndex: args.logIndex,
    transactionHash: txHash(args.block, args.logIndex),
  };
}

function v3MintLog(args: {
  tickLower: number;
  tickUpper: number;
  amount: bigint;
  amount0: bigint;
  amount1: bigint;
  block: number;
  logIndex: number;
}): RawLog {
  const topics = encodeEventTopics({
    abi: V3_POOL_ABI,
    eventName: 'Mint',
    args: { owner: address(0xbeef), tickLower: args.tickLower, tickUpper: args.tickUpper },
  });
  const data = encodeAbiParameters(
    parseAbiParameters('address sender, uint128 amount, uint256 amount0, uint256 amount1'),
    [address(0xbeef), args.amount, args.amount0, args.amount1],
  );
  return {
    address: V3_POOL.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: BigInt(args.block),
    logIndex: args.logIndex,
    transactionHash: txHash(args.block, args.logIndex),
  };
}

/**
 * A chain with a WETH/USDG anchor on v4 and one v3 pool announced by the
 * factory, so the discovery path §4 requires is actually exercised.
 *
 * The v3 pool's swaps come from its own address, which the poller is not
 * watching until the factory event tells it to — so those swaps land on the
 * pass AFTER discovery, via the 32-block re-scan. That is the behaviour under
 * test, not an accident of the fixture.
 */
export function buildV3Chain(): FixtureChain {
  const logs: RawLog[] = [];
  const anchor = FIXTURE_POOLS[0];

  logs.push(initializeLog(anchor, 1, 0));
  logs.push(
    modifyLiquidityLog({
      poolId: anchor.id,
      sender: address(0xbeef),
      tickLower: anchor.tick - 200,
      tickUpper: anchor.tick + 200,
      liquidityDelta: anchor.liquidity,
      block: 1,
      logIndex: 1,
    }),
  );
  // Price the anchor, so the v3 pool below has a USD path.
  for (let i = 0; i < 4; i++) {
    logs.push(
      swapLog({
        poolId: anchor.id,
        sender: address(0x1234),
        amount0: toUnits(5_000, anchor.currency0),
        amount1: -((toUnits(5_000, anchor.currency1) * 997n) / 1000n),
        tick: anchor.tick,
        liquidity: anchor.liquidity,
        feePips: anchor.feePips,
        block: 2 + i,
        logIndex: 0,
      }),
    );
  }

  // The factory announces a v3 NVDA/WETH pool.
  const token = address(0x01);
  logs.push(
    poolCreatedLog({
      token0: token,
      token1: WETH,
      feePips: 3000,
      tickSpacing: 60,
      pool: V3_POOL,
      block: 20,
      logIndex: 0,
    }),
  );

  // v3 Mint carries its own amounts, unlike v4's ModifyLiquidity.
  const tick = -25_920;
  logs.push(
    v3MintLog({
      tickLower: tick - 1200,
      tickUpper: tick + 1200,
      amount: 25n * 10n ** 21n,
      amount0: 4_000n * 10n ** 18n,
      amount1: 300n * 10n ** 18n,
      block: 30,
      logIndex: 0,
    }),
  );
  for (let i = 0; i < 8; i++) {
    logs.push(
      v3SwapLog({
        amount0: toUnits(800, token),
        amount1: -((toUnits(800, WETH) * 997n) / 1000n),
        tick: tick + i * 60,
        block: 40 + i * 5,
        logIndex: 0,
      }),
    );
  }

  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  return {
    logs,
    headBlock: 200,
    blockTime: (b: number) =>
      new Date(FIXTURE_GENESIS.getTime() + (b - 1) * FIXTURE_BLOCK_SECONDS * 1000),
  };
}
