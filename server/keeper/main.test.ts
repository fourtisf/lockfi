import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { Backoff, readSettings } from './main';

describe('keeper settings', () => {
  it('defaults when nothing is set', () => {
    const { settings, errors } = readSettings({});
    expect(errors).toEqual([]);
    expect(settings.maxDeviationBps).toBe(300);
    expect(settings.minRouteWei).toBe(parseEther('0.002'));
  });

  it('a malformed guard is an error, never a guard switched off', () => {
    const { errors } = readSettings({ KEEPER_MAX_DEVIATION_BPS: '3%', KEEPER_INTERVAL_MS: 'soon', KEEPER_SLIPPAGE_BPS: '20000' });
    expect(errors).toHaveLength(3);
    expect(errors.join(' ')).toContain('KEEPER_MAX_DEVIATION_BPS');
  });

  it('refuses a band wider than the contract takes from a keeper', () => {
    expect(readSettings({ KEEPER_MAX_DEVIATION_BPS: '600' }).errors).toHaveLength(1);
    expect(readSettings({ KEEPER_MAX_DEVIATION_BPS: '480' }).errors).toHaveLength(0);
  });

  it('refuses an amount of ETH that is not one', () => {
    expect(readSettings({ KEEPER_MIN_ROUTE_ETH: 'lots' }).errors).toHaveLength(1);
    expect(readSettings({ KEEPER_DAILY_GAS_ETH: '0' }).errors).toHaveLength(1);
  });
});

describe('keeper backoff', () => {
  it('doubles from five minutes to a day, and clears on success', () => {
    const b = new Backoff();
    const t = 1_000_000;
    expect(b.failed('r', t)).toBe(5 * 60_000);
    expect(b.failed('r', t)).toBe(10 * 60_000);
    expect(b.waiting('r', t + 9 * 60_000)).toBe(true);
    for (let i = 0; i < 20; i++) b.failed('r', t);
    expect(b.failed('r', t)).toBe(24 * 3_600_000);
    b.ok('r');
    expect(b.waiting('r', t)).toBe(false);
  });
});
