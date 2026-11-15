/**
 * keeper_runs: the keeper's attempts on routers, with outcome and numbers.
 *
 * A recording failure never stops the keeper — the chain, not this table, is
 * what decides whether a route is due — but it is logged, because a keeper
 * whose runs go unrecorded is invisible to /api/health.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db';

export type RunKind = 'poke' | 'route';
export type RunStatus = 'ok' | 'reverted' | 'skipped' | 'error';
export type RunDetails = Record<string, string | number | boolean | null>;

export interface RunRecord {
  contract: string;
  kind: RunKind;
  startedAt: Date;
  status: RunStatus;
  txHash?: string | null;
  signer?: string | null;
  reason?: string | null;
  details?: RunDetails;
}

export async function recordRun(run: RunRecord): Promise<void> {
  await prisma.keeperRun.create({
    data: {
      contract: run.contract.toLowerCase(),
      kind: run.kind,
      startedAt: run.startedAt,
      finishedAt: new Date(),
      status: run.status,
      txHash: run.txHash ?? null,
      signer: run.signer?.toLowerCase() ?? null,
      reason: run.reason ?? null,
      details: run.details ?? Prisma.JsonNull,
    },
  });
}
