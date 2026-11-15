/**
 * The keeper, as /api/health reports it (§8, P3: "a keeper that dies
 * silently is a vault paying zero while displaying a yield").
 *
 * Vaults need no keeper. They credit fees per share whenever anyone deposits,
 * withdraws, claims or pokes, so a dead keeper cannot leave one paying zero —
 * the P3 failure cannot happen to a vault, and nothing here pretends to watch
 * for it. The section says so, and counts the vaults.
 *
 * Routers do need one: only the keeper may poke a router's own TWAP and
 * trigger its routes. Read from what the chain recorded — each router's last
 * Observed event, as indexed — not from the keeper process: a keeper that is
 * up, logging and landing nothing looks fine to PM2 and stale here, which is
 * the point. keeper_runs supplies the WHY: the reason the last attempt gave.
 *
 * Nothing to keep is "not needed yet", never a failure. Four diagnostics in
 * this repository have invented failures (§17, §19); this one does not.
 */

import type { Deployment } from '../../lib/contracts/deployments';
import { prisma } from '../db';
import { contractsConfig } from '../indexer/contracts-config';
import { contractCursorKey, routersFromFactory } from '../indexer/contracts';
import { duration, POKE_INTERVAL_SECONDS, ROUTER_TWAP_WINDOW_SECONDS } from './config';

/** A router not observed for this long cannot route until 30 minutes of pokes rebuild its TWAP. */
export const OBSERVATION_STALE_SECONDS = 2 * ROUTER_TWAP_WINDOW_SECONDS;

/** Said wherever vaults come up: they are not the keeper's concern. */
export const VAULTS_NEED_NO_KEEPER =
  'Vaults need no keeper: fees are credited to stakers whenever anyone deposits, withdraws, claims or pokes, and are claimable at once.';

export interface LastRun {
  kind: string;
  status: string;
  reason: string | null;
  at: string;
  txHash: string | null;
}

export interface RouterKeeperHealth {
  address: string;
  token: string;
  poolId: string;
  /** not-indexed | paused | ok | stale */
  state: string;
  lastRouteAt: string | null;
  lastObservationAt: string | null;
  observationAgeSeconds: number | null;
  lastRun: LastRun | null;
}

export interface KeeperHealth {
  status: 'not-needed' | 'ok' | 'unknown' | 'overdue';
  message: string;
  /** Deployed vaults. Counted, not checked: they need no keeper. */
  vaultCount: number;
  vaultsNote: string;
  pokeIntervalSeconds: number;
  observationStaleAfterSeconds: number;
  routers: RouterKeeperHealth[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const secs = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : null);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function keeperHealth(options: { deployment: Deployment | null }): Promise<KeeperHealth> {
  const config = contractsConfig(options.deployment);
  const base = {
    vaultCount: config.vaults.length,
    vaultsNote: VAULTS_NEED_NO_KEEPER,
    pokeIntervalSeconds: POKE_INTERVAL_SECONDS,
    observationStaleAfterSeconds: OBSERVATION_STALE_SECONDS,
  };

  if (options.deployment?.routerFactory && !config.routerFactory) {
    // A factory that cannot be read is not "nothing deployed".
    return {
      ...base,
      status: 'unknown',
      message:
        'config/deployments.json names a router factory but no block to start reading it from ' +
        '(routerFactoryDeployedBlock), so its routers are not followed and whether any need keeping is not known.',
      routers: [],
    };
  }

  const routers = await routersFromFactory(config.routerFactory?.address ?? null);
  if (routers.length === 0) {
    return {
      ...base,
      status: 'not-needed',
      message:
        `The keeper is not needed yet: ${config.routerFactory ? 'the router factory has created no router' : 'no router factory is deployed'}. ` +
        VAULTS_NEED_NO_KEEPER,
      routers: [],
    };
  }

  const addresses = routers.map((r) => r.address);
  const [cursors, runs, routerEvents] = await Promise.all([
    prisma.indexerCursor.findMany({ where: { contract: { in: addresses.map(contractCursorKey) } } }),
    prisma.$queryRaw<{ contract: string; kind: string; status: string; reason: string | null; started_at: Date; tx_hash: string | null }[]>`
      SELECT DISTINCT ON (contract) contract, kind, status, reason, started_at, tx_hash
      FROM keeper_runs
      WHERE contract = ANY(${addresses})
      ORDER BY contract, started_at DESC
    `,
    prisma.$queryRaw<{ contract: string; kind: string; block_time: Date; args: Record<string, unknown> }[]>`
      SELECT DISTINCT ON (contract, kind) contract, kind, block_time, args
      FROM contract_events
      WHERE contract = ANY(${addresses}) AND kind IN ('Routed', 'Observed', 'Paused')
      ORDER BY contract, kind, block_num DESC, log_index DESC
    `,
  ]);
  const asOf = new Map(cursors.map((c) => [c.contract, c.lastIndexedAt]));
  const lastRun = new Map<string, LastRun>(
    runs.map((r) => [r.contract, { kind: r.kind, status: r.status, reason: r.reason, at: r.started_at.toISOString(), txHash: r.tx_hash }]),
  );
  const eventOf = (contract: string, kind: string) => routerEvents.find((e) => e.contract === contract && e.kind === kind);

  const list: RouterKeeperHealth[] = routers.map((router) => {
    const at = secs(asOf.get(contractCursorKey(router.address)));
    const observed = eventOf(router.address, 'Observed');
    const routed = eventOf(router.address, 'Routed');
    const pausedEvent = eventOf(router.address, 'Paused');
    const paused = pausedEvent ? pausedEvent.args.paused === true : false;
    // The constructor records the first observation without an event, at
    // creation; until the first poke that is the newest one.
    const lastObservation = observed ? Number(observed.args.timestamp) : secs(router.createdAt);
    const age = at !== null && lastObservation !== null ? Math.max(0, at - lastObservation) : null;
    return {
      address: router.address,
      token: router.token,
      poolId: router.poolId,
      state: at === null ? 'not-indexed' : paused ? 'paused' : age !== null && age > OBSERVATION_STALE_SECONDS ? 'stale' : 'ok',
      lastRouteAt: iso(routed?.block_time),
      lastObservationAt: lastObservation !== null ? new Date(lastObservation * 1000).toISOString() : null,
      observationAgeSeconds: at === null ? null : age,
      lastRun: lastRun.get(router.address) ?? null,
    };
  });

  const stale = list.find((r) => r.state === 'stale');
  const unknown = list.find((r) => r.state === 'not-indexed');
  const why = (run: LastRun | null) =>
    run ? ` The keeper's last attempt (${run.kind}, ${run.at}) was ${run.status}${run.reason ? `: ${run.reason}` : ''}.` : ' The keeper has recorded no attempt for it.';

  if (stale) {
    return {
      ...base,
      status: 'overdue',
      message:
        `Router ${short(stale.address)} has not been observed for ${duration(stale.observationAgeSeconds ?? 0)}, so its ` +
        `30-minute TWAP is unavailable and it cannot route the token team's fees.${why(stale.lastRun)} ` +
        'See: runuser -u balast -- pm2 logs balast-keeper',
      routers: list,
    };
  }
  if (unknown) {
    return {
      ...base,
      status: 'unknown',
      message: `Router ${unknown.address} has not been read by the indexer yet, so whether it is being kept is not known.`,
      routers: list,
    };
  }
  return {
    ...base,
    status: 'ok',
    message: `${list.length} router(s) observed on schedule. ${VAULTS_NEED_NO_KEEPER}`,
    routers: list,
  };
}
