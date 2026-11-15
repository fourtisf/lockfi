/**
 * deploy/monitor.sh, run for real against a stub /api/health.
 *
 * With nothing deployed, or only vaults (which need no keeper), it must stay
 * quiet — the keeper is "not needed yet", not broken. With a router gone
 * unobserved it alerts once and stays quiet while the state lasts (change of
 * state, not every five minutes), then says when it recovers. And
 * deploy/keeper-report.mjs says the same things in words.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeperReport } from '../../deploy/keeper-report.mjs';

const ROOT = join(__dirname, '..', '..');
let body = '{}';
let code = 200;
let server: Server;
let api = '';
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-'));
  server = createServer((_req, res) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  api = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Async, not spawnSync: the stub server answers from this same event loop. */
function monitor(): Promise<{ exit: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [join(ROOT, 'deploy/monitor.sh')],
      { env: { ...process.env, API: api, LOG: join(dir, 'monitor.log'), STATE: join(dir, 'state'), SKIP_PM2: '1', ALERT_CMD: '' } },
      (error, stdout) => resolve({ exit: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout }),
    );
  });
}

const health = (status: string, keeper: Record<string, unknown>, httpCode = 200) => {
  code = httpCode;
  body = JSON.stringify({ ok: status === 'ok', status, indexed: { lastBlock: '1', lagSeconds: 3.4 }, message: undefined, keeper });
};
const alerts = () => readFileSync(join(dir, 'monitor.log'), 'utf8').split('\n').filter((l) => l.includes(' ALERT '));

describe('deploy/monitor.sh', () => {
  it('stays quiet with vaults and no router deployed: vaults need no keeper', async () => {
    health('ok', { status: 'not-needed', message: 'not needed yet', vaultCount: 2, routers: [] });
    const run = await monitor();
    expect(run.exit).toBe(0);
    expect(run.out).toMatch(/ok — lag 3s; keeper not-needed/);
    expect(run.out).not.toMatch(/ALERT/);
  });

  it('stays quiet through a first sync with nothing deployed', async () => {
    health('catching-up', { status: 'not-needed', message: 'nothing', vaultCount: 0, routers: [] });
    expect((await monitor()).exit).toBe(0);
  });

  it('alerts once when a router goes unobserved, then not again while it lasts, then says it recovered', async () => {
    const message = 'Router 0x0000…b0b0 has not been observed for 2h, so its 30-minute TWAP is unavailable and it cannot route';
    health('keeper-overdue', { status: 'overdue', message, vaultCount: 0, routers: [] }, 503);
    const first = await monitor();
    expect(first.exit).toBe(1);
    expect(first.out).toContain(`ALERT ${message}`);
    const second = await monitor();
    expect(second.exit).toBe(1);
    expect(alerts()).toHaveLength(1);

    health('ok', { status: 'ok', message: '1 router(s) observed on schedule', vaultCount: 0, routers: [] });
    const recovered = await monitor();
    expect(recovered.exit).toBe(0);
    expect(recovered.out).toMatch(/RECOVERED from keeper-overdue/);
  });

  it('reads the top-level status, not a nested one, whatever order the keys come in', async () => {
    // A keeper section ahead of the top-level status, with a status of its own.
    code = 200;
    body = JSON.stringify({ keeper: { status: 'overdue', message: 'x' }, status: 'ok', indexed: { lagSeconds: 1 } });
    expect((await monitor()).exit).toBe(0);
  });
});

describe('deploy/keeper-report.mjs', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');

  it('says vaults need no keeper, and "not needed yet" with no router', () => {
    const lines = keeperReport({ status: 'not-needed', vaultCount: 2, routers: [] }, now).join('\n');
    expect(lines).toMatch(/2 deployed — vaults need no keeper/);
    expect(lines).toMatch(/not needed yet: no router is deployed/);
  });

  it('names a stale router, how long unobserved, and why', () => {
    const lines = keeperReport(
      {
        status: 'overdue',
        vaultCount: 0,
        routers: [
          {
            address: '0x000000000000000000000000000000000000b0b0',
            state: 'stale',
            observationAgeSeconds: 2 * 3600,
            lastRouteAt: '2026-11-14T12:00:00Z',
            lastRun: { kind: 'poke', status: 'skipped', reason: 'KEEPER_PRIVATE_KEY is not set' },
          },
          { address: '0x000000000000000000000000000000000000c0c0', state: 'ok', observationAgeSeconds: 120, lastRouteAt: null, lastRun: null },
        ],
      },
      now,
    ).join('\n');
    expect(lines).toMatch(/router 0x0000…b0b0 {2}STALE: observed 2 hours ago, so it has no TWAP and cannot route \(last routed 24 hours ago\)/);
    expect(lines).toMatch(/last attempt: poke skipped — KEEPER_PRIVATE_KEY is not set/);
    expect(lines).toMatch(/router 0x0000…c0c0 {2}observed 2 minutes ago, never routed/);
    expect(lines).toMatch(/pm2 logs balast-keeper/);
  });

  it('copes with an API from before the keeper', () => {
    expect(keeperReport(undefined)[0]).toMatch(/not reported/);
  });
});
