import { describe, expect, it } from 'vitest';
import { SimProvider } from './data/sim-provider';
import type { Vault, VaultLive } from './data/types';
import { LIVE_STALE_SECONDS, afterFee, liveAgeLabel, liveEthPrice, vaultView } from './vault-view';

const snap = new SimProvider().getSnapshot()!;
const pool = { ...snap.pools[0], feeYield: { basis: 'trailing7d' as const, pct: 133 }, fees24hUsd: 5315 };
const NOW = Date.parse('2026-11-15T18:00:00Z');

const live = (over: Partial<VaultLive> = {}): VaultLive => ({
  asOf: new Date(NOW - 40_000).toISOString(),
  blockNumber: 1,
  currencies: [
    { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, priceUsd: 1811 },
    { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6, priceUsd: 1 },
  ],
  ethPriceUsd: 1811,
  change24hPct: 0.6,
  stakedUsd: 250,
  fees24hUsd: 1241,
  volume24hUsd: 2_482_000,
  trades24h: 18_672,
  feeHistory: new Array(14).fill(10),
  historyHours: 168,
  fullRangeYield: { basis: 'trailing7d', pct: 5.58 },
  ...over,
});

const vault = (l?: VaultLive): Vault => ({
  id: 'vault-x',
  poolId: pool.id,
  address: '0x901deabd094bd204cbe02854b1924e5ab4c41597',
  totalStakedUsd: 0,
  stakers: 0,
  rewardRate: 0,
  nextHarvestInSeconds: 0,
  protocolFeeBps: 1000,
  live: l,
});

describe('vaultView', () => {
  it("shows the vault's own full-range yield, less its fee — not the pool's 133%", () => {
    const v = vaultView(vault(live()), pool, NOW);
    expect(v.live).toBe(true);
    expect(v.yield).toEqual({ basis: 'trailing7d', pct: 5.58 * 0.9 });
    expect(v.poolYield).toEqual({ basis: 'trailing7d', pct: 133 });
    expect(v.yieldLabel).toMatch(/after 10% fee/);
    expect(v.young).toBe(false);
    expect(v.fees24hUsd).toBe(1241);
    expect(v.stakedUsd).toBe(250);
    expect(liveAgeLabel(v)).toBe('live · 40s ago');
  });

  it('falls back to the pool, and says it is the pool average', () => {
    const v = vaultView(vault(), pool, NOW);
    expect(v.live).toBe(false);
    expect(v.yield).toEqual(pool.feeYield);
    expect(v.yieldLabel).toMatch(/pool average/);
    expect(liveAgeLabel(v)).toBeNull();
  });

  it('says a live read is old instead of passing it off as live (§7)', () => {
    const v = vaultView(vault(live({ asOf: new Date(NOW - (LIVE_STALE_SECONDS + 60) * 1000).toISOString() })), pool, NOW);
    expect(v.stale).toBe(true);
    expect(liveAgeLabel(v)).toBe('as of 11m ago');
  });

  it('shows no age before the clock is known, so server and browser render alike', () => {
    const v = vaultView(vault(live()), pool, null);
    expect(v.ageSeconds).toBeNull();
    expect(v.stale).toBe(false);
    expect(liveAgeLabel(v)).toBeNull();
  });

  it('keeps the §7 states through the fee', () => {
    expect(afterFee({ basis: 'insufficient', reason: 'young' }, 1000)).toEqual({ basis: 'insufficient', reason: 'young' });
    expect(afterFee({ basis: 'estimate', pct: 10, windowHours: 50 }, 2000)).toEqual({ basis: 'estimate', pct: 8, windowHours: 50 });
  });
});

describe('liveEthPrice', () => {
  it('prefers the newest live read over the snapshot’s price', () => {
    const older = vault(live({ ethPriceUsd: 1790, asOf: new Date(NOW - 3_600_000).toISOString() }));
    const newer = vault(live({ ethPriceUsd: 1811 }));
    expect(liveEthPrice([older, newer], 1759)).toBe(1811);
    expect(liveEthPrice([older], 1759)).toBe(1790);
    expect(liveEthPrice([vault()], 1759)).toBe(1759);
  });
});
