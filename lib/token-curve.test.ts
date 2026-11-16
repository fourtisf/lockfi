import { describe, expect, it } from 'vitest';
import { PONS_BUY_TOPIC, PONS_SELL_TOPIC, decodeCurveTrade, priceOf, replay, summariseCurve, type CurveTrade } from './token-curve';

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const data = (...ns: bigint[]) => `0x${ns.map(word).join('')}`;
const topics = (t: string) => [t, `0x${'0'.repeat(24)}e8852602f84e04e284286d8db01a41edd0ccefb0`, `0x${'0'.repeat(24)}e8852602f84e04e284286d8db01a41edd0ccefb0`];

// Words read off the real TIDEWELL curve on Robinhood Chain.
const BUY = data(27236699182493374n, 9849360548442112431368425n, 272366991824933n, 817100975474801n);
const SELL = data(1531430188943236183534939n, 3478557502096521n, 36234973980172n, 108704921940516n);

const INITIAL = { eth: 1_680_000_000_000_000_000n, tokens: 1_000_000_000n * 10n ** 18n };
const HOUR = 3_600_000;

describe('decodeCurveTrade', () => {
  it('reads a buy: ETH in less both fees joins the reserve, tokens leave it', () => {
    const t = decodeCurveTrade({ topics: topics(PONS_BUY_TOPIC), data: BUY, blockNumber: 10n, logIndex: 2 }, 1000)!;
    expect(t.kind).toBe('buy');
    expect(t.ethGross).toBe(27236699182493374n);
    expect(t.ethDelta).toBe(27236699182493374n - 272366991824933n - 817100975474801n);
    expect(t.tokenDelta).toBe(-9849360548442112431368425n);
  });

  it('reads a sell: ETH out plus both fees leave the reserve, tokens return', () => {
    const t = decodeCurveTrade({ topics: topics(PONS_SELL_TOPIC), data: SELL, blockNumber: 11n, logIndex: 0 }, 2000)!;
    expect(t.kind).toBe('sell');
    expect(t.ethGross).toBe(3478557502096521n + 36234973980172n + 108704921940516n);
    expect(t.ethDelta).toBe(-t.ethGross);
    expect(t.tokenDelta).toBe(1531430188943236183534939n);
  });

  it('ignores anything that is not a trade', () => {
    expect(decodeCurveTrade({ topics: ['0x9f4cd7c4ed99d08a797804560c9c5d71d2cf7e101f2e3b5e7d1ca8a24c370e4f'], data: data(1n, 0n, 2n, 3n), blockNumber: 1n, logIndex: 0 }, 0)).toBeNull();
    expect(decodeCurveTrade({ topics: topics(PONS_BUY_TOPIC), data: data(1n, 2n), blockNumber: 1n, logIndex: 0 }, 0)).toBeNull();
  });
});

function trade(kind: 'buy' | 'sell', at: number, ethGross: bigint, tokens: bigint, block: number): CurveTrade {
  return kind === 'buy'
    ? { kind, at, block, logIndex: 0, ethGross, ethDelta: (ethGross * 96n) / 100n, tokenDelta: -tokens }
    : { kind, at, block, logIndex: 0, ethGross, ethDelta: -ethGross, tokenDelta: tokens };
}

const META = { address: '0x0040dbfd23df97c06FB9A73B59E298D7e5BcE198', symbol: 'TIDEWELL', launchpad: 'Pons', buyUrl: 'https://example', curve: '0xc', supply: 1_000_000_000 };

describe('summariseCurve', () => {
  const launch = 1_000_000 * HOUR;
  const trades = [
    trade('buy', launch + 1 * HOUR, 10n ** 17n, 50_000_000n * 10n ** 18n, 1),
    trade('buy', launch + 2 * HOUR, 2n * 10n ** 17n, 80_000_000n * 10n ** 18n, 2),
    trade('sell', launch + 3 * HOUR, 5n * 10n ** 16n, 20_000_000n * 10n ** 18n, 3),
  ];
  const { end } = replay(INITIAL, trades);

  it('measures since launch while the token is younger than a day, and verifies the replay', () => {
    const s = summariseCurve({ meta: META, initial: INITIAL, trades, reserves: end, ethInCurveWei: end.eth - INITIAL.eth, graduated: false, launchedAt: launch, now: launch + 4 * HOUR, ethUsd: 2000 });
    expect(s.verified).toBe(true);
    expect(s.priceEth).toBeCloseTo(priceOf(end), 18);
    expect(s.changeHours).toBeCloseTo(4, 6);
    expect(s.changePct).toBeCloseTo((priceOf(end) / priceOf(INITIAL) - 1) * 100, 6);
    expect(s.trades).toBe(3);
    expect(s.buys).toBe(2);
    expect(s.volumeEth).toBeCloseTo(0.35, 12);
    expect(s.volumeUsd).toBeCloseTo(700, 6);
    expect(s.fdvUsd).toBeCloseTo(priceOf(end) * 2000 * 1e9, 3);
    expect(s.history[0].p).toBeCloseTo(priceOf(INITIAL), 18);
    expect(s.history.at(-1)!.p).toBeCloseTo(priceOf(end), 18);
  });

  it('measures 24h once older: the reference is the last trade before the window, and only the window counts', () => {
    const now = launch + 26 * HOUR; // the window starts at +2h: the +3h sell and the +25h buy are in it
    const later = [...trades, trade('buy', launch + 25 * HOUR, 10n ** 17n, 10_000_000n * 10n ** 18n, 4)];
    const r = replay(INITIAL, later);
    const s = summariseCurve({ meta: META, initial: INITIAL, trades: later, reserves: r.end, ethInCurveWei: 0n, graduated: false, launchedAt: launch, now, ethUsd: null });
    expect(s.changeHours).toBeCloseTo(24, 6);
    expect(s.trades).toBe(2);
    expect(s.sells).toBe(1);
    expect(s.volumeEth).toBeCloseTo(0.15, 12);
    expect(s.volumeUsd).toBeNull();
    expect(s.priceUsd).toBeNull();
    // the reference: the price after the last trade at or before now − 24h (+2h), the +2h buy
    const ref = replay(INITIAL, trades.slice(0, 2)).points.at(-1)!.price;
    expect(s.changePct).toBeCloseTo((priceOf(r.end) / ref - 1) * 100, 6);
  });

  it('withholds the change and the chart when the replay does not land on the reserves', () => {
    const off = { eth: end.eth + 1n, tokens: end.tokens };
    const s = summariseCurve({ meta: META, initial: INITIAL, trades, reserves: off, ethInCurveWei: 0n, graduated: false, launchedAt: launch, now: launch + 4 * HOUR, ethUsd: 2000 });
    expect(s.verified).toBe(false);
    expect(s.changePct).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.priceEth).toBeCloseTo(priceOf(off), 18); // the price still comes from the curve itself
  });

  it('reports a graduated curve without a price', () => {
    const s = summariseCurve({ meta: META, initial: INITIAL, trades, reserves: { eth: 0n, tokens: 0n }, ethInCurveWei: 0n, graduated: true, launchedAt: launch, now: launch + 4 * HOUR, ethUsd: 2000 });
    expect(s.graduated).toBe(true);
    expect(s.priceEth).toBeNull();
    expect(s.fdvUsd).toBeNull();
  });
});
