/**
 * The keeper as /api/health reports it.
 *
 * Vaults need no keeper, and health says so instead of watching them for a
 * harvest that no longer exists. With no router it is "not needed yet" and
 * changes nothing about the health status — four diagnostics in this
 * repository invented failures (§17, §19), and this one must not be the
 * fifth. A router left unobserved for an hour makes /api/health answer 503
 * keeper-overdue and says why, from the last recorded attempt.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type { Deployment } from '../../lib/contracts/deployments';

const USDG_ADDRESS = '0x00000000000000000000000000000000000000d6';
const H = 3600;
const VAULT = '0x000000000000000000000000000000000000a017';
const FACTORY = '0x000000000000000000000000000000000000fac7';
const ROUTER = '0x000000000000000000000000000000000000b0b0';
const POOL_HEX = `0x${'a1'.padStart(64, '0')}`;
const POOL_ID = `v4:${POOL_HEX}`;

const nothing: Deployment = { network: 'Robinhood Chain', audited: false, zap: null, shaper: null, routerFactory: null, vaults: [] };
const vaultsOnly: Deployment = { ...nothing, vaults: [{ address: VAULT, poolId: POOL_ID, deployedBlock: 1 }] };
const withFactory: Deployment = { ...vaultsOnly, routerFactory: FACTORY, routerFactoryDeployedBlock: 1 };
const factoryNoBlock: Deployment = { ...nothing, routerFactory: FACTORY, routerFactoryDeployedBlock: null };

// Dynamic imports: server.ts and env.ts read process.env at import, so the
// variables below must be set first (the same reason as server.test.ts).
let prisma: import('@prisma/client').PrismaClient;
let keeperHealth: typeof import('./health').keeperHealth;
let contractCursorKey: typeof import('../indexer/contracts').contractCursorKey;
let POOL_MANAGER_CURSOR: string;

beforeAll(async () => {
  process.env.USDG_ADDRESS = USDG_ADDRESS;
  process.env.LOG_LEVEL = 'silent';
  ({ prisma } = await import('../db'));
  ({ keeperHealth } = await import('./health'));
  ({ contractCursorKey } = await import('../indexer/contracts'));
  ({ POOL_MANAGER_CURSOR } = await import('../indexer/poller'));
  const { isReachable } = await import('../test/db');
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A fresh indexer cursor, so the indexer itself reads as healthy. */
async function seed() {
  const { resetDatabase } = await import('../test/db');
  await resetDatabase();
  await prisma.indexerCursor.create({
    data: { contract: POOL_MANAGER_CURSOR, lastIndexedBlock: 100n, lastIndexedAt: new Date(), updatedAt: new Date() },
  });
}

let logIndex = 0;
function ev(contract: string, source: string, kind: string, args: Record<string, unknown>, blockTime: Date) {
  logIndex++;
  return prisma.contractEvent.create({
    data: {
      txHash: `0x${String(logIndex).padStart(64, '0')}`, logIndex, contract, source, blockNum: 10n + BigInt(logIndex),
      blockTime, kind, account: null, args: args as Prisma.InputJsonValue,
    },
  });
}

/** A router the factory created two days ago, last observed `observedBefore` seconds ago. */
async function router(observedBefore: number | null) {
  await ev(FACTORY, 'router-factory', 'RouterCreated', { router: ROUTER, token: '0x0000000000000000000000000000000000000001', owner: FACTORY, poolId: POOL_HEX }, new Date(Date.now() - 2 * 86_400_000));
  if (observedBefore !== null) {
    const at = Math.floor(Date.now() / 1000) - observedBefore;
    await ev(ROUTER, 'router', 'Observed', { timestamp: at, tick: -100 }, new Date(at * 1000));
  }
  await prisma.indexerCursor.create({
    data: { contract: contractCursorKey(ROUTER), lastIndexedBlock: 100n, lastIndexedAt: new Date(), updatedAt: new Date() },
  });
}

