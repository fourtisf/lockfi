import { describe, expect, it } from 'vitest';
import { PriceWindow, deviationBps, minRateFrom } from './plan';

const Q96 = 1n << 96n;

describe('minRateFrom', () => {
  it('is the quoted rate, times 1e18, less the slippage allowance', () => {
    // 1 ETH quoted at 1,000 tokens, 1% slippage: at least 990 tokens per ETH
    expect(minRateFrom(10n ** 18n, 1000n * 10n ** 18n, 100)).toBe(990n * 10n ** 18n);
    expect(minRateFrom(0n, 5n, 100)).toBe(0n);
  });

  it('bounds the route: what the contract checks never exceeds the quote itself', () => {
    const swapIn = 123_456_789n;
    const out = 987_654_321_000n;
    const min = (swapIn * minRateFrom(swapIn, out, 100)) / 10n ** 18n;
    expect(min).toBeLessThan(out);
    expect(min).toBeGreaterThanOrEqual((out * 99n) / 100n - 1n);
  });
});

describe('deviationBps', () => {
  it('measures the price, not the square root of it', () => {
    // a sqrt price 1% higher is a price about 2.01% higher
    expect(deviationBps((Q96 * 101n) / 100n, Q96)).toBeCloseTo(201, 0);
    expect(deviationBps(Q96, Q96)).toBe(0);
    expect(deviationBps(Q96, 0n)).toBe(Infinity);
  });
});

describe('PriceWindow', () => {
  it('has no average until it covers the window, so a restarted keeper waits', () => {
    const w = new PriceWindow(30 * 60_000);
    const t0 = 1_000_000_000;
    w.add('p', Q96, t0);
    w.add('p', Q96, t0 + 60_000);
    expect(w.average('p', t0 + 61_000)).toBeNull();
    expect(w.average('unknown', t0)).toBeNull();
  });

  it('weighs each sample by how long it held, over the last 30 minutes', () => {
    const w = new PriceWindow(30 * 60_000);
    const t0 = 1_000_000_000;
    w.add('p', 100n, t0); // held for 20 minutes
    w.add('p', 400n, t0 + 20 * 60_000); // held for the last 10
    const avg = w.average('p', t0 + 30 * 60_000)!;
    expect(avg).toBe((100n * 20n + 400n * 10n) / 30n);
  });

  it('a spike just before a route barely moves the average, so the deviation guard trips', () => {
    const w = new PriceWindow(30 * 60_000);
    const t0 = 1_000_000_000;
    for (let m = 0; m <= 30; m++) w.add('p', Q96, t0 + m * 60_000);
    const spiked = (Q96 * 110n) / 100n; // a push of about 21% in price
    w.add('p', spiked, t0 + 30 * 60_000 + 5_000);
    const avg = w.average('p', t0 + 30 * 60_000 + 10_000)!;
    expect(deviationBps(spiked, avg)).toBeGreaterThan(300);
  });
});
