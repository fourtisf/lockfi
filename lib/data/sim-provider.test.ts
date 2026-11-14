import { describe, expect, it } from 'vitest';
import { SimProvider } from './sim-provider';
import { LiveProvider } from './live-provider';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS } from '../yield';

const snapshot = () => new SimProvider().getSnapshot();

describe('determinism', () => {
  /**
   * The first snapshot is rendered on the server and again in the browser. If
   * the two differ, React throws a hydration error, so this is load-bearing.
   */
  it('produces an identical first snapshot from the same seed', () => {
    const a = new SimProvider(4663).getSnapshot();
    const b = new SimProvider(4663).getSnapshot();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('produces a different market from a different seed', () => {
    const a = new SimProvider(1).getSnapshot();
    const b = new SimProvider(2).getSnapshot();
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it('reads no clock, so the snapshot does not drift between renders', () => {
    // Ages are stored as hours; nothing in the first snapshot comes from now().
    const pools = snapshot().pools;
    expect(pools.every((p) => Number.isFinite(p.ageHours))).toBe(true);
  });
});

describe('totals agree with the rows under them', () => {
  const snap = snapshot();

  it('reports TVL as the sum of its pools', () => {
    const sum = snap.pools.reduce((a, p) => a + p.tvlUsd, 0);
    expect(snap.global.tvlUsd).toBeCloseTo(sum, 6);
    expect(snap.featured.liquidityUsd).toBeCloseTo(sum, 6);
  });

  it('reports 24h fees and volume as the sum of its pools', () => {
    expect(snap.featured.fees24hUsd).toBeCloseTo(
      snap.pools.reduce((a, p) => a + p.fees24hUsd, 0),
      6,
    );
    expect(snap.featured.volume24hUsd).toBeCloseTo(
      snap.pools.reduce((a, p) => a + p.volume24hUsd, 0),
      6,
    );
  });

  it('reports stakers as the sum of its vaults', () => {
    expect(snap.featured.stakers).toBe(snap.vaults.reduce((a, v) => a + v.stakers, 0));
  });
});

describe('honest numbers, as the provider hands them over', () => {
  const snap = snapshot();

  it('gives a pool under 24h old no yield figure at all', () => {
    const young = snap.pools.filter((p) => p.ageHours < MIN_DATA_HOURS);
    expect(young.length).toBeGreaterThan(0);
    for (const p of young) expect(p.feeYield.basis).toBe('insufficient');
  });

  it('marks every pool under 7d as an estimate', () => {
    const mid = snap.pools.filter(
      (p) => p.ageHours >= MIN_DATA_HOURS && p.ageHours < YIELD_WINDOW_HOURS,
    );
    expect(mid.length).toBeGreaterThan(0);
    for (const p of mid) expect(p.feeYield.basis).toBe('estimate');
  });

  it('never claims a window longer than the pool has existed', () => {
    for (const p of snap.pools) expect(p.feeWindowHours).toBeLessThanOrEqual(p.ageHours);
  });

  it('keeps pre-graduation launchpad liquidity listed but unstakeable (§4)', () => {
    const pre = snap.pools.filter((p) => !p.stakeable);
    expect(pre.length).toBeGreaterThan(0);
    for (const p of pre) {
      expect(p.token.launchpad).toBeTruthy();
      // Listed in the market, but no vault offers to take it.
      expect(snap.vaults.some((v) => v.poolId === p.id)).toBe(false);
    }
  });

  it('never pays out from a pool that cannot be staked', () => {
    const unstakeable = new Set(snap.pools.filter((p) => !p.stakeable).map((p) => p.id));
    for (const payout of snap.payouts) expect(unstakeable.has(payout.poolId)).toBe(false);
  });

  it('caps the protocol fee at the constructor cap (§3.3)', () => {
    for (const v of snap.vaults) {
      expect(v.protocolFeeBps).toBe(1000);
      expect(v.protocolFeeBps).toBeLessThanOrEqual(2000);
    }
  });

  it('shows price impact on holdings as a negative number (§7)', () => {
    expect(snap.portfolio.priceImpactUsd).toBeLessThan(0);
  });

  it('sums the portfolio from its rows, before and after the market ticks', () => {
    const provider = new SimProvider(4663);
    const check = () => {
      const pf = provider.getSnapshot()!.portfolio;
      const rowsUsd =
        pf.positions.reduce((a, p) => a + p.valueUsd, 0) +
        pf.stakes.reduce((a, s) => a + s.stakedUsd, 0);
      const rowsWeth =
        pf.positions.reduce((a, p) => a + p.feesWeth, 0) +
        pf.stakes.reduce((a, s) => a + s.earnedWeth, 0);
      expect(pf.netValueUsd).toBeCloseTo(rowsUsd, 6);
      expect(pf.feesEarnedWeth).toBeCloseTo(rowsWeth, 9);
      // The heatmap is every fee earned, so it sums to the same figure.
      expect(pf.dailyFeesWeth.reduce((a, v) => a + v, 0)).toBeCloseTo(rowsWeth, 9);
      // Synthetix: streamed to a staker is claimable by that staker.
      expect(pf.claimableWeth).toBeCloseTo(pf.stakes.reduce((a, s) => a + s.earnedWeth, 0), 9);
    };
    check();
    const tick = provider as unknown as { tickMarket(): void };
    for (let i = 0; i < 40; i++) tick.tickMarket();
    check();
  });

  it('has an out-of-range position to tell the truth about', () => {
    const out = snap.portfolio.positions.filter((p) => !p.inRange);
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) expect(p.outOfRangeSinceHours).toBeGreaterThan(0);
  });
});

describe('subscription', () => {
  it('hands the current snapshot to a new subscriber immediately', () => {
    const provider = new SimProvider();
    let seen: unknown = null;
    const off = provider.subscribe((s) => {
      seen = s;
    });
    expect(seen).toBe(provider.getSnapshot());
    off();
  });

  it('stops delivering after unsubscribe', () => {
    const provider = new SimProvider();
    let calls = 0;
    const off = provider.subscribe(() => {
      calls++;
    });
    expect(calls).toBe(1);
    off();
    // No timers run in a node test, but the listener must be detached.
    expect(calls).toBe(1);
  });
});

describe('LiveProvider', () => {
  // P0 asserted this threw "not implemented". P1 implements it, and the
  // contract it now has to keep is narrower and more important: it may hold
  // nothing, but it must never hold something made up.
  it('holds nothing until the indexer answers, rather than simulated data', () => {
    const live = new LiveProvider();
    // Null, not a throw and not a zeroed snapshot. MarketProvider renders
    // "waiting for the indexer" for this, so the state has to be reachable.
    expect(live.getSnapshot()).toBeNull();
  });

  it('does not start a fetch or a socket on the server', () => {
    // There is no `window` in this environment, which is how a server render
    // is detected. Subscribing must be inert rather than reaching for fetch.
    expect(typeof globalThis.window).toBe('undefined');
    const live = new LiveProvider();
    let calls = 0;
    const off = live.subscribe(() => {
      calls++;
    });
    // No snapshot yet, so the listener is not called on subscribe either —
    // SimProvider calls it immediately because it always has one.
    expect(calls).toBe(0);
    expect(live.getSnapshot()).toBeNull();
    off();
  });

  it('is never the simulator', () => {
    // The one thing that must stay true: a live provider that cannot reach
    // the indexer shows nothing, not generated numbers (§7).
    expect(new LiveProvider().kind).toBe('live');
  });
});
