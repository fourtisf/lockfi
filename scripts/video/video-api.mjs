// Stand-in API for the recording: a real snapshot saved from tidewell.live
// (vault figures read live from the chain by the watcher), ages kept current,
// and /api/wallet/:address answered from the FORK's own vault logs in the
// shape server/api/wallet-history.ts serves.
//   node video-api.mjs <snapshot.json> <fork block>
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http as vhttp, parseAbiItem } from 'viem';
const SNAP = process.argv[2];
const FORK_FROM = BigInt(process.argv[3] ?? '0');
const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
const deploymentsFile = fileURLToPath(new URL('../../config/deployments.json', import.meta.url));
const deployments = JSON.parse(fs.readFileSync(deploymentsFile, 'utf8'))['4663'].vaults;
const fork = createPublicClient({ transport: vhttp('http://127.0.0.1:8545') });
const EV = {
  Deposited: parseAbiItem('event Deposited(address indexed sender, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1)'),
  Withdrawn: parseAbiItem('event Withdrawn(address indexed account, address indexed recipient, uint256 liquidity, uint256 amount0, uint256 amount1)'),
  Claimed: parseAbiItem('event Claimed(address indexed account, address indexed recipient, uint256 amount0, uint256 amount1)'),
};
async function history(wallet) {
  const vaults = [];
  const events = [];
  for (const d of deployments) {
    const t = { d0: 0n, d1: 0n, w0: 0n, w1: 0n, c0: 0n, c1: 0n, first: null };
    for (const [kind, event] of Object.entries(EV)) {
      const args = kind === 'Deposited' ? { recipient: wallet } : { account: wallet };
      const logs = await fork.getLogs({ address: d.address, event, args, fromBlock: FORK_FROM, toBlock: 'latest' });
      for (const l of logs) {
        const b = await fork.getBlock({ blockNumber: l.blockNumber });
        const at = new Date(Number(b.timestamp) * 1000).toISOString();
        if (kind === 'Deposited') { t.d0 += l.args.amount0; t.d1 += l.args.amount1; t.first ??= at; }
        else if (kind === 'Withdrawn') { t.w0 += l.args.amount0; t.w1 += l.args.amount1; }
        else { t.c0 += l.args.amount0; t.c1 += l.args.amount1; }
        events.push({ vault: d.address, poolId: d.poolId.toLowerCase(), kind, at, txHash: l.transactionHash, amount0: String(l.args.amount0), amount1: String(l.args.amount1), _n: Number(l.blockNumber) * 1e4 + l.logIndex });
      }
    }
    if (t.first || t.c0 || t.c1 || t.w0 || t.w1) vaults.push({ vault: d.address, poolId: d.poolId.toLowerCase(), deposited0: String(t.d0), deposited1: String(t.d1), withdrawn0: String(t.w0), withdrawn1: String(t.w1), claimed0: String(t.c0), claimed1: String(t.c1), firstDepositAt: t.first });
  }
  events.sort((a, b) => b._n - a._n).forEach((e) => delete e._n);
  return { wallet: wallet.toLowerCase(), vaults, events, asOf: new Date().toISOString() };
}
let rev = 7000;
http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  try {
    if (req.url.startsWith('/api/snapshot')) {
      const s = JSON.parse(JSON.stringify(snap));
      for (const v of s.vaults) if (v.live) v.live.asOf = new Date(Date.now() - 25_000).toISOString();
      s.revision = ++rev;
      return send(200, s);
    }
    if (req.url.startsWith('/api/health')) return send(200, { ok: true, status: 'catching-up' });
    if (req.url.startsWith('/api/wallet/')) return send(200, await history(req.url.split('/').pop()));
    send(404, { error: 'not-found' });
  } catch (e) { send(500, { error: String(e).slice(0, 300) }); }
}).listen(3901, () => console.log('video api on 3901'));
