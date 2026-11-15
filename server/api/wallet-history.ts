/**
 * One wallet's history in Tidewell's vaults: what it deposited, withdrew and
 * claimed, from the vaults' own events (indexer/contracts.ts reads them to
 * the chain head on their own cursors, independent of the pool indexer).
 *
 * Served per wallet, never folded into the snapshot: the snapshot is one
 * public document cached and pushed identically to every visitor. Nothing
 * here is private — every row is a public log on chain — but a wallet's rows
 * have no place in a document every other visitor receives.
 *
 * Amounts are raw integer strings in each pool's currency0 and currency1; the
 * browser values them at today's prices, with the decimals the vault's live
 * read carries.
 */

import type { VaultDeployment } from '../../lib/contracts/deployments';
import { prisma } from '../db';
import { contractCursorKey } from '../indexer/contracts';

export interface WalletVaultTotals {
  vault: string;
  poolId: string;
  deposited0: string;
  deposited1: string;
  withdrawn0: string;
  withdrawn1: string;
  claimed0: string;
  claimed1: string;
  firstDepositAt: string | null;
}

export interface WalletEvent {
  vault: string;
  poolId: string;
  kind: 'Deposited' | 'Withdrawn' | 'Claimed';
  at: string;
  txHash: string;
  amount0: string;
  amount1: string;
}

export interface WalletHistory {
  wallet: string;
  vaults: WalletVaultTotals[];
  /** Newest first, at most HISTORY_LIMIT. */
  events: WalletEvent[];
  /** Chain time the vaults' events were last read to; null when they never were. */
  asOf: string | null;
}

export const HISTORY_LIMIT = 50;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KINDS = ['Deposited', 'Withdrawn', 'Claimed'] as const;

export function isWalletAddress(address: string): boolean {
  return ADDRESS.test(address);
}

export async function walletHistory(address: string, vaults: VaultDeployment[]): Promise<WalletHistory> {
  const wallet = address.toLowerCase();
  if (!ADDRESS.test(wallet)) throw new Error('not an address');
  const contracts = vaults.map((v) => v.address.toLowerCase());
  const poolOf = new Map(vaults.map((v) => [v.address.toLowerCase(), v.poolId.toLowerCase()]));
  if (contracts.length === 0) return { wallet, vaults: [], events: [], asOf: null };

  const [rows, cursors] = await Promise.all([
    prisma.contractEvent.findMany({
      where: { contract: { in: contracts }, account: wallet, kind: { in: [...KINDS] } },
      orderBy: [{ blockNum: 'desc' }, { logIndex: 'desc' }],
    }),
    prisma.indexerCursor.findMany({ where: { contract: { in: contracts.map(contractCursorKey) } } }),
  ]);

  const totals = new Map<string, { d0: bigint; d1: bigint; w0: bigint; w1: bigint; c0: bigint; c1: bigint; first: Date | null }>();
  const int = (v: unknown) => {
    try {
      return BigInt(String(v ?? '0'));
    } catch {
      return 0n;
    }
  };
  for (const r of rows) {
    const t = totals.get(r.contract) ?? { d0: 0n, d1: 0n, w0: 0n, w1: 0n, c0: 0n, c1: 0n, first: null };
    const a = r.args as Record<string, unknown>;
    const [x0, x1] = [int(a.amount0), int(a.amount1)];
    if (r.kind === 'Deposited') {
      t.d0 += x0;
      t.d1 += x1;
      if (t.first === null || r.blockTime < t.first) t.first = r.blockTime;
    } else if (r.kind === 'Withdrawn') {
      t.w0 += x0;
      t.w1 += x1;
    } else {
      t.c0 += x0;
      t.c1 += x1;
    }
    totals.set(r.contract, t);
  }

  // How current the history is: the least-advanced vault's cursor.
  const times = cursors.map((c) => c.lastIndexedAt.getTime());
  return {
    wallet,
    vaults: [...totals.entries()].map(([vault, t]) => ({
      vault,
      poolId: poolOf.get(vault) ?? '',
      deposited0: t.d0.toString(),
      deposited1: t.d1.toString(),
      withdrawn0: t.w0.toString(),
      withdrawn1: t.w1.toString(),
      claimed0: t.c0.toString(),
      claimed1: t.c1.toString(),
      firstDepositAt: t.first?.toISOString() ?? null,
    })),
    events: rows.slice(0, HISTORY_LIMIT).map((r) => {
      const a = r.args as Record<string, unknown>;
      return {
        vault: r.contract,
        poolId: poolOf.get(r.contract) ?? '',
        kind: r.kind as WalletEvent['kind'],
        at: r.blockTime.toISOString(),
        txHash: r.txHash,
        amount0: int(a.amount0).toString(),
        amount1: int(a.amount1).toString(),
      };
    }),
    asOf: times.length === contracts.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}
