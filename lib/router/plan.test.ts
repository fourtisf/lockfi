import { describe, expect, it } from 'vitest';
import { MAX_KEEPER_BAND_BPS, PriceWindow, bandAround, bandMinRate, deviationBps, minRateFrom } from './plan';

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
    const w = new PriceWindow(30 * 60_000, 2);
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

describe('PriceWindow: a minimum number of samples', () => {
  it('two samples 30 minutes apart are not an average: one old sample cannot be the whole reference', () => {
    const w = new PriceWindow(30 * 60_000);
    const t0 = 1_000_000_000;
    w.add('p', Q96, t0);
    w.add('p', Q96, t0 + 29 * 60_000);
    expect(w.average('p', t0 + 30 * 60_000)).toBeNull();
    for (let m = 1; m <= 10; m++) w.add('p', Q96, t0 + 29 * 60_000 + m * 1_000);
    expect(w.average('p', t0 + 30 * 60_000)).toBe(Q96);
  });
});

describe('the price band a route carries', () => {
  it('is ±bps in price around the reference, as sqrt-price edges', () => {
    const { lo, hi } = bandAround(Q96, 300);
    expect(deviationBps(lo, Q96)).toBeCloseTo(300, 0);
    expect(deviationBps(hi, Q96)).toBeCloseTo(300, 0);
    expect(lo).toBeLessThan(Q96);
    expect(hi).toBeGreaterThan(Q96);
  });

  it('the widest keeper band still fits the contract: hi / lo ≤ 1.05 in sqrt price', () => {
    const { lo, hi } = bandAround(Q96 * 12345n, MAX_KEEPER_BAND_BPS);
    expect(hi * 10_000n).toBeLessThanOrEqual(lo * 10_500n);
    const over = bandAround(Q96 * 12345n, 500);
    expect(over.hi * 10_000n).toBeGreaterThan(over.lo * 10_500n);
  });

  it('the minimum rate is the worse edge, never zero, for either orientation', () => {
    // 1 ETH = 1,000 TKN. Token as currency1: price = token per ETH = 1000.
    const sqrt1000 = (Q96 * 31_622_776_601_683_793n) / 1_000_000_000_000_000n; // √1000 · 2^96
    const band = bandAround(sqrt1000, 300);
    const r1 = bandMinRate({ tokenIs0: false, key: { fee: 3000 } }, band, 100);
    // about 1000 · 0.97 · 0.997 · 0.99 ≈ 957 token per ETH
    expect(Number(r1) / 1e18).toBeGreaterThan(950);
    expect(Number(r1) / 1e18).toBeLessThan(965);
    // token as currency0: price = ETH per token = 1/1000
    const inv = bandAround((Q96 * Q96) / sqrt1000, 300);
    const r0 = bandMinRate({ tokenIs0: true, key: { fee: 3000 } }, inv, 100);
    expect(Math.abs(Number(r0) / Number(r1) - 1)).toBeLessThan(0.001);
  });

  it('a dynamic-fee pool is taken as 1%', () => {
    const band = bandAround(Q96, 300);
    const stat = bandMinRate({ tokenIs0: false, key: { fee: 10_000 } }, band, 100);
    const dyn = bandMinRate({ tokenIs0: false, key: { fee: 0x800000 } }, band, 100);
    expect(dyn).toBe(stat);
  });
});
