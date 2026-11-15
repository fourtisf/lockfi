import { parseEther, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import type { WalletVaultReads } from '../contracts/vault';
import type { Pool, Portfolio } from '../data/types';
import { claimableLabel, hasClaimable, holdingLabel, totalClaimableUsd, walletPortfolio, walletStakes, walletTotals } from './portfolio';
import type { VaultCurrency } from '../data/types';

const POOL_ID = `v4:0x${'11'.repeat(32)}`;
const VAULT = `0x${'22'.repeat(20)}` as `0x${string}`;
const TOKEN = `0x${'33'.repeat(20)}` as `0x${string}`;

const pool = { id: POOL_ID, priceUsd: 0.5, quote: 'ETH', token: { address: TOKEN, decimals: 6, symbol: 'TKN' } } as unknown as Pool;

function reads(over: Partial<WalletVaultReads> = {}): WalletVaultReads {
  return {
    deployment: { address: VAULT, poolId: POOL_ID, deployedBlock: 1 },
    key: { currency0: zeroAddress, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    shares: 1_000n,
    totalSupply: 4_000n,
    claimable0: parseEther('0.02'), // ETH
    claimable1: 10_000_000n, // 10 TKN
    ethIndex: 0,
    amount0: parseEther('1'), // ETH
    amount1: 5_000_000_000n, // 5,000 TKN at 6 decimals
    ...over,
  };
}

const base = {
  netValueUsd: 0,
  netChangeUsd: 0,
  netChangePct: 0,
  feesEarnedWeth: 0,
  feesEarnedUsd: 0,
  priceImpactUsd: 0,
  fees7dUsd: 0,
  dailyFeesWeth: new Array(56).fill(0),
  stakes: [],
  positions: [],
  claimableWeth: 0,
  walletBalanceEth: null,
} satisfies Portfolio;

describe('walletStakes', () => {
  it('values the shares from what they would withdraw as', () => {
    const [s] = walletStakes([reads()], [pool], 2500);
    expect(s.sides.map((x) => x.amount)).toEqual([1, 5000]);
    expect(holdingLabel(s)).toBe('1.0000 ETH + 5,000 TKN');
    expect(s.stakedUsd).toBe(2500 + 2500);
    expect(s.vaultShare).toBe(0.25);
  });

  it('claims in both tokens, valued together', () => {
    const [s] = walletStakes([reads()], [pool], 2500);
    expect(s.claimableEth).toBeCloseTo(0.02, 12);
    expect(s.sides[1].claimable).toBe(10);
    expect(s.claimableUsd).toBeCloseTo(0.02 * 2500 + 10 * 0.5, 9);
    expect(s.earnedWeth).toBeCloseTo((0.02 * 2500 + 5) / 2500, 12);
    expect(claimableLabel(s)).toBe('0.0200 ETH + 10 TKN');
  });

  it('puts the ETH side first, whichever currency it is', () => {
    const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as const;
    const [s] = walletStakes(
      [
        reads({
          key: { currency0: TOKEN, currency1: weth, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
          ethIndex: 1,
          amount0: 5_000_000_000n,
          amount1: parseEther('1'),
          claimable0: 10_000_000n,
          claimable1: parseEther('0.02'),
        }),
      ],
      [pool],
      2500,
    );
    expect(s.sides.map((x) => x.symbol)).toEqual(['WETH', 'TKN']);
    expect(s.sides.map((x) => x.amount)).toEqual([1, 5000]);
    expect(s.claimableEth).toBeCloseTo(0.02, 12);
    expect(claimableLabel(s)).toBe('0.0200 WETH + 10 TKN');
  });

  it('shows a pool with no ETH side, with nothing to compound and the unknown side unknown', () => {
    const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as const;
    const stock = { ...pool, quote: 'USDG' } as Pool;
    const [s] = walletStakes(
      [reads({ key: { currency0: usdg, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress }, ethIndex: null })],
      [stock],
      2500,
    );
    expect(s.claimableEth).toBe(0);
    expect(s.sides[0].symbol).toBe('USDG');
    expect(Number.isNaN(s.sides[0].amount)).toBe(true);
    expect(s.priced).toBe(false);
  });

  it('has no stream: nothing waits to be released', () => {
    const [s] = walletStakes([reads()], [pool], 2500);
    expect(s.streamProgressPct).toBe(0);
    expect(s.streamRemainingSeconds).toBe(0);
  });

  it('leaves a stake it cannot price unknown, not zero', () => {
    const [missing] = walletStakes([reads()], [], 2500);
    expect(missing.priced).toBe(false);
    expect(Number.isNaN(missing.stakedUsd)).toBe(true);
    expect(Number.isNaN(missing.claimableUsd)).toBe(true);
    expect(claimableLabel(missing)).toBe('0.0200 ETH + — token');
    const lazy = { ...pool, token: { ...pool.token, decimals: -1 } } as Pool;
    expect(walletStakes([reads()], [lazy], 2500)[0].priced).toBe(false);
    expect(walletStakes([reads()], [pool], 0)[0].priced).toBe(false);
  });
});

describe('claimable', () => {
  it('counts either token as something to claim', () => {
    expect(hasClaimable({ claimable0: 0n, claimable1: 1n })).toBe(true);
    expect(hasClaimable({ claimable0: 0n, claimable1: 0n })).toBe(false);
  });

  it('totals in dollars, and is unknown if any part is', () => {
    const priced = walletStakes([reads(), reads()], [pool], 2500);
    expect(totalClaimableUsd(priced)).toBeCloseTo(2 * 55, 9);
    expect(Number.isNaN(totalClaimableUsd(walletStakes([reads()], [], 2500)))).toBe(true);
  });
});

describe('walletPortfolio', () => {
  it('sums the stakes and the claimable fees into net value', () => {
    const stakes = walletStakes([reads(), reads()], [pool], 2500);
    const p = walletPortfolio(base, stakes, parseEther('2.5'), 2500);
    expect(p.feesEarnedUsd).toBeCloseTo(110, 9);
    expect(p.netValueUsd).toBeCloseTo(2 * 5000 + 110, 9);
    expect(p.walletBalanceEth).toBe(2.5);
    expect(p.stakes).toHaveLength(2);
  });

  it('will not total a portfolio with an unpriced stake in it', () => {
    const stakes = walletStakes([reads()], [], 2500);
    expect(Number.isNaN(walletPortfolio(base, stakes, null, 2500).netValueUsd)).toBe(true);
  });

  it('has no balance without a wallet balance read', () => {
    expect(walletPortfolio(base, [], null, 2500).walletBalanceEth).toBeNull();
  });
});

describe('an ETH/USDG stake, valued from the vault watcher’s live read', () => {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as const;
  // The snapshot's row for this pool describes only its traded side (WETH):
  // the USDG side has no decimals or price there.
  const ethUsdg = { id: POOL_ID, priceUsd: 1759, quote: 'USDG', token: { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', decimals: 18, symbol: 'WETH' } } as unknown as Pool;
  const r = reads({
    key: { currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress },
    amount0: parseEther('0.01'),
    amount1: 18_110_000n, // 18.11 USDG
    claimable0: parseEther('0.0001'),
    claimable1: 500_000n, // 0.5 USDG
  });
  const live: VaultCurrency[] = [
    { address: zeroAddress, symbol: 'ETH', decimals: 18, priceUsd: 1811 },
    { address: USDG, symbol: 'USDG', decimals: 6, priceUsd: 1 },
  ];

  it('was unpriced without it — the whole stake read "—"', () => {
    const [s] = walletStakes([r], [ethUsdg], 1811);
    expect(s.priced).toBe(false);
    expect(Number.isNaN(s.stakedUsd)).toBe(true);
  });

  it('is priced with it, both sides at today’s prices', () => {
    const [s] = walletStakes([r], [ethUsdg], 1811, new Map([[POOL_ID, live]]));
    expect(s.priced).toBe(true);
    expect(s.stakedUsd).toBeCloseTo(0.01 * 1811 + 18.11, 9);
    expect(s.claimableUsd).toBeCloseTo(0.0001 * 1811 + 0.5, 9);
    expect(holdingLabel(s)).toBe('0.0100 ETH + 18.11 USDG');
  });

  it('totals fees earned and price impact from the history, at today’s prices', () => {
    const stakes = walletStakes([r], [ethUsdg], 1811, new Map([[POOL_ID, live]]));
    const history = [
      {
        vault: VAULT,
        poolId: POOL_ID,
        // Deposited 0.0105 ETH + 17.20 USDG; withdrew nothing; claimed 0.30 USDG.
        deposited0: parseEther('0.0105').toString(),
        deposited1: '17200000',
        withdrawn0: '0',
        withdrawn1: '0',
        claimed0: '0',
        claimed1: '300000',
        firstDepositAt: '2026-11-15T10:00:00.000Z',
      },
    ];
    const t = walletTotals(history, stakes, new Map([[POOL_ID, live]]));
    const held = 0.01 * 1811 + 18.11;
    const deposited = 0.0105 * 1811 + 17.2;
    expect(t.claimedUsd).toBeCloseTo(0.3, 9);
    expect(t.feesEarnedUsd).toBeCloseTo(0.3 + 0.0001 * 1811 + 0.5, 9);
    expect(t.priceImpactUsd).toBeCloseTo(held - deposited, 9);
    expect(t.netChangeUsd).toBeCloseTo(held - deposited + t.feesEarnedUsd, 9);
    expect(t.netChangePct).toBeCloseTo((t.netChangeUsd / deposited) * 100, 9);
  });

  it('is unknown, not zero, when a vault in the history has no prices', () => {
    const t = walletTotals(
      [{ vault: VAULT, poolId: POOL_ID, deposited0: '1', deposited1: '1', withdrawn0: '0', withdrawn1: '0', claimed0: '0', claimed1: '0', firstDepositAt: null }],
      [],
      new Map(),
    );
    expect(Number.isNaN(t.feesEarnedUsd)).toBe(true);
    expect(Number.isNaN(t.priceImpactUsd)).toBe(true);
  });
});
