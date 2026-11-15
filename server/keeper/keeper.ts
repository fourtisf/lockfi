/**
 * The keeper (§8 P3, P4): it drives TidewellRouter contracts, and nothing else.
 *
 * Vaults need no keeper. They credit fees per share whenever anyone deposits,
 * withdraws, claims or pokes, and pay them in the pool's own tokens: nothing
 * accrues that a keeper must harvest, sell or stream, so nothing stops paying
 * when a keeper stops.
 *
 * Routers do need one. Each records its own 30-minute TWAP from observations
 * only its keeper may add, and routes only when its keeper calls route():
 *
 *   poke   when the router's newest on-chain observation is four minutes old,
 *          so the TWAP always has the six samples a route needs
 *   route  when the router's own due() says so and it is not paused
 *
 * Every decision is read from the chain each pass — the observation's own
 * timestamp, due(), paused(), keeper() — never from memory, so a restart
 * picks up exactly where the chain is.
 *
 * Refusals, each recorded with its reason and never sent:
 *   - no key, or a key that is not the router's keeper()
 *   - a transaction of ours still pending
 *   - a simulation that reverts: caught before sending it costs no gas, and
 *     the decoded reason (TwapUnavailable, TwapDeviation, ...) goes in the run
 */

import { parseEventLogs, type Abi, type Account, type Address, type Hash } from 'viem';
import { tidewellRouterAbi } from '../../lib/contracts/abis';
import type { RouterRef } from '../indexer/contracts';
import type { KeeperClient, ReceiptLike, WriteArgs } from './client';
import { DEADLINE_SECONDS, duration, POKE_INTERVAL_SECONDS, RECEIPT_TIMEOUT_MS } from './config';
import { decodeRevert, errorSummary, revertSentence } from './reverts';
import { recordRun, type RunDetails, type RunKind, type RunRecord, type RunStatus } from './runs';

const ROUTER_ABI = tidewellRouterAbi as unknown as Abi;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface KeeperOptions {
  client: KeeperClient;
  /** What simulations and sends are made as: the local account, or its address in tests. */
  account: Account | Address | null;
  /** Why there is no account, when there is none. Said once, recorded hourly while it lasts. */
  signerProblem: string | null;
  /** The routers the factory announced (indexer/contracts.ts). */
  routers: () => Promise<RouterRef[]>;
  record?: (run: RunRecord) => Promise<void>;
  log?: (message: string) => void;
  /** Wall-clock milliseconds, for retry spacing only — never for a decision. */
  wallNow?: () => number;
  pokeIntervalSeconds?: number;
  receiptTimeoutMs?: number;
}

export interface TickResult {
  /** Attempts recorded this pass. */
  attempts: number;
  /** Transactions sent this pass. */
  sent: number;
}

interface Head {
  number: bigint;
  timestamp: bigint;
}

export class Keeper {
  private readonly client: KeeperClient;
  private readonly account: Account | Address | null;
  private readonly signer: Address | null;
  private readonly record: (run: RunRecord) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly wallNow: () => number;
  private readonly pokeInterval: number;
  private readonly receiptTimeoutMs: number;
  /** Retry spacing per `kind:address`. Memory only delays; it never decides. */
  private readonly backoff = new Map<string, { until: number; failures: number }>();
  private readonly said = new Set<string>();
  private counts: TickResult = { attempts: 0, sent: 0 };

  constructor(private readonly options: KeeperOptions) {
    this.client = options.client;
    this.account = options.account;
    this.signer = options.account
      ? ((typeof options.account === 'string' ? options.account : options.account.address).toLowerCase() as Address)
      : null;
    this.record = options.record ?? recordRun;
    this.log = options.log ?? (() => {});
    this.wallNow = options.wallNow ?? Date.now;
    this.pokeInterval = options.pokeIntervalSeconds ?? POKE_INTERVAL_SECONDS;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  }

  /** One pass over every router. Never throws. */
  async tick(): Promise<TickResult> {
    this.counts = { attempts: 0, sent: 0 };
    let routers: RouterRef[];
    try {
      routers = await this.options.routers();
    } catch (error) {
      this.once('routers', `cannot list routers: ${errorSummary(error)}`);
      return this.counts;
    }
    this.said.delete('routers');
    if (routers.length === 0) return this.counts;

    let head: Head;
    try {
      head = await this.client.getBlock();
    } catch (error) {
      this.once('head', `cannot read the chain's head: ${errorSummary(error)} — trying again next pass`);
      return this.counts;
    }
    this.said.delete('head');

    for (const router of routers) {
      try {
        await this.driveRouter(router, head);
      } catch (error) {
        const key = `route:${router.address}`;
        if (!this.waiting(key)) {
          await this.finish(key, this.base(router.address, 'route'), 'error', `reading the router failed: ${errorSummary(error)}`);
        }
      }
    }
    return this.counts;
  }

