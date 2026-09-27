/**
 * The LockFi Router, end to end, against Uniswap's own contracts on a local
 * chain: v4-core's PoolManager, v3-core's factory and pools, and the quoters
 * the keeper asks. Nothing below the RPC is mocked.
 *
 * What it proves, and the invariant under all of it: **the router's liquidity
 * in the pool only ever goes up.** Routes add to it; pausing, withdrawing and
 * collecting leave it exactly where it was; nothing takes it out.
 *
 * Setup is the same scratch directory `npm run check:lp` uses (see the header
 * of server/scripts/lp-local.ts): a hardhat node on 8545 with chainId 4663 and
 * the cancun hardfork, and v4-core and v4-periphery unpacked into v4c/ and v4p/.
 *
 *   LP_ARTIFACTS=/path/to/dir npm run check:router
 *
 * It exits non-zero if any check fails.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { CHAIN } from '../../lib/chain';
import abi from '../../lib/router/abi.json';
import factoryBytecode from '../../lib/router/factory-bytecode.json';
import { getSqrtRatioAtTick } from '../../lib/v4/tick-math';
import { PriceWindow, decide, readRouter, type PoolKey, type Quoters } from '../../lib/router/plan';
import { RouterTokens, v4PoolId, type ChainRead } from '../api/router-tokens';
import solc from 'solc';

const RPC = process.env.LP_RPC ?? 'http://127.0.0.1:8545';
const ART = process.env.LP_ARTIFACTS ?? '';
const REPO = join(__dirname, '..', '..');
const chain = { id: CHAIN.id, name: 'local', nativeCurrency: CHAIN.nativeCurrency, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
  if (body.error) {
    const e = new Error(body.error.message) as Error & { data?: unknown };
    e.data = body.error.data;
    throw e;
  }
  return body.result;
}
const provider = { request: ({ method, params }: { method: string; params?: unknown[] }) => rpc(method, params ?? []) };

let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${what}`);
  if (!ok) failures += 1;
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}
function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi; bytecode: string | { object: string } };
  const b = typeof json.bytecode === 'string' ? json.bytecode : json.bytecode.object;
  return { abi: json.abi, bytecode: (b.startsWith('0x') ? b : `0x${b}`) as Hex };
}

const ROUTER = abi.router as Abi;
const FACTORY = abi.factory as Abi;
const ERC20 = parseAbi([
  'function approve(address, uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function mint(address, uint256)',
  'function deposit() payable',
]);
const PM = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24 tick)',
  'function extsload(bytes32 slot) view returns (bytes32)',
]);
const MODIFY = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }',
  'function modifyLiquidity(PoolKey key, ModifyLiquidityParams params, bytes hookData) payable returns (int256)',
]);
const SWAP4 = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }',
  'struct TestSettings { bool takeClaims; bool settleUsingBurn; }',
  'function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)',
]);
const V3F = parseAbi(['function createPool(address, address, uint24) returns (address)', 'function getPool(address, address, uint24) view returns (address)']);
const V3POOL = parseAbi([
  'function initialize(uint160 sqrtPriceX96)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256, uint256, uint128, uint128)',
]);
const NPM = parseAbi([
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);
const SWAP3 = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);
const MIN_LIMIT = 4295128739n + 1n;
const MAX_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

async function main(): Promise<void> {
  if (!ART) throw new Error('Set LP_ARTIFACTS to the directory holding v4c/ and v4p/ (see the header).');
  const [deployer, team, trader, keeper, treasury, stranger] = (await rpc('eth_accounts')) as Address[];
  const as = (account: Address) => createWalletClient({ chain, account, transport: custom(provider) });

  const deployedIn = new Map<string, Hex>();
  async function deploy(a: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await as(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error('deploy failed');
    deployedIn.set(r.contractAddress.toLowerCase(), hash);
    return r.contractAddress;
  }
  async function write(account: Address, address: Address, abi: Abi, functionName: string, args: unknown[] = [], value = 0n): Promise<TransactionReceipt> {
    const hash = await as(account).writeContract({ address, abi, functionName, args, value, chain } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted`);
    return r;
  }
  async function pay(from: Address, to: Address, value: bigint): Promise<void> {
    const r = await pub.waitForTransactionReceipt({ hash: await as(from).sendTransaction({ to, value, chain } as never) });
    if (r.status !== 'success') throw new Error('transfer reverted');
  }
  /** The error name a call reverts with, or null if it would succeed. */
  async function revertName(account: Address, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<string | null> {
    try {
      await pub.simulateContract({ account, address, abi, functionName, args } as never);
      return null;
    } catch (e) {
      if (e instanceof BaseError) {
        const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
        if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? 'reverted';
      }
      return 'reverted';
    }
  }
  const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const balanceOf = (t: Address, who: Address) => read<bigint>(t, ERC20, 'balanceOf', [who]);
  const warp = async (seconds: number) => {
    await rpc('evm_increaseTime', [seconds]);
    await rpc('evm_mine');
  };
  const chainNow = async () => BigInt((await pub.getBlock()).timestamp);
  const deadline = async () => (await chainNow()) + 600n;
  function routed(r: TransactionReceipt) {
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: ROUTER, data: log.data, topics: log.topics });
        if (ev.eventName === 'Routed') return ev.args as unknown as { feePaid: bigint; swapIn: bigint; tokenOut: bigint; quoteAdded: bigint; tokenAdded: bigint; liquidity: bigint; tickLower: number; tickUpper: number };
      } catch {
        /* another contract's log */
      }
    }
    throw new Error('no Routed event');
  }

  // ------------------------------------------------------------ contracts --
  section('deploying Uniswap from its published bytecode, and the LockFi factory');
  const nm = join(REPO, 'node_modules/@uniswap');
  const weth = await deploy(artifact(join(ART, 'v4p/foundry-out/WETH.sol/WETH.default.json')));
  const tkn = await deploy(artifact(join(ART, 'v4p/foundry-out/MockERC20.sol/MockERC20.json')), ['Test Token', 'TKN', 18]);
  const v3f = await deploy(artifact(join(nm, 'v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json')));
  const npm = await deploy(artifact(join(nm, 'v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json')), [v3f, weth, deployer]);
  const swapRouter = await deploy(artifact(join(nm, 'v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json')), [v3f, weth]);
  const quoterV2 = await deploy(artifact(join(nm, 'v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json')), [v3f, weth]);
  const pm = await deploy(artifact(join(ART, 'v4c/out/PoolManager.sol/PoolManager.json')), [deployer]);
  const modify = await deploy(artifact(join(ART, 'v4c/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json')), [pm]);
  const swap4 = await deploy(artifact(join(ART, 'v4c/out/PoolSwapTest.sol/PoolSwapTest.json')), [pm]);
  const v4Quoter = await deploy(artifact(join(ART, 'v4p/foundry-out/V4Quoter.sol/V4Quoter.json')), [pm]);
  const quoters: Quoters = { v4Quoter, quoterV2 };
  const factory = await deploy({ abi: FACTORY, bytecode: factoryBytecode.bytecode as Hex }, [pm, weth, v3f, 100, treasury, keeper]);
  console.log(`  factory ${factory}\n  PoolManager ${pm}\n  weth ${weth}\n  tkn ${tkn}`);

  await write(deployer, tkn, ERC20, 'mint', [trader, parseEther('10000000')]);
  await write(trader, weth, ERC20, 'deposit', [], parseEther('500'));
  for (const spender of [modify, swap4, npm, swapRouter]) {
    await write(trader, tkn, ERC20, 'approve', [spender, 2n ** 255n]);
    await write(trader, weth, ERC20, 'approve', [spender, 2n ** 255n]);
  }

  const poolId = (k: PoolKey) =>
    keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
  const stateSlot = (k: PoolKey) => keccak256(encodePacked(['bytes32', 'bytes32'], [poolId(k), `0x${(6n).toString(16).padStart(64, '0')}`]));
  const slotPlus = (s: Hex, n: bigint) => `0x${(BigInt(s) + n).toString(16).padStart(64, '0')}` as Hex;
  const low128 = (h: Hex) => BigInt(h) & ((1n << 128n) - 1n);
  const v4PoolLiquidity = async (k: PoolKey) => low128(await read<Hex>(pm, PM, 'extsload', [slotPlus(stateSlot(k), 3n)]));
  const v4PositionLiquidity = async (k: PoolKey, owner: Address, lower: number, upper: number) => {
    const posKey = keccak256(encodePacked(['address', 'int24', 'int24', 'bytes32'], [owner, lower, upper, `0x${'0'.repeat(64)}`]));
    return low128(await read<Hex>(pm, PM, 'extsload', [keccak256(encodePacked(['bytes32', 'bytes32'], [posKey, slotPlus(stateSlot(k), 6n)]))]));
  };
  /** The router's liquidity summed over every range it has used: the figure that may never fall. */
  const lockedV4 = async (k: PoolKey, router: Address) => {
    const ranges = await read<{ lower: number; upper: number }[]>(router, ROUTER, 'ranges');
    let sum = 0n;
    for (const g of ranges) sum += await v4PositionLiquidity(k, router, g.lower, g.upper);
    return sum;
  };
  const lockedV3 = async (pool: Address, router: Address) => {
    const ranges = await read<{ lower: number; upper: number }[]>(router, ROUTER, 'ranges');
    let sum = 0n;
    for (const g of ranges) {
      const key = keccak256(encodePacked(['address', 'int24', 'int24'], [router, g.lower, g.upper]));
      sum += (await read<readonly [bigint]>(pool, V3POOL, 'positions', [key]))[0];
    }
    return sum;
  };

  // A price window covered 31 minutes back, as a keeper that has run for a while holds.
  const windows = new PriceWindow();
  const warmWindow = async (routerAddr: Address) => {
    const s = await readRouter(pub, routerAddr);
    const pool = s.isV4 ? routerAddr : s.v3Pool;
    windows.add(pool, s.sqrtPriceX96, Date.now() - 31 * 60_000);
    windows.add(pool, s.sqrtPriceX96, Date.now() - 60_000);
    return pool;
  };
  const keeperRoute = async (routerAddr: Address, pool: string) => {
    const s = await readRouter(pub, routerAddr);
    const d = await decide(pub, s, { quoters, minRouteWei: parseEther('0.001'), slippageBps: 100, maxDeviationBps: 300, reference: windows.average(pool) });
    if (!d.route) throw new Error(`keeper declined: ${d.reason}`);
    return write(keeper, routerAddr, ROUTER, 'route', [d.minRate, await deadline()]);
  };

  // ================================================================ v4 ETH ==
  section('v4, native ETH pool, full range');
  const key: PoolKey = { currency0: ZERO, currency1: tkn, fee: 3000, tickSpacing: 60, hooks: ZERO };
  await write(deployer, pm, PM, 'initialize', [key, getSqrtRatioAtTick(69_060)]); // 1 ETH = 1,000 TKN
  await write(trader, modify, MODIFY, 'modifyLiquidity', [key, { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 3n * 10n ** 20n, salt: `0x${'0'.repeat(64)}` }, '0x'], parseEther('20'));

  check((await revertName(team, factory, FACTORY, 'createV4', [key, tkn, 60, false])) === 'BadCadence', 'a cadence under an hour is refused');
  check(
    (await revertName(team, factory, FACTORY, 'createV4', [{ ...key, fee: 500, tickSpacing: 10 }, tkn, 86_400, false])) === 'BadPool',
    'a pool that was never initialised is refused',
  );
  const { result: r1addr } = await pub.simulateContract({ account: team, address: factory, abi: FACTORY, functionName: 'createV4', args: [key, tkn, 86_400, false] } as never) as { result: Address };
  await write(team, factory, FACTORY, 'createV4', [key, tkn, 86_400, false]);
  const r1 = r1addr;
  check((await read<Address>(r1, ROUTER, 'team')).toLowerCase() === team.toLowerCase(), `router ${r1} belongs to the team that created it`);
  check(((await read<Address[]>(factory, FACTORY, 'routersForToken', [tkn])) as Address[]).length === 1, 'the factory lists it under the token');

  // creator fees arrive
  await pay(trader, r1, parseEther('1'));
  const [planFee, planSwap] = await read<readonly [bigint, bigint]>(r1, ROUTER, 'plan');
  check(planFee === parseEther('0.01'), `plan: the LockFi fee is exactly 1% of the new ETH (${planFee})`);
  check(planSwap > parseEther('0.45') && planSwap < parseEther('0.495'), `plan: a little under half the rest is swapped, for the swap's own price impact (${planSwap})`);

  check((await revertName(stranger, r1, ROUTER, 'route', [0n, await deadline()])) === 'NotAuthorized', 'a stranger cannot route');
  const pool1 = await warmWindow(r1);
  const poolLiqBefore = await v4PoolLiquidity(key);
  const treasuryBefore = await pub.getBalance({ address: treasury });
  const rc1 = await keeperRoute(r1, pool1);
  const ev1 = routed(rc1);
  const treasuryGot = (await pub.getBalance({ address: treasury })) - treasuryBefore;
  check(treasuryGot === parseEther('0.01'), `the treasury received exactly 1%: ${treasuryGot}`);
  check(ev1.liquidity > 0n && ev1.quoteAdded > 0n && ev1.tokenAdded > 0n, `liquidity ${ev1.liquidity} added: ${ev1.quoteAdded} wei and ${ev1.tokenAdded} TKN`);
  check((await v4PoolLiquidity(key)) - poolLiqBefore === ev1.liquidity, "the pool's active liquidity rose by exactly the routed liquidity");
  const locked1 = await lockedV4(key, r1);
  check(locked1 === ev1.liquidity, 'the router owns exactly that liquidity, at the pool itself');
  check(ev1.tickLower === -887_220 && ev1.tickUpper === 887_220, 'full range: the lowest to the highest usable tick');
  const left = await read<bigint>(r1, ROUTER, 'quoteBalance');
  check(left < parseEther('0.001'), `almost nothing left waiting: ${left} wei of ETH`);
  const leftTkn = await balanceOf(tkn, r1);
  check(leftTkn * 100n < ev1.tokenAdded, `and ${leftTkn} of TKN, under 1% of the ${ev1.tokenAdded} added`);
  check((await pub.getBalance({ address: keeper })) > 0n && ev1.feePaid === parseEther('0.01'), 'the keeper paid gas and received nothing');

  check((await revertName(keeper, r1, ROUTER, 'route', [0n, await deadline()])) === 'NotDue', 'the keeper cannot route again before the cadence');
  check((await revertName(team, r1, ROUTER, 'route', [0n, (await chainNow()) - 1n])) === 'Expired', 'a route past its deadline is refused');

  section('v4: a manipulated price is refused, twice over');
  await pay(trader, r1, parseEther('0.5'));
  check((await revertName(team, r1, ROUTER, 'route', [10n ** 40n, await deadline()])) === 'Slippage', 'a minimum above what the pool gives reverts the whole route');
  // someone pushes the token's price up just before a route
  await write(trader, swap4, SWAP4, 'swap', [key, { zeroForOne: true, amountSpecified: -parseEther('3'), sqrtPriceLimitX96: MIN_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x'], parseEther('3'));
  await warp(86_400);
  const pushed = await readRouter(pub, r1);
  const dPushed = await decide(pub, pushed, { quoters, minRouteWei: parseEther('0.001'), slippageBps: 100, maxDeviationBps: 300, reference: windows.average(pool1) });
  check(!dPushed.route && dPushed.reason.includes('bps from its 30-minute average'), `the keeper waits it out: ${dPushed.reason}`);
  // …and the price comes back
  await write(trader, swap4, SWAP4, 'swap', [key, { zeroForOne: false, amountSpecified: -parseEther('2850'), sqrtPriceLimitX96: MAX_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x']);
  await write(trader, swap4, SWAP4, 'swap', [key, { zeroForOne: true, amountSpecified: -parseEther('0.2'), sqrtPriceLimitX96: MIN_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x'], parseEther('0.2'));

  section('v4: the second route compounds the fees the first one earned');
  const t2 = await pub.getBalance({ address: treasury });
  const rc2 = await keeperRoute(r1, pool1);
  const ev2 = routed(rc2);
  const got2 = (await pub.getBalance({ address: treasury })) - t2;
  check(got2 === parseEther('0.005'), `1% of the 0.5 ETH that arrived, and nothing on the earned fees: ${got2}`);
  const locked2 = await lockedV4(key, r1);
  check(locked2 === locked1 + ev2.liquidity && ev2.liquidity > 0n, `liquidity only went up: ${locked1} → ${locked2}`);

  section('v4: collect() cannot be used to dodge the LockFi fee');
  await pay(trader, r1, parseEther('0.3'));
  await write(trader, swap4, SWAP4, 'swap', [key, { zeroForOne: true, amountSpecified: -parseEther('0.4'), sqrtPriceLimitX96: MIN_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x'], parseEther('0.4'));
  await write(trader, swap4, SWAP4, 'swap', [key, { zeroForOne: false, amountSpecified: -parseEther('390'), sqrtPriceLimitX96: MAX_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x']);
  await write(stranger, r1, ROUTER, 'collect', [0n, 10n]);
  check((await lockedV4(key, r1)) === locked2, 'a stranger’s collect moved fees in and left the liquidity where it was');
  await warp(86_400);
  await warmWindow(r1);
  const t3 = await pub.getBalance({ address: treasury });
  await keeperRoute(r1, pool1);
  const got3 = (await pub.getBalance({ address: treasury })) - t3;
  check(got3 === parseEther('0.003'), `the fee on the 0.3 ETH was still paid: ${got3}`);
  const locked3 = await lockedV4(key, r1);
  check(locked3 > locked2, `liquidity only went up: ${locked2} → ${locked3}`);

  section('v4: pausing releases only what has not been routed');
  await pay(trader, r1, parseEther('0.2'));
  check((await revertName(team, r1, ROUTER, 'withdrawUnrouted', [team])) === 'NotPaused', 'nothing can be withdrawn while live');
  check((await revertName(stranger, r1, ROUTER, 'setPaused', [true])) === 'NotAuthorized', 'only the team pauses');
  await write(team, r1, ROUTER, 'setPaused', [true]);
  await warp(86_400);
  check((await revertName(keeper, r1, ROUTER, 'route', [0n, await deadline()])) === 'IsPaused', 'a paused router is not routed');
  const teamBefore = await pub.getBalance({ address: team });
  const wr = await write(team, r1, ROUTER, 'withdrawUnrouted', [team]);
  const teamGot = (await pub.getBalance({ address: team })) - teamBefore + wr.gasUsed * wr.effectiveGasPrice;
  check(teamGot >= parseEther('0.2'), `the team got its unrouted ETH back: ${teamGot}`);
  check((await lockedV4(key, r1)) === locked3, 'the routed liquidity did not move');
  check((await read<bigint>(r1, ROUTER, 'quoteBalance')) === 0n, 'the router holds no ETH');
  await write(team, r1, ROUTER, 'setPaused', [false]);

  section('nothing in the router can take liquidity out');
  const fns = (ROUTER as { type: string; name?: string; stateMutability?: string }[])
    .filter((x) => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure')
    .map((x) => x.name)
    .sort();
  check(
    JSON.stringify(fns) === JSON.stringify(['collect', 'route', 'setPaused', 'setTeam', 'uniswapV3MintCallback', 'uniswapV3SwapCallback', 'unlockCallback', 'withdrawUnrouted']),
    `the only state-changing calls: ${fns.join(', ')}`,
  );
  check((await revertName(stranger, r1, ROUTER, 'unlockCallback', ['0x'])) === 'BadCallback', "a callback from anyone but the pool is refused");
  check((await revertName(stranger, r1, ROUTER, 'uniswapV3MintCallback', [1n, 1n, '0x'])) === 'BadCallback', 'so is a mint callback');

  // ======================================================= v4 WETH narrow ==
  section('v4, WETH-quoted pool, ±20% around the price');
  const [c0, c1] = weth.toLowerCase() < tkn.toLowerCase() ? [weth, tkn] : [tkn, weth];
  const tokenFirst = c0 === tkn;
  const wkey: PoolKey = { currency0: c0, currency1: c1, fee: 500, tickSpacing: 10, hooks: ZERO };
  await write(deployer, pm, PM, 'initialize', [wkey, getSqrtRatioAtTick(tokenFirst ? -69_060 : 69_060)]);
  await write(trader, modify, MODIFY, 'modifyLiquidity', [wkey, { tickLower: -887_270, tickUpper: 887_270, liquidityDelta: 3n * 10n ** 20n, salt: `0x${'0'.repeat(64)}` }, '0x']);
  const { result: r2 } = await pub.simulateContract({ account: team, address: factory, abi: FACTORY, functionName: 'createV4', args: [wkey, tkn, 3_600, true] } as never) as { result: Address };
  await write(team, factory, FACTORY, 'createV4', [wkey, tkn, 3_600, true]);
  await pay(trader, r2, parseEther('1'));
  const pool2 = await warmWindow(r2);
  const t4 = await pub.getBalance({ address: treasury });
  const ev4 = routed(await keeperRoute(r2, pool2));
  check((await pub.getBalance({ address: treasury })) - t4 === parseEther('0.01'), 'the fee is paid in ETH before the rest is wrapped');
  const tickNow = (await readRouter(pub, r2)).sqrtPriceX96;
  check(ev4.liquidity > 0n && ev4.quoteAdded > 0n && ev4.tokenAdded > 0n, `liquidity ${ev4.liquidity} added into the WETH pool`);
  const width = ev4.tickUpper - ev4.tickLower;
  check(width >= 4050 && width <= 4080, `the range is about ±20% wide: ${ev4.tickLower} … ${ev4.tickUpper} (${width} ticks)`);
  check(tickNow > 0n && (await lockedV4(wkey, r2)) === ev4.liquidity, 'the router owns exactly the routed liquidity');

  // ============================================================== v3 WETH ==
  section('v3 pool against WETH, ±20% around the price');
  await write(deployer, v3f, V3F, 'createPool', [tkn, weth, 3000]);
  const pool3 = await read<Address>(v3f, V3F, 'getPool', [tkn, weth, 3000]);
  await write(deployer, pool3, V3POOL, 'initialize', [getSqrtRatioAtTick(tokenFirst ? -69_060 : 69_060)]);
  const big = parseEther('50000');
  await write(trader, npm, NPM, 'mint', [{
    token0: c0, token1: c1, fee: 3000, tickLower: -887_220, tickUpper: 887_220,
    amount0Desired: tokenFirst ? big : parseEther('50'), amount1Desired: tokenFirst ? parseEther('50') : big,
    amount0Min: 0n, amount1Min: 0n, recipient: trader, deadline: await deadline(),
  }]);
  check((await revertName(team, factory, FACTORY, 'createV3', [tkn, 86_400, true])) !== null, 'a contract that is not a v3 factory pool is refused');
  const { result: r3 } = await pub.simulateContract({ account: team, address: factory, abi: FACTORY, functionName: 'createV3', args: [pool3, 86_400, true] } as never) as { result: Address };
  await write(team, factory, FACTORY, 'createV3', [pool3, 86_400, true]);
  await pay(trader, r3, parseEther('1'));
  const w3 = await warmWindow(r3);
  const t5 = await pub.getBalance({ address: treasury });
  const liq3Before = await read<bigint>(pool3, V3POOL, 'liquidity');
  const ev5 = routed(await keeperRoute(r3, w3));
  check((await pub.getBalance({ address: treasury })) - t5 === parseEther('0.01'), 'the treasury received exactly 1%');
  check((await read<bigint>(pool3, V3POOL, 'liquidity')) - liq3Before === ev5.liquidity, "the pool's active liquidity rose by exactly the routed liquidity");
  const l3a = await lockedV3(pool3, r3);
  check(l3a === ev5.liquidity && l3a > 0n, `the router owns ${l3a} at the pool`);
  check((await balanceOf(weth, r3)) + (await pub.getBalance({ address: r3 })) < parseEther('0.02'), 'little ETH is left waiting');

  // trading earns the router fees; a day later the next route compounds them
  for (const [tokenIn, tokenOut, amountIn] of [[weth, tkn, parseEther('2')], [tkn, weth, parseEther('1900')], [weth, tkn, parseEther('0.5')]] as [Address, Address, bigint][]) {
    await write(trader, swapRouter, SWAP3, 'exactInputSingle', [{ tokenIn, tokenOut, fee: 3000, recipient: trader, deadline: await deadline(), amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }]);
  }
  await pay(trader, r3, parseEther('0.5'));
  await warp(86_400);
  await warmWindow(r3);
  const ev6 = routed(await keeperRoute(r3, w3));
  const l3b = await lockedV3(pool3, r3);
  check(l3b === l3a + ev6.liquidity && ev6.liquidity > 0n, `liquidity only went up: ${l3a} → ${l3b}`);
  await write(team, r3, ROUTER, 'setPaused', [true]);
  await write(team, r3, ROUTER, 'withdrawUnrouted', [team]);
  check((await lockedV3(pool3, r3)) === l3b, 'pausing and withdrawing left the routed v3 liquidity where it was');

  // ============================================================= factory ==
  section('the factory: a fee that cannot be raised, an owner who cannot reach funds');
  let tooHigh = false;
  try {
    await deploy({ abi: FACTORY, bytecode: factoryBytecode.bytecode as Hex }, [pm, weth, v3f, 300, treasury, keeper]);
  } catch {
    tooHigh = true;
  }
  check(tooHigh, 'a factory with a fee above the 2% cap cannot be deployed');
  check((await read<number>(factory, FACTORY, 'feeBps')) === 100, 'this factory takes 1%');
  const owned = (FACTORY as { type: string; name?: string; stateMutability?: string }[])
    .filter((x) => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure')
    .map((x) => x.name)
    .sort();
  check(JSON.stringify(owned) === JSON.stringify(['createV3', 'createV4', 'setKeeper', 'setOwner', 'setTreasury']), `its only state-changing calls: ${owned.join(', ')}`);
  check((await revertName(stranger, factory, FACTORY, 'setKeeper', [stranger])) === 'NotOwner', 'only the owner names the keeper');

  // ======================================================= token lookups ==
  section('the router page finds a creator’s tokens, and their pools, from the chain');
  // A launchpad in miniature: the token is created by the launchpad's contract,
  // inside a transaction the creator's wallet sends — the shape of a Pons launch.
  const LAUNCHPAD_SRC = `pragma solidity 0.8.26;
contract Tok { string public name; string public symbol; uint8 public constant decimals = 18; uint256 public totalSupply;
  mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value); event Approval(address indexed o, address indexed s, uint256 v);
  constructor(string memory n, string memory s, address to, uint256 amt) { name = n; symbol = s; totalSupply = amt; balanceOf[to] = amt; emit Transfer(address(0), to, amt); }
  function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true; }
  function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp] = v; emit Approval(msg.sender, sp, v); return true; }
  function transferFrom(address f, address to, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true; } }
contract Launchpad { function launch(string calldata n, string calldata s) external returns (address t) { t = address(new Tok(n, s, msg.sender, 1e24)); }
  function launchCurve(string calldata n, string calldata s) external returns (address t) { t = address(new Tok(n, s, address(this), 1e24)); } }`;
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'L.sol': { content: LAUNCHPAD_SRC } },
    settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const lp = compiled.contracts['L.sol'].Launchpad;
  const launchpad = await deploy({ abi: lp.abi, bytecode: `0x${lp.evm.bytecode.object}` as Hex });
  const { result: launched } = (await pub.simulateContract({ account: team, address: launchpad, abi: lp.abi, functionName: 'launch', args: ['Dev Coin', 'DEV'] } as never)) as { result: Address };
  const launchRc = await write(team, launchpad, lp.abi as Abi, 'launch', ['Dev Coin', 'DEV']);
  // and a launch whose whole supply stays on the launchpad's curve, as Pons
  // does without a dev buy: the creator never holds a single token
  const { result: curveToken } = (await pub.simulateContract({ account: team, address: launchpad, abi: lp.abi, functionName: 'launchCurve', args: ['Curve Coin', 'CRV2'] } as never)) as { result: Address };
  const curveRc = await write(team, launchpad, lp.abi as Abi, 'launchCurve', ['Curve Coin', 'CRV2']);

  // The explorer's part, stood in for: which transaction created which contract.
  const creation = new Map<string, Hex>([
    [launched.toLowerCase(), launchRc.transactionHash],
    [curveToken.toLowerCase(), curveRc.transactionHash],
    [tkn.toLowerCase(), deployedIn.get(tkn.toLowerCase())!],
  ]);
  // a non-standard v4 pool the guesses cannot find, listed by an "aggregator"
  const oddKey: PoolKey = { currency0: ZERO, currency1: tkn, fee: 2500, tickSpacing: 50, hooks: ZERO };
  const oddInit = await write(deployer, pm, PM, 'initialize', [oddKey, getSqrtRatioAtTick(69_050)]);
  const oddId = v4PoolId(oddKey);
  const lookups = new RouterTokens({
    read: ((fn) => fn(pub as never)) as ChainRead,
    creationTx: async (t) => creation.get(t) ?? null,
    walletTokens: async () => [launched, tkn],
    v4PoolIds: async (t) => (t === tkn.toLowerCase() ? [{ id: oddId, liquidityUsd: 1234 }] : []),
    initializeTx: async (id) => (id === oddId ? oddInit.transactionHash : null),
    knownPools: async () => [],
    contracts: { poolManager: pm, v3Factory: v3f, weth },
  });

  const devCreator = await lookups.creatorOf(launched);
  check(devCreator?.address === team.toLowerCase(), `a launchpad token's creator is the wallet that launched it, ${devCreator?.address}`);
  check(devCreator?.via === launchpad.toLowerCase(), 'and it is recorded as created through the launchpad');
  const tknCreator = await lookups.creatorOf(tkn);
  check(tknCreator?.address === deployer.toLowerCase() && tknCreator.via === null, 'a token deployed directly: its deployer, with no launchpad');
  creation.set(stranger.toLowerCase(), launchRc.transactionHash);
  check((await lookups.creatorOf(stranger)) === null, 'a transaction that never touched the address proves nothing, and names no creator');
  const mine = await lookups.createdBy(team);
  check(mine.length === 1 && mine[0].address === launched.toLowerCase() && mine[0].symbol === 'DEV', `the team's own tokens: ${mine.map((t) => t.symbol).join(', ')}`);
  check((await lookups.createdBy(stranger)).length === 0, 'a wallet that created nothing has no tokens');

  // Found from the wallet's own transactions, with nothing held: the explorer
  // lists what the wallet sent, and the receipts say what each one minted.
  const approveRc = await write(team, weth, ERC20, 'approve', [launchpad, 1n]);
  const bySent = new RouterTokens({
    read: ((fn) => fn(pub as never)) as ChainRead,
    creationTx: async (t) => creation.get(t) ?? null,
    walletTokens: async () => [],
    walletSent: async (w) =>
      w === team.toLowerCase()
        ? [
            { hash: curveRc.transactionHash, created: null, toContract: true },
            { hash: launchRc.transactionHash, created: null, toContract: true },
            // an ordinary call that minted nothing new: an approval
            { hash: approveRc.transactionHash, created: null, toContract: true },
          ]
        : w === deployer.toLowerCase()
          ? [{ hash: deployedIn.get(tkn.toLowerCase())!, created: tkn.toLowerCase(), toContract: false }]
          : [],
    v4PoolIds: async () => [],
    initializeTx: async () => null,
    knownPools: async () => [],
    contracts: { poolManager: pm, v3Factory: v3f, weth },
  });
  const fromSent = (await bySent.createdBy(team)).map((t) => t.symbol).sort();
  check(JSON.stringify(fromSent) === JSON.stringify(['CRV2', 'DEV']), `from the wallet's own launches, held or not: ${fromSent.join(', ')}`);
  const deployed = await bySent.createdBy(deployer);
  check(deployed.some((t) => t.address === tkn.toLowerCase()), 'and a token the wallet deployed directly');
  check((await bySent.createdBy(stranger)).length === 0, 'a stranger sent nothing, and is credited with nothing');

  const pools = await lookups.poolsFor(tkn);
  const describe = (p: { protocol: string; key: { fee: number; tickSpacing: number }; quote: string }) => `${p.protocol} ${p.quote} ${p.key.fee}/${p.key.tickSpacing}`;
  const names = pools.map(describe);
  check(names.includes('v4 ETH 3000/60'), 'the v4 ETH pool is found by its standard key');
  check(names.includes('v4 WETH 500/10'), 'the v4 WETH pool too');
  check(names.includes('v3 WETH 3000/60'), 'the v3 pool through the factory');
  check(names.includes('v4 ETH 2500/50') && pools.find((p) => p.id === oddId)?.liquidityUsd === 1234, 'a non-standard pool, its key recovered from its own Initialize log and checked against its id');
  check(!names.includes('v4 ETH 500/10') && !names.includes('v3 WETH 500/10'), 'no pool that does not exist on chain');
  check(pools.every((p) => BigInt(p.liquidity) >= 0n), `${pools.length} pools, each read from the chain: ${names.join(' · ')}`);

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
