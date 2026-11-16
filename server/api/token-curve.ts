/**
 * The token's launchpad curve, read from the chain (§30). The indexer reads
 * Uniswap pools, and a token on Pons's bonding curve has none until it
 * graduates, so the API reads the curve itself: its Buy and Sell events since
 * launch, held in memory and topped up on each read, and its reserves now.
 *
 * Every read replays the trades and compares the result with the curve's own
 * getReserves(). If they ever disagree (an event this code does not know),
 * the price still comes from the reserves, and the change and the chart —
 * the parts that need the past — are left out rather than guessed.
 */

import { getAddress, parseAbi } from 'viem';
import { TOKEN_CA, TOKEN_LAUNCH } from '../../lib/site';
import { decodeCurveTrade, summariseCurve, type CurveTrade, type TokenLive } from '../../lib/token-curve';
import { rpc } from '../chain/client';

const CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function getReserves() view returns (uint256, uint256)',
  'function graduated() view returns (bool)',
]);

const REFRESH_MS = 15_000;
const LOG_CHUNK = 2_000_000n;

export function createTokenCurveReader(log: (msg: string) => void = console.log) {
  if (!TOKEN_CA || !TOKEN_LAUNCH) return null;
  const token = getAddress(TOKEN_CA);
  const cfg = TOKEN_LAUNCH;
  const curve = getAddress(cfg.curve);
  const initial = { eth: BigInt(cfg.virtualEthWei), tokens: BigInt(cfg.supply) * 10n ** 18n };
  const meta = { address: token, symbol: cfg.symbol, launchpad: cfg.launchpad, buyUrl: cfg.url, curve, supply: cfg.supply };

  let checked = false;
  let launchedAt: number | null = null;
  let next = BigInt(cfg.launchBlock);
  const trades: CurveTrade[] = [];
  const seen = new Set<string>();
  let last: { at: number; value: TokenLive } | null = null;
  let inflight: Promise<TokenLive | null> | null = null;

  async function refresh(ethUsd: number | null): Promise<TokenLive | null> {
    if (!checked) {
      const t = await rpc((c) => c.readContract({ address: curve, abi: CURVE_ABI, functionName: 'token' }), 'curve.token');
      if (getAddress(t) !== token) throw new Error(`curve ${curve} trades ${t}, not ${token}; check TOKEN_LAUNCH`);
      const b = await rpc((c) => c.getBlock({ blockNumber: BigInt(cfg.launchBlock) }), 'getBlock(launch)');
      launchedAt = Number(b.timestamp) * 1000;
      checked = true;
    }
    const head = await rpc((c) => c.getBlockNumber(), 'getBlockNumber');
    for (let from = next; from <= head; from += LOG_CHUNK) {
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await rpc((c) => c.getLogs({ address: curve, fromBlock: from, toBlock: to }), 'curve logs');
      const blocks = [...new Set(logs.map((l) => l.blockNumber))];
      const times = new Map<bigint, number>();
      if (blocks.length > 0) {
        const got = await rpc((c) => Promise.all(blocks.map((n) => c.getBlock({ blockNumber: n }))), 'curve block times');
        for (const b of got) times.set(b.number, Number(b.timestamp) * 1000);
      }
      for (const l of logs) {
        const key = `${l.blockNumber}:${l.logIndex}`;
        if (seen.has(key)) continue;
        const t = decodeCurveTrade(l, times.get(l.blockNumber) ?? Date.now());
        if (!t) continue;
        seen.add(key);
        trades.push(t);
      }
      next = to + 1n;
    }
    trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    // The reserves at the same block the logs were read to, so the replay and
    // the curve describe one moment.
    const [reserves, graduated, balance, headBlock] = await rpc(
      (c) =>
        Promise.all([
          c.readContract({ address: curve, abi: CURVE_ABI, functionName: 'getReserves', blockNumber: head }),
          c.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduated', blockNumber: head }),
          c.getBalance({ address: curve, blockNumber: head }),
          c.getBlock({ blockNumber: head }),
        ]),
      'curve state',
    );
    const value = summariseCurve({
      meta,
      initial,
      trades,
      reserves: { eth: reserves[0], tokens: reserves[1] },
      ethInCurveWei: balance,
      graduated,
      launchedAt: launchedAt ?? Number(headBlock.timestamp) * 1000,
      now: Number(headBlock.timestamp) * 1000,
      ethUsd,
    });
    if (!value.verified && !graduated) log(`token curve: the replay of ${trades.length} trades does not match getReserves; change and chart withheld`);
    return value;
  }

  return {
    /** The latest read, at most REFRESH_MS old; the last good one if a read fails. */
    async get(ethUsd: number | null): Promise<TokenLive | null> {
      if (last && Date.now() - last.at < REFRESH_MS) return last.value;
      inflight ??= refresh(ethUsd)
        .then((value) => {
          if (value) last = { at: Date.now(), value };
          return value;
        })
        .catch((error) => {
          log(`token curve: ${(error as Error).message.split('\n')[0]}`);
          return last?.value ?? null;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
