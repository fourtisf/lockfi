// Fund the test wallet on the fork: ETH by anvil_setBalance, USDG moved from a
// real holder (impersonated). Prints the fork block.
import { createPublicClient, createWalletClient, http, parseEther, erc20Abi } from 'viem';
const RPC = 'http://127.0.0.1:8545';
const ME = process.argv[2];
const HOLDER = '0x6f52a1decc650b28435ddc9793dc85f869061065';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const pub = createPublicClient({ transport: http(RPC) });
const call = (method, params) => pub.request({ method, params });
await call('anvil_setBalance', [ME, `0x${parseEther('5').toString(16)}`]);
await call('anvil_setBalance', [HOLDER, `0x${parseEther('1').toString(16)}`]);
await call('anvil_impersonateAccount', [HOLDER]);
const w = createWalletClient({ account: HOLDER, transport: http(RPC), chain: { id: 4663, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } });
const hash = await w.writeContract({ address: USDG, abi: erc20Abi, functionName: 'transfer', args: [ME, 300_000_000n] });
await pub.waitForTransactionReceipt({ hash });
console.log('block', await pub.getBlockNumber(), 'ETH', Number(await pub.getBalance({ address: ME })) / 1e18, 'USDG', Number(await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [ME] })) / 1e6);
