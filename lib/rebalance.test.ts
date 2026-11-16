import { describe, expect, it } from 'vitest';
import { rebalanceHref, widthPctOfTicks } from './rebalance';

describe('widthPctOfTicks', () => {
  it('turns a tick span back into the ± width that made it', () => {
    // ±15% spans 1.15 / 0.85 ≈ 1.3529 in price, about 3,023 ticks.
    const span = Math.round(Math.log(1.15 / 0.85) / Math.log(1.0001));
    expect(widthPctOfTicks(1000, 1000 + span)).toBe(15);
  });
  it('stays inside what the Positions page accepts', () => {
    expect(widthPctOfTicks(0, 10)).toBe(2);
    expect(widthPctOfTicks(0, 400_000)).toBe(60);
    expect(widthPctOfTicks(10, 0)).toBe(2);
  });
});

describe('rebalanceHref', () => {
  it('opens Positions on the same pool, width and bins, marked as a rebalance', () => {
    const span = Math.round(Math.log(1.2 / 0.8) / Math.log(1.0001));
    const href = rebalanceHref('v4:0xabc', -span / 2, span / 2, 15, 1, 60);
    const q = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/positions?')).toBe(true);
    expect(q.get('pool')).toBe('v4:0xabc');
    expect(q.get('width')).toBe('20');
    expect(q.get('bins')).toBe('15');
    expect(q.get('rebalance')).toBe('1');
  });
  it('keeps the bin count inside the page’s bounds', () => {
    const q = new URLSearchParams(rebalanceHref('v4:0x1', 0, 3000, 90, 4, 60).split('?')[1]);
    expect(q.get('bins')).toBe('60');
  });
});
