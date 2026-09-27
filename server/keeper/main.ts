/**
 * The LockFi Router keeper: every minute it samples each router's pool price,
 * and when a router is due it routes it, with the guards in ./plan.ts.
 *
 * It can only trigger. A route sends nothing to the keeper: the LockFi fee
 * goes to the treasury the factory names, and everything else goes into the
 * pool. The keeper's wallet needs a little ETH for gas and nothing more.
 *
 * Anyone can create a router, so anyone can put a router in front of the
 * keeper, including one built to waste its gas. So the keeper:
 *   - routes only when the LockFi fee the route pays covers its gas
 *     (KEEPER_FEE_OVER_GAS times over), so a router that is not worth routing
 *     costs nothing;
 *   - refuses a route that estimates above KEEPER_MAX_GAS, and caps the
 *     transaction's gas at it;
 *   - backs a router off, doubling from five minutes to a day, after any
 *     failure: a simulation that reverts, a transaction that reverts, a read
 *     that fails;
 *   - never sends a second route while the first is still pending;
 *   - stops sending for the day once KEEPER_DAILY_GAS_ETH is spent.
 *
 * Configuration, in /var/www/balast/.env (deploy/set-env.sh):
 *   KEEPER_PRIVATE_KEY        the keeper wallet's key; the factory must name its address
 *   KEEPER_MIN_ROUTE_ETH      skip a route with less new ETH than this (default 0.002)
 *   KEEPER_SLIPPAGE_BPS       the minimum rate sits this far under the band's edge (default 100)
 *   KEEPER_MAX_DEVIATION_BPS  the band: this far either side of the 30-minute average (default 300, at most 480)
 *   KEEPER_MAX_GAS            the most gas one route may use (default 1500000)
 *   KEEPER_FEE_OVER_GAS       the fee must cover the gas this many times (default 1)
 *   KEEPER_DAILY_GAS_ETH      the most ETH the keeper spends on gas in a day (default 0.05)
 *   KEEPER_INTERVAL_MS        how often it looks (default 60000)
 *
 * A missing or malformed setting is said once, and the keeper waits: a
 * setting is not a crash to restart in a loop, and a malformed guard must
 * never quietly become no guard.
 */

import '../load-env';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, ROUTER_FACTORY, ROUTER_FEE_BPS } from '../../lib/chain';
import { robinhoodChain } from '../../lib/v4/client';
import { RPC_URLS, rpcStartIndex } from '../chain/endpoints';
import { FACTORY_ABI, MAX_KEEPER_BAND_BPS, PriceWindow, ROUTER_ABI, decide, readRouter } from '../../lib/router/plan';

const log = (msg: string) => console.log(`[keeper] ${msg}`);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const idle = async (why: string): Promise<never> => {
  log(why);
  for (;;) await sleep(10 * 60_000);
};

export interface KeeperSettings {
  intervalMs: number;
  minRouteWei: bigint;
  slippageBps: number;
  maxDeviationBps: number;
  maxGas: bigint;
  feeOverGas: number;
  dailyGasWei: bigint;
}

/** Every setting, checked; a list of what is wrong instead of a quietly weaker keeper. */
export function readSettings(env: Record<string, string | undefined>): { settings: KeeperSettings; errors: string[] } {
  const errors: string[] = [];
  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      errors.push(`${name}=${JSON.stringify(raw)} must be a whole number from ${min} to ${max}`);
      return def;
    }
    return Number(raw);
  };
  const eth = (name: string, def: string, max: string): bigint => {
    const raw = env[name]?.trim() || def;
    try {
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error();
      const v = parseEther(raw);
      if (v <= 0n || v > parseEther(max)) throw new Error();
      return v;
    } catch {
      errors.push(`${name}=${JSON.stringify(raw)} must be an amount of ETH above 0 and at most ${max}`);
      return parseEther(def);
    }
  };
  return {
    settings: {
      intervalMs: int('KEEPER_INTERVAL_MS', 60_000, 10_000, 3_600_000),
      minRouteWei: eth('KEEPER_MIN_ROUTE_ETH', '0.002', '100'),
      slippageBps: int('KEEPER_SLIPPAGE_BPS', 100, 1, 1_000),
      maxDeviationBps: int('KEEPER_MAX_DEVIATION_BPS', 300, 10, MAX_KEEPER_BAND_BPS),
      maxGas: BigInt(int('KEEPER_MAX_GAS', 1_500_000, 200_000, 10_000_000)),
      feeOverGas: int('KEEPER_FEE_OVER_GAS', 1, 0, 100),
      dailyGasWei: eth('KEEPER_DAILY_GAS_ETH', '0.05', '10'),
    },
    errors,
  };
}

