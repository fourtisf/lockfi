import { describe, expect, it } from 'vitest';
import {
  ageLabel,
  countdown,
  inHours,
  lagLabel,
  price,
  signOf,
  signedPct,
  signedUsd,
  tone,
  usd,
  usdExact,
  usdFee,
  FEE_DIGITS,
  weth,
} from './format';

describe('usd', () => {
  it('scales to B / M / K / plain', () => {
    expect(usd(1.234e9)).toBe('$1.23B');
    expect(usd(52.5e6)).toBe('$52.50M');
    expect(usd(7710)).toBe('$7.7K');
    expect(usd(251)).toBe('$251');
  });

  it('scales negatives by magnitude, not by sign', () => {
    expect(usd(-52.5e6)).toBe('$-52.50M');
  });

  it('shows an em dash rather than NaN', () => {
    expect(usd(Number.NaN)).toBe('—');
    expect(usd(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('signedPct', () => {
  it('uses a real minus sign, not a hyphen', () => {
    expect(signedPct(-4)).toBe('−4.0%');
    expect(signedPct(11.2)).toBe('+11.2%');
  });

  // Zero is neither a gain nor a loss, judged at the precision it is shown.
  it('gives zero no sign, including what only rounds to zero', () => {
    expect(signedPct(0)).toBe('0.0%');
    expect(signedPct(0.04)).toBe('0.0%');
    expect(signedPct(-0.04)).toBe('0.0%');
    expect(signedPct(0.05)).toBe('+0.1%');
  });
});

describe('lagLabel', () => {
  it('reads at a glance in the largest sensible unit', () => {
    expect(lagLabel(42)).toBe('42s');
    expect(lagLabel(15 * 60)).toBe('15m');
    expect(lagLabel(3 * 3600)).toBe('3h');
    expect(lagLabel(3_542_400)).toBe('41d');
    expect(lagLabel(-5)).toBe('0s');
  });
});

describe('signedUsd', () => {
  it('signs gains and losses and leaves zero bare', () => {
    expect(signedUsd(1204)).toBe('+$1,204');
    expect(signedUsd(-812)).toBe('−$812');
    expect(signedUsd(0)).toBe('$0');
    expect(signedUsd(-0.3)).toBe('$0');
  });
});

describe('tone', () => {
  it('is green above zero, red below, and nothing at zero (§19)', () => {
    expect(tone(3)).toBe('up');
    expect(tone(-3)).toBe('down');
    expect(tone(0)).toBe('');
    expect(tone(0.004, 2)).toBe('');
    expect(tone(0.006, 2)).toBe('up');
    expect(signOf(Number.NaN)).toBe(0);
  });
});

describe('price', () => {
  it('gives sub-dollar tokens four decimals and the rest two', () => {
    expect(price(0.00115)).toBe('$0.0012');
    expect(price(187.2)).toBe('$187.2');
    expect(price(2521.08)).toBe('$2,521.08');
  });
});

describe('ageLabel', () => {
  it('reads hours under a day and days above', () => {
    expect(ageLabel(1)).toBe('1h');
    expect(ageLabel(23.9)).toBe('23h');
    expect(ageLabel(24)).toBe('1d');
    expect(ageLabel(69 * 24)).toBe('69d');
  });

  it('never shows a zero-hour age', () => {
    expect(ageLabel(0.2)).toBe('1h');
  });
});

describe('countdown', () => {
  it('matches the prototype phrasing', () => {
    expect(countdown(4 * 86400 + 11 * 3600)).toBe('4d 11h left');
    expect(countdown(2 * 3600 + 30 * 60)).toBe('2h 30m left');
    expect(countdown(45 * 60)).toBe('45m left');
  });

  it('says complete rather than a negative time', () => {
    expect(countdown(0)).toBe('complete');
    expect(countdown(-10)).toBe('complete');
  });
});

describe('inHours', () => {
  it('falls back to minutes under an hour', () => {
    expect(inHours(3 * 3600)).toBe('in 3h');
    expect(inHours(20 * 60)).toBe('in 20m');
    expect(inHours(5)).toBe('in 1m');
  });
});

describe('weth and usdExact', () => {
  it('formats to a fixed number of places', () => {
    expect(weth(2.183)).toBe('2.183 WETH');
    expect(weth(0.88, 2)).toBe('0.88 WETH');
    expect(usdExact(5_142_908)).toBe('$5,142,908');
    expect(usdExact(2521.08, 2)).toBe('$2,521.08');
  });
});

describe('usdFee', () => {
  it('shows a fee under a cent in its own digits, not as $0.00', () => {
    // A $18 stake's fees after an hour: about $0.00007.
    expect(usdFee(0.0000653)).toBe('$0.000065');
    expect(usdFee(0.0042)).toBe('$0.0042');
    expect(tone(0.0000653, FEE_DIGITS)).toBe('up');
  });

  it('shows cents from a cent, and zero as zero', () => {
    expect(usdFee(0)).toBe('$0.00');
    expect(usdFee(1234.567)).toBe('$1,234.57');
    expect(usdFee(0.01)).toBe('$0.01');
  });

  it('bounds what it will print, and keeps unknown unknown', () => {
    expect(usdFee(1e-9)).toBe('< $0.000001');
    expect(usdFee(Number.NaN)).toBe('—');
  });
});
