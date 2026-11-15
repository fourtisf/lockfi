import { describe, expect, it } from 'vitest';
import { STALE_BANNER_SECONDS, asOfDate } from './StaleBanner';

describe('asOfDate', () => {
  it('names the day the figures are from, in UTC', () => {
    const now = Date.UTC(2026, 10, 15, 16, 0, 0);
    expect(asOfDate(129.8 * 86400, now)).toBe('8 Jul 2026');
    expect(asOfDate(0, now)).toBe('15 Nov 2026');
  });
  it('only speaks up once the data is hours old, not seconds', () => {
    expect(STALE_BANNER_SECONDS).toBeGreaterThanOrEqual(3600);
  });
});
