/**
 * A connected wallet's stakes and portfolio, from what the chain said.
 *
 * Pure: the browser reads the vaults (hooks/useVaults.ts, through
 * lib/contracts/vault.ts) and this turns the raw integers into what the
 * pages show. Vault fees are credited per share as they are collected and
 * claimable in the pool's two tokens, so a stake and its claimable are each
 * two amounts. Anything the chain did not say — a price for a pool the
 * indexer has not listed, the decimals of a token the snapshot does not
 * describe — is left unknown (NaN, an em dash), never filled in.
 */
import { zeroAddress } from 'viem';
import { CONTRACTS } from '../chain';
import { weiToNumber } from '../contracts/tx';
import type { WalletVaultReads } from '../contracts/vault';
import type { Pool, Portfolio, UserStake } from '../data/types';

export type { WalletVaultReads } from '../contracts/vault';

type Address = `0x${string}`;

/** One of a pool's two tokens, as this wallet holds and can claim it. */
export interface StakeSide {
  symbol: string;
  /** What the shares would withdraw as now, in this token; NaN when its decimals are unknown. */
  amount: number;
  /** Claimable now, in this token; NaN when its decimals are unknown. */
  claimable: number;
  /** Dollar price, or null when unknown. */
  priceUsd: number | null;
}

export interface WalletStake extends UserStake {
  vault: Address;
  shares: bigint;
  /** Claimable fees per currency, raw. */
  claimable0: bigint;
  claimable1: bigint;
  /** Which currency is ETH, or null when the pool has none. */
  ethIndex: 0 | 1 | null;
  /** Both tokens in display order: the ETH side first when there is one. */
  sides: [StakeSide, StakeSide];
  /** The claimable ETH side as a number (0 with no ETH side): what compound stakes back. */
  claimableEth: number;
  /** Claimable in dollars; NaN when a side has no price. */
  claimableUsd: number;
  /** False when a side is unknown or unpriced: stakedUsd is then NaN. */
  priced: boolean;
  /** This wallet's share of the vault, 0–1. */
  vaultShare: number;
}

const WETH = CONTRACTS.weth.toLowerCase();

function describe(currency: string, pool: Pool | undefined, ethPriceUsd: number): { symbol: string; decimals: number; priceUsd: number | null } {
  const c = currency.toLowerCase();
  const eth = ethPriceUsd > 0 ? ethPriceUsd : null;
  if (c === zeroAddress) return { symbol: 'ETH', decimals: 18, priceUsd: eth };
  if (c === WETH) return { symbol: 'WETH', decimals: 18, priceUsd: eth };
  if (pool && c === pool.token.address.toLowerCase()) {
    return { symbol: pool.token.symbol, decimals: pool.token.decimals, priceUsd: pool.priceUsd > 0 ? pool.priceUsd : null };
  }
  // The quote side of a non-ETH pool: the snapshot does not carry its decimals.
  return { symbol: pool?.quote === 'USDG' ? 'USDG' : 'token', decimals: -1, priceUsd: null };
}