  private async driveRouter(router: RouterRef, head: Head): Promise<void> {
    const address = router.address.toLowerCase() as Address;
    const now = Number(head.timestamp);
    const read = (functionName: string, args?: readonly unknown[]) =>
      this.client.readContract({ address, abi: ROUTER_ABI, functionName, args, blockNumber: head.number });
    const [keeper, paused, observationIndex, due] = (await Promise.all([
      read('keeper'),
      read('paused'),
      read('observationIndex'),
      read('due'),
    ])) as [Address, boolean, number, boolean];
    // A paused router routes nothing, so it is not poked: an unpause then
    // waits 30 minutes for a TWAP, which costs nobody anything.
    if (paused) return;

    const [observedAt] = (await read('observations', [BigInt(observationIndex)])) as [number, bigint];
    const age = now - Number(observedAt);
    const needsPoke = age >= this.pokeInterval;
    if (!needsPoke && !due) return;

    // Both poke and route are keeper-only on chain. One refusal for both,
    // recorded once an hour, rather than one per action.
    const refusal = !this.signer
      ? (this.options.signerProblem ?? 'no signing key')
      : keeper.toLowerCase() !== this.signer
        ? `the signer ${this.signer} is not this router's keeper (${keeper.toLowerCase()}) — refusing to poke or route it. ` +
          "Its owner can point keeper() at the signer (setKeeper), or the keeper process needs the keeper's key."
        : null;
    if (refusal) {
      const key = `keep:${address}`;
      if (!this.waiting(key)) {
        await this.refuse(key, this.base(address, due ? 'route' : 'poke'), refusal, { chainNow: now, observationAgeSeconds: age, due });
      }
      return;
    }

    if (needsPoke) await this.poke(address, age, now);
    if (due) await this.route(router, address, now);
  }

  /**
   * Record the router's tick. Calls inside a minute of the last observation
   * are no-ops on chain, and the observation's own timestamp was read first,
   * so no gas goes on one. Successful pokes are logged, not recorded — every
   * four minutes per router would bury the runs that matter, and each is an
   * Observed event the indexer stores anyway. Failures are recorded.
   */
  private async poke(address: Address, age: number, now: number): Promise<void> {
    const key = `poke:${address}`;
    if (this.waiting(key)) return;
    if (await this.pending()) return;
    const details: RunDetails = { chainNow: now, observationAgeSeconds: age };
    const outcome = await this.send(key, this.base(address, 'poke'), details, { address, abi: ROUTER_ABI, functionName: 'poke', args: [] }, () => ({}), {
      recordOk: false,
    });
    if (outcome === 'ok') this.log(`router ${address}: poked (last observation was ${duration(age)} old)`);
  }

  private async route(router: RouterRef, address: Address, now: number): Promise<void> {
    const key = `route:${address}`;
    if (this.waiting(key)) return;
    const base = this.base(address, 'route');
    const details: RunDetails = { chainNow: now, token: router.token };
    if (await this.pending()) {
      return this.finish(key, base, 'skipped', 'a transaction from the keeper is still pending — not sending another on top of it', details, 5 * MINUTE);
    }
    const outcome = await this.send(key, base, details, {
      address,
      abi: ROUTER_ABI,
      functionName: 'route',
      args: [BigInt(now + DEADLINE_SECONDS)],
    }, (receipt) => {
      const logs = parseEventLogs({ abi: ROUTER_ABI, logs: receipt.logs as never }).filter(
        (l) => l.address.toLowerCase() === address,
      ) as unknown as { eventName: string; args: Record<string, bigint | number> }[];
      const routed = logs.find((l) => l.eventName === 'Routed');
      const milestone = logs.find((l) => l.eventName === 'MilestoneFired');
      const out: RunDetails = {};
      if (routed) for (const [k, v] of Object.entries(routed.args)) out[k] = typeof v === 'bigint' ? v.toString() : v;
      if (milestone) out.milestoneIndex = milestone.args.index.toString();
      return out;
    });
    if (outcome === 'ok') this.log(`router ${address}: routed`);
  }

