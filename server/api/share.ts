/**
 * What a wallet has earned staking in Tidewell, for the share card (§32).
 *
 * Worked out here, on the server, from the chain and the vaults' own events
 * — never from figures in a link — so a card can only show what the chain
 * says. The sum is the portfolio's, through the same functions
 * (lib/wallet/portfolio.ts): fees earned are what the wallet has claimed plus
 * what it can claim now, at today's prices. No yield, no projection (§1).
 *
 * Nothing private: every input is a public log or a public read, and a card
 * exists only for a wallet someone chose to share.
 */

import type { VaultDeployment } from '../../lib/contracts/deployments';
import { WALLET_READS_PER_VAULT, parseWalletReads, vaultAbi, walletReadCalls, type WalletVaultReads } from '../../lib/contracts/vault';
import type { MarketSnapshot, VaultCurrency } from '../../lib/data/types';
import { walletStakes, walletTotals } from '../../lib/wallet/portfolio';
import { rpc } from '../chain/client';
import { walletHistory } from './wallet-history';

type Address = `0x${string}`;

export interface ShareVault {
  poolId: string;
  /** "ETH / USDG · 0.05%" */
  label: string;
  /** What the stake is worth now; null when a side has no price. */
  stakedUsd: number | null;
}

export interface ShareCard {
  wallet: string;
  /** When this was worked out. */
  asOf: string;
  /** Claimed plus claimable, in dollars at today's prices; null when a side cannot be priced. */
  feesEarnedUsd: number | null;
  claimedUsd: number | null;
  claimableUsd: number | null;
  /** Staked now, in dollars; null when a side cannot be priced. */
  stakedUsd: number | null;
  /** The vaults the wallet holds a stake in now. */
  vaults: ShareVault[];
  /** The wallet's first deposit into any vault, ISO; null when it never made one. */
  since: string | null;
}

const TTL_MS = 30_000;

function feeLabel(fee: number): string {
  return `${+(fee / 10_000).toFixed(4)}%`;
}

/** One vault's reads, as wagmi's `useReadContracts` would return them: a failure is a result, not a throw. */
async function readAll(deployment: VaultDeployment, wallet: Address) {
  const calls = walletReadCalls(deployment.address as Address, wallet);
  return Promise.all(
    calls.map(async (call) => {
      try {
        const result = await rpc((c) => c.readContract(call as Parameters<typeof c.readContract>[0]), `share ${call.functionName}`);
        return { status: 'success' as const, result };
      } catch (error) {
        return { status: 'failure' as const, error };
      }
    }),
  );
}

export async function walletShare(address: string, deployments: VaultDeployment[], snapshot: MarketSnapshot | null): Promise<ShareCard> {
  const wallet = address.toLowerCase() as Address;
  const reads: WalletVaultReads[] = [];
  for (const d of deployments) {
    const results = await readAll(d, wallet);
    if (results.length !== WALLET_READS_PER_VAULT) continue;
    const parsed = parseWalletReads(d, results);
    if (!parsed) throw new Error(`vault ${d.address} could not be read`);
    if (parsed.shares === 0n && parsed.claimable0 === 0n && parsed.claimable1 === 0n) {
      // No stake now, but claimed fees still count: the history below has them.
      reads.push({ ...parsed, amount0: 0n, amount1: 0n, amountsKnown: true });
      continue;
    }
    const amounts = parsed.shares === 0n
      ? ([0n, 0n] as const)
      : await rpc(
          (c) => c.readContract({ address: d.address as Address, abi: vaultAbi, functionName: 'amountsForLiquidity', args: [parsed.shares] }),
          'share amountsForLiquidity',
        );
    reads.push({ ...parsed, amount0: amounts[0], amount1: amounts[1], amountsKnown: true });
  }

  const pools = snapshot?.pools ?? [];
  const ethPrice =
    snapshot?.vaults.map((v) => v.live?.ethPriceUsd ?? null).find((p): p is number => p !== null && p > 0) ??
    snapshot?.global.ethPriceUsd ??
    0;
  const live = new Map<string, VaultCurrency[]>();
  for (const v of snapshot?.vaults ?? []) if (v.live) live.set(v.poolId.toLowerCase(), v.live.currencies);

  const stakes = walletStakes(reads, pools, ethPrice, live);
  const history = await walletHistory(wallet, deployments);
  const totals = walletTotals(history.vaults, stakes, live);
  const known = (n: number) => (Number.isFinite(n) ? n : null);
  const held = stakes.filter((s) => s.shares > 0n);
  const firsts = history.vaults.map((v) => v.firstDepositAt).filter((t): t is string => t !== null).sort();

  return {
    wallet,
    asOf: new Date().toISOString(),
    feesEarnedUsd: known(totals.feesEarnedUsd),
    claimedUsd: known(totals.claimedUsd),
    claimableUsd: known(stakes.reduce((a, s) => a + s.claimableUsd, 0)),
    stakedUsd: known(held.reduce((a, s) => a + s.stakedUsd, 0)),
    vaults: held.map((s) => {
      const r = reads.find((x) => x.deployment.poolId === s.poolId)!;
      return { poolId: s.poolId, label: `${s.sides[0].symbol} / ${s.sides[1].symbol} · ${feeLabel(r.key.fee)}`, stakedUsd: known(s.stakedUsd) };
    }),
    since: firsts[0] ?? null,
  };
}

/** A wallet's card for half a minute: a shared link is opened by many people, and X fetches the image more than once. */
export function createShareCache(ttlMs = TTL_MS) {
  const memo = new Map<string, { at: number; value: Promise<ShareCard> }>();
  return (address: string, deployments: VaultDeployment[], snapshot: () => Promise<MarketSnapshot | null>): Promise<ShareCard> => {
    const key = address.toLowerCase();
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = snapshot().then((s) => walletShare(key, deployments, s));
    value.catch(() => memo.delete(key));
    if (memo.size >= 1000) memo.delete(memo.keys().next().value as string);
    memo.set(key, { at: Date.now(), value });
    return value;
  };
}
