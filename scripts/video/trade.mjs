// On the fork: a trader swaps ETH <-> USDG through the real UniversalRouter in
// the ETH/USDG 0.05% pool, round trips, until VOLUME_USD of volume has gone
// through. Plain swaps, so nothing is added to the vault and the stake is not
// diluted. Usage: node trade.mjs <volumeUsd> <ethPerSwap>
import { createPublicClient, createWalletClient, http, parseEther, erc20Abi, encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, concatHex, toHex } from 'viem';
const RPC = 'http://127.0.0.1:8545';
const VOLUME_USD = Number(process.argv[2] ?? 2_500_000);
const ETH_PER_SWAP = Number(process.argv[3] ?? 5);
const TRADER = '0x6f52a1decc650b28435ddc9793dc85f869061065';
const UR = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const V05 = '0x901deabd094bd204cbe02854b1924e5ab4c41597';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ transport: http(RPC) });
const wal = createWalletClient({ account: TRADER, transport: http(RPC), chain });

const keyAbi = parseAbi(['function poolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)']);
const [c0, c1, fee, tickSpacing, hooks] = await pub.readContract({ address: V05, abi: keyAbi, functionName: 'poolKey' });
const key = { currency0: c0, currency1: c1, fee, tickSpacing, hooks };
console.log('pool key', key);

const keyType = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
// The struct changed between periphery versions; the deployed router decides.
const LAYOUTS = {
  classic: { type: 'tuple', components: [keyType, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] },
  hopPrice: { type: 'tuple', components: [keyType, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] },
};
const urAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
function swapCall(layout, zeroForOne, amountIn) {
  const p = layout === 'classic' ? [key, zeroForOne, amountIn, 0n, '0x'] : [key, zeroForOne, amountIn, 0n, 0n, '0x'];
  const inCur = zeroForOne ? c0 : c1;
  const outCur = zeroForOne ? c1 : c0;
  const actions = concatHex([toHex(0x06, { size: 1 }), toHex(0x0c, { size: 1 }), toHex(0x0f, { size: 1 })]);
  const params = [
    encodeAbiParameters([LAYOUTS[layout]], [p]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [inCur, amountIn]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [outCur, 0n]),
  ];
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
  return { to: UR, data: encodeFunctionData({ abi: urAbi, functionName: 'execute', args: ['0x10', [input], BigInt(Math.floor(Date.now() / 1000) + 3600)] }), value: inCur === zeroAddress ? amountIn : 0n };
}

await pub.request({ method: 'anvil_setBalance', params: [TRADER, `0x${parseEther('100000').toString(16)}`] });
await pub.request({ method: 'anvil_impersonateAccount', params: [TRADER] });
// Permit2: USDG -> Permit2 -> router.
const p2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: USDG, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, 2n ** 255n] }) });
await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: PERMIT2, abi: p2Abi, functionName: 'approve', args: [USDG, UR, 2n ** 159n, 2 ** 47] }) });

const amountIn = parseEther(String(ETH_PER_SWAP));
let layout = null;
for (const l of Object.keys(LAYOUTS)) {
  try { await pub.call({ account: TRADER, ...swapCall(l, true, amountIn) }); layout = l; break; } catch (e) { console.log(`layout ${l} refused: ${(e.shortMessage ?? e.message).split('\n')[0]}`); }
}
if (!layout) throw new Error('no swap layout accepted by the router');
console.log('router accepts layout', layout);

const usdg = () => pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [TRADER] });
let volume = 0;
let swaps = 0;
const ethUsd = Number(process.argv[4] ?? 1808);
while (volume < VOLUME_USD) {
  const before = await usdg();
  const h1 = await wal.sendTransaction(swapCall(layout, true, amountIn));
  await pub.waitForTransactionReceipt({ hash: h1 });
  const got = (await usdg()) - before;
  const h2 = await wal.sendTransaction(swapCall(layout, false, got));
  const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
  if (r2.status !== 'success') throw new Error('swap back failed');
  swaps += 2;
  volume += ETH_PER_SWAP * ethUsd + Number(got) / 1e6;
  if (swaps % 40 === 0) console.log(`${swaps} swaps, ~$${Math.round(volume).toLocaleString('en-US')} volume`);
}
console.log(`done: ${swaps} swaps, ~$${Math.round(volume).toLocaleString('en-US')} volume`);