describe('keeperHealth', () => {
  beforeEach(seed);

  it('is "not needed yet" with nothing deployed', async () => {
    const health = await keeperHealth({ deployment: nothing });
    expect(health.status).toBe('not-needed');
    expect(health.message).toMatch(/not needed yet/);
    expect(health.routers).toEqual([]);
    expect((await keeperHealth({ deployment: null })).status).toBe('not-needed');
  });

  it('counts vaults and says they need no keeper — it does not check them', async () => {
    const health = await keeperHealth({ deployment: vaultsOnly });
    expect(health.status).toBe('not-needed');
    expect(health.vaultCount).toBe(1);
    expect(health.vaultsNote).toMatch(/Vaults need no keeper/);
    expect(health.message).toMatch(/Vaults need no keeper/);
  });

  it('is "not needed yet" with a factory that has created no router', async () => {
    const health = await keeperHealth({ deployment: withFactory });
    expect(health.status).toBe('not-needed');
    expect(health.message).toMatch(/created no router/);
  });

  it('is unknown, not "nothing deployed", for a factory it cannot read', async () => {
    const health = await keeperHealth({ deployment: factoryNoBlock });
    expect(health.status).toBe('unknown');
    expect(health.message).toMatch(/routerFactoryDeployedBlock/);
  });

  it('is ok for a router observed four minutes ago', async () => {
    await router(240);
    const health = await keeperHealth({ deployment: withFactory });
    expect(health.status).toBe('ok');
    expect(health.routers[0].state).toBe('ok');
    expect(health.routers[0].observationAgeSeconds).toBeGreaterThanOrEqual(240);
  });

  it('is overdue for a router unobserved for over an hour, and says why from the last attempt', async () => {
    await router(2 * H);
    await prisma.keeperRun.create({
      data: {
        contract: ROUTER, kind: 'poke', startedAt: new Date(), finishedAt: new Date(), status: 'skipped',
        reason: 'KEEPER_PRIVATE_KEY is not set, so the keeper cannot sign',
      },
    });
    const health = await keeperHealth({ deployment: withFactory });
    expect(health.status).toBe('overdue');
    expect(health.routers[0].state).toBe('stale');
    expect(health.message).toMatch(/cannot route/);
    expect(health.message).toMatch(/KEEPER_PRIVATE_KEY is not set/);
    expect(health.routers[0].lastRun?.status).toBe('skipped');
  });

  it('measures a router never poked from its creation, when the constructor recorded its first observation', async () => {
    await router(null);
    const health = await keeperHealth({ deployment: withFactory });
    expect(health.routers[0].state).toBe('stale');
    expect(health.routers[0].observationAgeSeconds).toBeGreaterThan(47 * H);
  });

  it('never calls a paused router stale', async () => {
    await router(2 * H);
    await ev(ROUTER, 'router', 'Paused', { paused: true }, new Date());
    const health = await keeperHealth({ deployment: withFactory });
    expect(health.routers[0].state).toBe('paused');
    expect(health.status).toBe('ok');
  });

  it('is unknown, not failing, for a router the indexer has not read yet', async () => {
    await ev(FACTORY, 'router-factory', 'RouterCreated', { router: ROUTER, token: '0x0000000000000000000000000000000000000001', owner: FACTORY, poolId: POOL_HEX }, new Date());
    const health = await keeperHealth({ deployment: withFactory });
    expect(health.status).toBe('unknown');
    expect(health.routers[0].state).toBe('not-indexed');
  });
});

describe('/api/health with the keeper', () => {
  let app: FastifyInstance | null = null;
  async function server(deployment: Deployment) {
    await app?.close();
    const { buildServer } = await import('../api/server');
    app = await buildServer({ deployment });
    await app.ready();
    // The server warms its snapshot in the background on start; wait for that
    // build so it does not outlive the test's database connection.
    await app.inject({ method: 'GET', url: '/api/snapshot' });
    return app;
  }
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(seed);

  it('with vaults and no router: the status is untouched, and vaults need no keeper', async () => {
    const response = await (await server(vaultsOnly)).inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.keeper.status).toBe('not-needed');
    expect(body.keeper.vaultCount).toBe(1);
    expect(body.keeper.vaultsNote).toMatch(/need no keeper/);
  });

  it('answers 503 keeper-overdue for a router unobserved for over an hour', async () => {
    await router(2 * H);
    const response = await (await server(withFactory)).inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('keeper-overdue');
    expect(body.message).toBe(body.keeper.message);
    expect(body.keeper.routers[0].state).toBe('stale');
  });

  it('lets a stalled indexer outrank it: when the indexer stops, it is what to fix first', async () => {
    await router(2 * H);
    await prisma.indexerCursor.update({
      where: { contract: POOL_MANAGER_CURSOR },
      data: { updatedAt: new Date(Date.now() - 2 * H * 1000) },
    });
    const body = (await (await server(withFactory)).inject({ method: 'GET', url: '/api/health' })).json();
    expect(body.status).toBe('stalled');
    expect(body.keeper.status).toBe('overdue');
  });
});