/** The wallet's stakes, one per vault it holds shares in or can claim from. */
export function walletStakes(reads: WalletVaultReads[], pools: Pool[], ethPriceUsd: number): WalletStake[] {
  return reads.map((r) => {
    const pool = pools.find((p) => p.id.toLowerCase() === r.deployment.poolId.toLowerCase());
    const meta = [describe(r.key.currency0, pool, ethPriceUsd), describe(r.key.currency1, pool, ethPriceUsd)];
    const num = (wei: bigint, decimals: number) => (decimals >= 0 ? weiToNumber(wei, decimals) : Number.NaN);
    const bySide: StakeSide[] = [0, 1].map((i) => ({
      symbol: meta[i].symbol,
      amount: num(i === 0 ? r.amount0 : r.amount1, meta[i].decimals),
      claimable: num(i === 0 ? r.claimable0 : r.claimable1, meta[i].decimals),
      priceUsd: meta[i].priceUsd,
    }));
    const sides: [StakeSide, StakeSide] = r.ethIndex === 1 ? [bySide[1], bySide[0]] : [bySide[0], bySide[1]];

    // A side with no price or unknown decimals cannot be valued. Zero would
    // claim the stake is worthless.
    const priced = pool !== undefined && sides.every((s) => s.priceUsd !== null && Number.isFinite(s.amount));
    const usd = (pick: (s: StakeSide) => number) =>
      priced ? sides.reduce((a, s) => a + pick(s) * (s.priceUsd as number), 0) : Number.NaN;
    const claimableUsd = usd((s) => s.claimable);
    const claimableEth = r.ethIndex === null ? 0 : sides[0].claimable;

    return {
      vaultId: `vault-${r.deployment.poolId}`,
      poolId: r.deployment.poolId,
      vault: r.deployment.address,
      stakedUsd: usd((s) => s.amount),
      // The shared type's single figure: claimable in ETH terms, for totals
      // and "is there anything to claim". Pages show the two amounts.
      earnedWeth: priced && ethPriceUsd > 0 ? claimableUsd / ethPriceUsd : claimableEth,
      // There is no stream: fees are claimable the moment they are collected.
      streamProgressPct: 0,
      streamRemainingSeconds: 0,
      shares: r.shares,
      claimable0: r.claimable0,
      claimable1: r.claimable1,
      ethIndex: r.ethIndex,
      sides,
      claimableEth,
      claimableUsd,
      priced,
      vaultShare: r.totalSupply > 0n ? Number((r.shares * 1_000_000n) / r.totalSupply) / 1_000_000 : 0,
    };
  });
}

/** True when a stake has anything at all to claim. */
export function hasClaimable(s: Pick<WalletStake, 'claimable0' | 'claimable1'>): boolean {
  return s.claimable0 > 0n || s.claimable1 > 0n;
}

function amountText(n: number, symbol: string): string {
  if (!Number.isFinite(n)) return `— ${symbol}`;
  const eth = symbol === 'ETH' || symbol === 'WETH';
  const digits = eth ? (n > 0 && n < 0.01 ? 6 : 4) : n > 0 && n < 1 ? 6 : 2;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: eth ? digits : 0, maximumFractionDigits: digits })} ${symbol}`;
}

/** "0.0012 ETH + 3.21 USDG", the way a stake's claimable is printed. */
export function claimableLabel(s: Pick<WalletStake, 'sides'>): string {
  return s.sides.map((x) => amountText(x.claimable, x.symbol)).join(' + ');
}

/** "2.4994 ETH + 4,573.52 USDG": what the shares would withdraw as. */
export function holdingLabel(s: Pick<WalletStake, 'sides'>): string {
  return s.sides.map((x) => amountText(x.amount, x.symbol)).join(' + ');
}

/** Everything claimable across stakes, in dollars; NaN if any part has no price. */
export function totalClaimableUsd(stakes: WalletStake[]): number {
  return stakes.reduce((a, s) => a + (hasClaimable(s) ? s.claimableUsd : 0), 0);
}

/**
 * The portfolio a connected wallet sees. Built on the snapshot's (which is
 * wallet-agnostic and empty), with what the chain said put in. Net change,
 * price impact and the fee history need the wallet's deposit and payout
 * history, which nothing reads yet; they keep the snapshot's zeros, and the
 * page shows them as unknown when the portfolio comes from a wallet.
 */
export function walletPortfolio(
  base: Portfolio,
  stakes: WalletStake[],
  balanceWei: bigint | null,
  ethPriceUsd: number,
): Portfolio {
  const claimableUsd = totalClaimableUsd(stakes);
  const allPriced = stakes.every((s) => s.priced);
  const stakedUsd = stakes.reduce((a, s) => a + (s.priced ? s.stakedUsd : 0), 0);
  return {
    ...base,
    stakes,
    claimableWeth: stakes.reduce((a, s) => a + s.earnedWeth, 0),
    feesEarnedWeth: ethPriceUsd > 0 && Number.isFinite(claimableUsd) ? claimableUsd / ethPriceUsd : Number.NaN,
    feesEarnedUsd: claimableUsd,
    netValueUsd: allPriced && Number.isFinite(claimableUsd) ? stakedUsd + claimableUsd : Number.NaN,
    walletBalanceEth: balanceWei === null ? null : weiToNumber(balanceWei),
  };
}