/** A router that failed waits: 5 minutes, doubling, at most a day. */
export class Backoff {
  private state = new Map<string, { until: number; n: number }>();
  failed(key: string, now = Date.now()): number {
    const n = (this.state.get(key)?.n ?? 0) + 1;
    const wait = Math.min(5 * 60_000 * 2 ** (n - 1), 24 * 3_600_000);
    this.state.set(key, { until: now + wait, n });
    return wait;
  }
  ok(key: string): void {
    this.state.delete(key);
  }
  waiting(key: string, now = Date.now()): boolean {
    return (this.state.get(key)?.until ?? 0) > now;
  }
}

function transport() {
  const start = rpcStartIndex(RPC_URLS.length);
  const urls = [...RPC_URLS.slice(start), ...RPC_URLS.slice(0, start)];
  return fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { rank: false });
}

async function allRouters(client: PublicClient, factory: Address): Promise<Address[]> {
  const out: Address[] = [];
  for (let start = 0n; ; start += 200n) {
    const page = (await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'routersPage', args: [start, 200n] })) as Address[];
    out.push(...page);
    if (page.length < 200) return out;
  }
}

async function main(): Promise<void> {
  const factory = ROUTER_FACTORY;
  const key = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!factory) await idle('not configured: the router factory is not deployed yet (ROUTER_FACTORY in lib/chain.ts). Waiting.');
  if (!key) await idle('not configured: KEEPER_PRIVATE_KEY is not set. Waiting.');
  const { settings: S, errors } = readSettings(process.env);
  if (errors.length) await idle(`not started, a setting is malformed:\n  ${errors.join('\n  ')}\nFix it with deploy/set-env.sh and restart.`);
  const hexKey = (key!.startsWith('0x') ? key! : `0x${key}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hexKey)) await idle('not started: KEEPER_PRIVATE_KEY is not a 32-byte hex key.');
  const account = privateKeyToAccount(hexKey);
  const client = createPublicClient({ chain: robinhoodChain, transport: transport() }) as PublicClient;
  const wallet = createWalletClient({ chain: robinhoodChain, account, transport: transport() });
  const quoters = { v4Quoter: CONTRACTS.v4Quoter as Address, quoterV2: CONTRACTS.v3QuoterV2 as Address };
  const windows = new PriceWindow();
  const backoff = new Backoff();
  const pending = new Map<string, Hex>();

  // the factory is what the code says it is, or nothing is sent
  const feeBps = Number(await client.readContract({ address: factory!, abi: FACTORY_ABI, functionName: 'feeBps' }));
  if (feeBps !== ROUTER_FEE_BPS) await idle(`not started: the factory at ${factory} takes ${feeBps} bps, not the ${ROUTER_FEE_BPS} this site says.`);
  const treasury = (await client.readContract({ address: factory!, abi: FACTORY_ABI, functionName: 'treasury' })) as Address;
  log(
    `keeper ${account.address}, factory ${factory}, treasury ${treasury}; min ${formatEther(S.minRouteWei)} ETH, ` +
      `slippage ${S.slippageBps} bps, band ±${S.maxDeviationBps} bps, max gas ${S.maxGas}, gas budget ${formatEther(S.dailyGasWei)} ETH a day`,
  );

  let warnedAt = 0;
  let day = new Date().toISOString().slice(0, 10);
  let spentToday = 0n;
  const said = new Map<string, string>();
  const say = (router: string, msg: string) => {
    if (said.get(router) !== msg) log(`${router}: ${msg}`);
    said.set(router, msg);
  };

  for (;;) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== day) [day, spentToday] = [today, 0n];
      const named = (await client.readContract({ address: factory!, abi: FACTORY_ABI, functionName: 'keeper' })) as Address;
      const isKeeper = named.toLowerCase() === account.address.toLowerCase();
      const gas = await client.getBalance({ address: account.address });
      if (Date.now() - warnedAt > 3_600_000) {
        if (!isKeeper) log(`the factory names ${named} as keeper, not this wallet: nothing is sent until it does`);
        else if (gas < parseEther('0.001')) log(`low on gas: ${formatEther(gas)} ETH. Top up ${account.address}.`);
        if (!isKeeper || gas < parseEther('0.001')) warnedAt = Date.now();
      }
      const routers = await allRouters(client, factory!);

      // Read every router and sample every price first, so a slow router
      // never delays the samples the others' averages depend on.
      const states = await Promise.all(
        routers.map(async (router) => {
          if (backoff.waiting(router)) return null;
          try {
            const s = await Promise.race([
              readRouter(client, router),
              sleep(20_000).then(() => {
                throw new Error('read timed out');
              }),
            ]);
            windows.add(s.isV4 ? JSON.stringify(s.key) : s.v3Pool, s.sqrtPriceX96);
            return s;
          } catch (e) {
            const wait = backoff.failed(router);
            say(router, `unreadable (${(e as Error).message.split('\n')[0]}); next try in ${Math.round(wait / 60_000)} min`);
            return null;
          }
        }),
      );

      for (const s of states) {
        if (!s) continue;
        const router = s.address;
        // a route already sent: wait for it rather than send another
        const inFlight = pending.get(router);
        if (inFlight) {
          const receipt = await client.getTransactionReceipt({ hash: inFlight }).catch(() => null);
          if (!receipt) continue;
          pending.delete(router);
          spentToday += receipt.gasUsed * receipt.effectiveGasPrice;
          if (receipt.status === 'success') {
            backoff.ok(router);
            say(router, `routed in ${inFlight}`);
          } else {
            const wait = backoff.failed(router);
            say(router, `route ${inFlight} reverted on chain; next try in ${Math.round(wait / 60_000)} min`);
          }
          continue;
        }
        if (!isKeeper) continue;
        try {
          const d = await decide(client, s, {
            quoters,
            minRouteWei: S.minRouteWei,
            slippageBps: S.slippageBps,
            maxDeviationBps: S.maxDeviationBps,
            reference: windows.average(s.isV4 ? JSON.stringify(s.key) : s.v3Pool),
          });
          if (!d.route) {
            if (!d.reason.startsWith('not due')) say(router, `waiting (${d.reason})`);
            continue;
          }
          const args = [d.minRate, d.lo, d.hi, BigInt(Math.floor(Date.now() / 1000) + 300)] as const;
          const { request } = await client.simulateContract({ account, address: router, abi: ROUTER_ABI, functionName: 'route', args });
          const estimate = await client.estimateContractGas({ account, address: router, abi: ROUTER_ABI, functionName: 'route', args });
          if (estimate > S.maxGas) {
            const wait = backoff.failed(router);
            say(router, `a route would use ${estimate} gas, over the ${S.maxGas} cap; next try in ${Math.round(wait / 60_000)} min`);
            continue;
          }
          const gasPrice = await client.getGasPrice();
          const cost = (estimate * 12n * gasPrice) / 10n;
          if (s.fee < cost * BigInt(S.feeOverGas)) {
            say(router, `waiting (the ${formatEther(s.fee)} ETH fee does not cover ~${formatEther(cost)} ETH of gas)`);
            continue;
          }
          if (spentToday + cost > S.dailyGasWei) {
            say(router, `waiting (today's gas budget of ${formatEther(S.dailyGasWei)} ETH is spent)`);
            continue;
          }
          const hash = await wallet.writeContract({ ...request, gas: (estimate * 13n) / 10n < S.maxGas ? (estimate * 13n) / 10n : S.maxGas });
          pending.set(router, hash);
          say(router, `sent route (${d.reason}) in ${hash}`);
        } catch (e) {
          const wait = backoff.failed(router);
          say(router, `${(e as Error).message.split('\n')[0]}; next try in ${Math.round(wait / 60_000)} min`);
        }
      }
    } catch (e) {
      log(`pass failed: ${(e as Error).message.split('\n')[0]}`);
    }
    await sleep(S.intervalMs);
  }
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(`[keeper] ${(e as Error).message.split('\n')[0]}`);
    process.exit(1);
  });
}
