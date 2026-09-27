/**
 * The LockFi Router keeper: every minute it samples each router's pool price,
 * and when a router is due it routes it, with the guards in ./plan.ts.
 *
 * It can only trigger. A route sends nothing to the keeper: the LockFi fee
 * goes to the treasury the factory names, and everything else goes into the
 * pool. The keeper's wallet needs a little ETH for gas and nothing more.
 *
 * Configuration, in /var/www/balast/.env (deploy/set-env.sh):
 *   KEEPER_PRIVATE_KEY        the keeper wallet's key; the factory must name its address
 *   KEEPER_MIN_ROUTE_ETH      skip a route with less new ETH than this (default 0.002)
 *   KEEPER_SLIPPAGE_BPS       the minimum sent is this far under the quote (default 100)
 *   KEEPER_MAX_DEVIATION_BPS  skip while the price is this far from its 30-minute average (default 300)
 *
 * Without a key or a factory it says what is missing, once, and waits: a
 * missing setting is not a crash to restart in a loop.
 */

import '../load-env';
import { createPublicClient, createWalletClient, fallback, formatEther, http, parseEther, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, ROUTER_FACTORY } from '../../lib/chain';
import { robinhoodChain } from '../../lib/v4/client';
import { RPC_URLS, rpcStartIndex } from '../chain/endpoints';
import { FACTORY_ABI, PriceWindow, ROUTER_ABI, decide, readRouter } from '../../lib/router/plan';

const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 60_000);
const MIN_ROUTE_WEI = parseEther(process.env.KEEPER_MIN_ROUTE_ETH ?? '0.002');
const SLIPPAGE_BPS = Number(process.env.KEEPER_SLIPPAGE_BPS ?? 100);
const MAX_DEVIATION_BPS = Number(process.env.KEEPER_MAX_DEVIATION_BPS ?? 300);
const LOW_GAS_WEI = parseEther('0.001');

const log = (msg: string) => console.log(`[keeper] ${msg}`);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function transport() {
  const start = rpcStartIndex(RPC_URLS.length);
  const urls = [...RPC_URLS.slice(start), ...RPC_URLS.slice(0, start)];
  return fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { rank: false });
}

async function main(): Promise<void> {
  const factory = ROUTER_FACTORY;
  const key = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!factory || !key) {
    log(
      !factory
        ? 'not configured: the router factory is not deployed yet (ROUTER_FACTORY in lib/chain.ts). Waiting.'
        : 'not configured: KEEPER_PRIVATE_KEY is not set. Waiting.',
    );
    for (;;) await sleep(10 * 60_000);
  }
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  const client = createPublicClient({ chain: robinhoodChain, transport: transport() }) as PublicClient;
  const wallet = createWalletClient({ chain: robinhoodChain, account, transport: transport() });
  const quoters = { v4Quoter: CONTRACTS.v4Quoter as Address, quoterV2: CONTRACTS.v3QuoterV2 as Address };
  const windows = new PriceWindow();
  log(`keeper ${account.address}, factory ${factory}; min ${formatEther(MIN_ROUTE_WEI)} ETH, slippage ${SLIPPAGE_BPS} bps, max deviation ${MAX_DEVIATION_BPS} bps`);

  let warnedAt = 0;
  const last = new Map<string, string>();
  for (;;) {
    try {
      const named = (await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'keeper' })) as Address;
      const gas = await client.getBalance({ address: account.address });
      if (Date.now() - warnedAt > 3_600_000) {
        if (named.toLowerCase() !== account.address.toLowerCase()) {
          log(`the factory names ${named} as keeper, not this wallet: routes will be refused until the owner calls setKeeper`);
          warnedAt = Date.now();
        } else if (gas < LOW_GAS_WEI) {
          log(`low on gas: ${formatEther(gas)} ETH. Top up ${account.address}.`);
          warnedAt = Date.now();
        }
      }
      const routers = (await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'routers' })) as Address[];
      for (const router of routers) {
        try {
          const s = await readRouter(client, router);
          const pool = s.isV4 ? JSON.stringify(s.key) : s.v3Pool;
          windows.add(pool, s.sqrtPriceX96);
          const d = await decide(client, s, {
            quoters,
            minRouteWei: MIN_ROUTE_WEI,
            slippageBps: SLIPPAGE_BPS,
            maxDeviationBps: MAX_DEVIATION_BPS,
            reference: windows.average(pool),
          });
          if (!d.route) {
            // say why once per change, not every minute
            if (last.get(router) !== d.reason && !d.reason.startsWith('not due')) log(`${router}: waiting (${d.reason})`);
            last.set(router, d.reason);
            continue;
          }
          const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
          const { request } = await client.simulateContract({
            account,
            address: router,
            abi: ROUTER_ABI,
            functionName: 'route',
            args: [d.minRate, deadline],
          });
          const hash = await wallet.writeContract(request);
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
          log(`${router}: routed (${d.reason}) in ${hash}: ${receipt.status}`);
          last.delete(router);
        } catch (e) {
          log(`${router}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    } catch (e) {
      log(`pass failed: ${(e as Error).message.split('\n')[0]}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