  /**
   * Simulate, send, wait for the receipt, record. A revert in simulation
   * sends nothing and is recorded as skipped with its decoded reason; a
   * transaction mined and reverted is `reverted`.
   */
  private async send(
    key: string,
    base: RunRecord,
    details: RunDetails,
    call: Omit<WriteArgs, 'account'>,
    onReceipt: (receipt: ReceiptLike) => RunDetails,
    options: { recordOk?: boolean } = {},
  ): Promise<RunStatus> {
    let request: unknown;
    try {
      ({ request } = await this.client.simulateContract({ ...call, account: this.account! }));
    } catch (error) {
      const revert = decodeRevert(error);
      if (revert) {
        await this.finish(
          key,
          base,
          'skipped',
          `simulation reverted, nothing sent: ${revertSentence(revert)}`,
          { ...details, revert: revert.name },
          // A TWAP fills as the keeper pokes; asking again in five minutes,
          // not after a growing backoff, is what lets the first route land.
          revert.name === 'TwapUnavailable' ? 5 * MINUTE : undefined,
        );
        return 'skipped';
      }
      await this.finish(key, base, 'error', `simulation failed: ${errorSummary(error)}`, details);
      return 'error';
    }

    let hash: Hash;
    try {
      hash = await this.client.writeContract(request);
    } catch (error) {
      await this.finish(key, base, 'error', `sending failed: ${errorSummary(error)}`, details);
      return 'error';
    }
    this.counts.sent++;

    let receipt: ReceiptLike;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs });
    } catch (error) {
      await this.finish(
        key,
        { ...base, txHash: hash },
        'error',
        `sent ${hash} but saw no receipt within ${Math.round(this.receiptTimeoutMs / 1000)}s (${errorSummary(error)}). ` +
          'The next attempt reads the chain and the pending nonce first, so it is not sent twice.',
        details,
      );
      return 'error';
    }
    if (receipt.status !== 'success') {
      await this.finish(key, { ...base, txHash: hash }, 'reverted', 'mined and reverted on chain — the gas is spent, nothing else moved', details);
      return 'reverted';
    }

    const extra = onReceipt(receipt);
    this.backoff.delete(key);
    this.said.delete(key);
    if (options.recordOk === false) return 'ok';
    await this.write({ ...base, status: 'ok', txHash: hash, details: { ...details, ...extra } });
    return 'ok';
  }

  /** A refusal that will not fix itself: recorded, said once, asked again hourly. */
  private async refuse(key: string, base: RunRecord, reason: string, details: RunDetails): Promise<void> {
    if (!this.said.has(key)) this.log(`router ${base.contract}: ${reason}`);
    this.said.add(key);
    await this.finish(key, base, 'skipped', reason, details, HOUR);
  }

  /** Record a run that did not succeed, and space out the next attempt. */
  private async finish(
    key: string,
    base: RunRecord,
    status: RunStatus,
    reason: string,
    details?: RunDetails,
    retryInMs?: number,
  ): Promise<void> {
    const previous = this.backoff.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const wait = retryInMs ?? Math.min(5 * MINUTE * 2 ** (failures - 1), HOUR);
    this.backoff.set(key, { until: this.wallNow() + wait, failures });
    if (status !== 'skipped' || !this.said.has(key)) this.log(`${base.kind} ${base.contract}: ${status} — ${reason}`);
    await this.write({ ...base, status, reason, details });
  }

  private async write(run: RunRecord): Promise<void> {
    this.counts.attempts++;
    try {
      await this.record(run);
    } catch (error) {
      this.log(`could not record a ${run.kind} run for ${run.contract}: ${errorSummary(error)}`);
    }
  }

  private base(contract: string, kind: RunKind): RunRecord {
    return { contract: contract.toLowerCase(), kind, startedAt: new Date(this.wallNow()), status: 'skipped', signer: this.signer };
  }

  private waiting(key: string): boolean {
    const entry = this.backoff.get(key);
    return entry !== undefined && this.wallNow() < entry.until;
  }

  /** A transaction of ours not yet mined: pending nonce above the latest. */
  private async pending(): Promise<boolean> {
    if (!this.signer) return false;
    const [pendingNonce, latestNonce] = await Promise.all([
      this.client.getTransactionCount({ address: this.signer, blockTag: 'pending' }),
      this.client.getTransactionCount({ address: this.signer, blockTag: 'latest' }),
    ]);
    return pendingNonce > latestNonce;
  }

  private once(key: string, message: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(message);
  }
}
