import { describe, expect, it } from 'vitest';
import type { Vault } from './data/types';
import { statsTotals, valuePair, vaultStats } from './stats';

const ETH = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, priceUsd: 2500 };
const USDG = { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6, priceUsd: 1 };

function vault(over: Partial<Vault> = {}): Vault {
  return {
    id: 'vault-v4:0x01',
    poolId: 'v4:0x01',
    address: '0x901deabd094bd204cbe02854b1924e5ab4c41597',
    totalStakedUsd: 1000,
    stakers: 3,
    rewardRate: 0,
    nextHarvestInSeconds: 0,
    protocolFeeBps: 1000,
    live: { currencies: [ETH, USDG] } as unknown as Vault['live'],
    totals: {
      // 0.01 ETH + 25 USDG collected; a tenth of each to Tidewell.
      feesCollected: [String(10n ** 16n), '25000000'],
      protocolCut: [String(10n ** 15n), '2500000'],
      claimed: [String(5n * 10n ** 15n), '10000000'],
      protocolPaid: ['0', '0'],
      depositsOpen: true,
      stakedSince: '2026-11-15T00:00:00.000Z',
      lastCollectedAt: '2026-11-16T00:00:00.000Z',
      readTo: '2026-11-16T01:00:00.000Z',
      everStakers: 4,
      deposits: 6,
    },
    ...over,
  };
}

describe('vaultStats', () => {
  it('values fees to stakers as collected less Tidewell’s cut, at today’s prices', () => {
    const s = vaultStats(vault(), undefined);
    expect(s.feesToStakersUsd).toBeCloseTo(0.009 * 2500 + 22.5, 9); // $45
    expect(s.protocolUsd).toBeCloseTo(0.001 * 2500 + 2.5, 9); // $5
    expect(s.claimedUsd).toBeCloseTo(0.005 * 2500 + 10, 9);
    expect(s.protocolPaidUsd).toBe(0);
    expect(s.feesToStakersTokens).toBe('0.009 ETH + 22.5 USDG');
    expect(s.label).toBe('ETH / USDG');
  });

  it('a side with no price is not valued at all, not valued at zero', () => {
    const s = vaultStats(vault({ live: { currencies: [ETH, { ...USDG, priceUsd: null }] } as unknown as Vault['live'] }), undefined);
    expect(s.feesToStakersUsd).toBeNull();
    // A side with nothing in it needs no price.
    expect(valuePair(['5', '0'], [ETH, { ...USDG, priceUsd: null }])).toBeCloseTo(5 * 2500 * 1e-18, 20);
  });

  it('the simulator has no totals: every since-deployment figure is unknown', () => {
    const s = vaultStats(vault({ totals: undefined }), undefined);
    expect(s.feesToStakersUsd).toBeNull();
    expect(s.claimedUsd).toBeNull();
  });
});

describe('statsTotals', () => {
  it('sums the vaults, and a hole makes the total unknown rather than smaller', () => {
    const a = vaultStats(vault(), undefined);
    const b = vaultStats(vault({ totals: undefined, stakers: 2, totalStakedUsd: 500 }), undefined);
    const t = statsTotals([a, b]);
    expect(t.stakedUsd).toBe(1500);
    expect(t.stakers).toBe(5);
    expect(t.feesToStakersUsd).toBeNull();
    expect(statsTotals([a, a]).feesToStakersUsd).toBeCloseTo(90, 9);
    expect(statsTotals([a]).everStakers).toBe(4);
  });
});
