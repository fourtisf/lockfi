// Share cards (§32) for real stakers, worked out against the chain: finds the
// wallets that deposited into a deployed vault and prints each card, with the
// wallet shortened. Prices from a snapshot file (curl …/api/snapshot > snap.json).
//   DATABASE_URL=… npx tsx scripts/check-share.mts snap.json
import { readFileSync } from 'node:fs';
import { parseAbiItem } from 'viem';
import { rpc } from '../server/chain/client';
import { walletShare } from '../server/api/share';
import { deploymentFor } from '../lib/contracts/deployments';

const snap = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const dep = deploymentFor(4663)!;
const DEP = parseAbiItem('event Deposited(address indexed sender, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1)');
const v = dep.vaults.find((x) => x.address.toLowerCase().startsWith('0x901d'))!;
const head = await rpc((c) => c.getBlockNumber());
const logs = [];
for (let from = BigInt(v.deployedBlock); from <= head; from += 2_000_000n) {
  const to = from + 1_999_999n < head ? from + 1_999_999n : head;
  logs.push(...(await rpc((c) => c.getLogs({ address: v.address as `0x${string}`, event: DEP, fromBlock: from, toBlock: to }))));
}
const wallets = [...new Set(logs.map((l) => (l.args.recipient as string).toLowerCase()))];
console.log('deposits', logs.length, 'distinct wallets', wallets.length);
for (const w of wallets.slice(0, 3)) {
  const t = Date.now();
  const card = await walletShare(w, dep.vaults, snap);
  console.log(JSON.stringify({ ...card, wallet: card.wallet.slice(0, 6) + '…' }, null, 0), `${Date.now() - t}ms`);
}
