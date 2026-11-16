import { describe, expect, it } from 'vitest';
import { SimProvider } from './data/sim-provider';
import type { Pool } from './data/types';
import { byChange, byFeeYield, byMarketCap, fullDayMove, mcRanked, poolsOfToken, stakePoolFor, tokenRows, YIELD_RANK_MIN_DEPTH_USD } from './pools';

const base = new SimProvider().getSnapshot()!.pools[0];

function pool(id: string, address: string, tvlUsd: number, volume24hUsd = 0): Pool {
  return { ...base, id, tvlUsd, volume24hUsd, token: { ...base.token, address, symbol: 'CASHCAT' } };
}

const REAL = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const COPYCAT = '0x9b6fd26a9c8af688e5e82ecf226835c70dede8b3';

describe('tokenRows', () => {
  it('shows a token once, through its deepest pool, however many pools it has', () => {
    const rows = tokenRows([
      pool('a', REAL, 1_000),
      pool('b', REAL, 90_000),
      pool('c', REAL.toUpperCase().replace('0X', '0x'), 5_000),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pool.id).toBe('b');
    expect(rows[0].others.map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('keeps a copycat with the same name as its own row', () => {
    // Grouped by address, never by symbol: another contract calling itself
    // CASHCAT is another token.
    const rows = tokenRows([pool('a', REAL, 1_000), pool('x', COPYCAT, 2_000)]);
    expect(rows.map((r) => r.pool.id).sort()).toEqual(['a', 'x']);
  });

  it('breaks a depth tie on volume, then on id, so the row never flickers', () => {
    const rows = tokenRows([pool('b', REAL, 0, 10), pool('a', REAL, 0, 10), pool('c', REAL, 0, 50)]);
    expect(rows[0].pool.id).toBe('c');
    expect(rows[0].others.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('leaves a token with one pool exactly as it was', () => {
    const only = pool('a', REAL, 1_000);
    expect(tokenRows([only])).toEqual([{ pool: only, others: [] }]);
  });
});

describe('poolsOfToken', () => {
  it('lists every pool of the token, deepest first, and no copycat', () => {
    const all = [pool('a', REAL, 1_000), pool('x', COPYCAT, 9_000), pool('b', REAL, 3_000)];
    expect(poolsOfToken(all, all[0]).map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('byMarketCap', () => {
  const mc = (id: string, marketCapUsd: number, tvlUsd: number): Pool => ({ ...base, id, marketCapUsd, tvlUsd });

  it('ranks by market cap, highest first', () => {
    const sorted = [mc('a', 3e6, 50_000), mc('b', 71e6, 9e6), mc('c', 30_000, 2_000)].sort(byMarketCap);
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps small memecoins in order: a few hundred dollars of depth is still depth', () => {
    // The live board's FITMONEY and RHDF: ~$20K fully diluted on thin pools.
    const sorted = [mc('fit', 20_300, 300), mc('rhdf', 24_800, 450), mc('kit', 2_000, 120)].sort(byMarketCap);
    expect(sorted.map((p) => p.id)).toEqual(['rhdf', 'fit', 'kit']);
    expect(sorted.every(mcRanked)).toBe(true);
  });

  it('does not rank a figure whose depth is unknown', () => {
    // Zero depth means we never saw the pool's funding mint (§14).
    expect(mcRanked(mc('u', 50_000, 0))).toBe(false);
  });

  it('never lets a thin pool’s trillion-dollar figure lead', () => {
    // The live board's catAI: $2.27T fully diluted, priced from a $5 pool.
    const sorted = [mc('real', 3.9e6, 1.05e6), mc('catai', 2.27e12, 5), mc('none', 0, 80_000)].sort(byMarketCap);
    expect(sorted.map((p) => p.id)).toEqual(['real', 'catai', 'none']);
    expect(mcRanked(sorted[1])).toBe(false);
  });

  it('puts a token with no figure last and breaks ties on id', () => {
    const sorted = [mc('z', 0, 0), mc('b', 5e5, 5e3), mc('a', 5e5, 5e3)].sort(byMarketCap);
    expect(sorted.map((p) => p.id)).toEqual(['a', 'b', 'z']);
  });
});

describe('byChange', () => {
  const moved = (id: string, change24hPct: number | null, change24hRefHours: number | null = 24): Pool => ({
    ...base,
    id,
    change24hPct,
    change24hRefHours,
  });

  it('ranks top gainers by the 24h price move, highest first', () => {
    const rows = [moved('a', 4.8), moved('b', -2.9), moved('c', 64.2), moved('d', 0.2)];
    expect(rows.sort(byChange(1)).map((p) => p.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('ranks top losers by the 24h price move, lowest first', () => {
    const rows = [moved('a', 4.8), moved('b', -2.9), moved('c', -64.2), moved('d', 0.2)];
    expect(rows.sort(byChange(-1)).map((p) => p.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('puts a since-launch move after every full-day move, however large', () => {
    // "+20107.8% 5h" is a launch, not a day's gain.
    const rows = [moved('launch', 20_107.8, 5), moved('day', 3.1, 24.3)];
    expect(rows.sort(byChange(1)).map((p) => p.id)).toEqual(['day', 'launch']);
    expect(fullDayMove(moved('x', 1, 23.6))).toBe(true);
    expect(fullDayMove(moved('x', 1, 9))).toBe(false);
  });

  it('ranks an unknown move last in both directions, never as 0%', () => {
    const rows = () => [moved('none', null, null), moved('down', -1), moved('up', 1)];
    expect(rows().sort(byChange(1)).map((p) => p.id)).toEqual(['up', 'down', 'none']);
    expect(rows().sort(byChange(-1)).map((p) => p.id)).toEqual(['down', 'up', 'none']);
  });

  it('treats a simulator pool with no reference age as a full-day move', () => {
    expect(fullDayMove({ ...base, change24hPct: 2, change24hRefHours: undefined })).toBe(true);
  });
});

describe('stakePoolFor', () => {
  it("opens the token's pool that has a vault, not the deeper one the row shows", () => {
    // CASHCAT on the live board: its row is its USDG pool, its vault on its ETH pool.
    const usdg = pool('usdg', REAL, 440_000);
    const eth = pool('eth', REAL, 220_000);
    const pools = [usdg, eth, pool('thin', REAL, 6_000)];
    expect(stakePoolFor(pools, new Set(['eth']), usdg).id).toBe('eth');
  });

  it('keeps the row\'s pool when it has the vault, or when no pool of the token does', () => {
    const usdg = pool('usdg', REAL, 440_000);
    const eth = pool('eth', REAL, 220_000);
    expect(stakePoolFor([usdg, eth], new Set(['usdg', 'eth']), usdg).id).toBe('usdg');
    expect(stakePoolFor([usdg, eth], new Set(['other']), usdg).id).toBe('usdg');
  });

  it('never sends a token to a copycat\'s vault', () => {
    const real = pool('real', REAL, 440_000);
    const copy = pool('copy', COPYCAT, 9_000);
    expect(stakePoolFor([real, copy], new Set(['copy']), real).id).toBe('real');
  });
});

describe('byFeeYield', () => {
  const at = (id: string, tvlUsd: number, pct: number | null): Pool => ({
    ...pool(id, REAL, tvlUsd),
    feeYield: pct === null ? { basis: 'insufficient', reason: 'young' } : { basis: 'trailing7d', pct },
  });

  it('ranks a yield on dust after every pool deep enough to mean it', () => {
    // The live Pools page: $0.004 of depth, $11 of fees, 6,360,813,412%.
    const dust = at('dust', 0.004, 6_360_813_412);
    const real = at('real', 220_000, 40);
    const fair = at('fair', YIELD_RANK_MIN_DEPTH_USD, 12);
    const thin = at('thin', 500, 900);
    const none = at('none', 900_000, null);
    expect([dust, thin, none, fair, real].sort(byFeeYield).map((p) => p.id)).toEqual(['real', 'fair', 'dust', 'thin', 'none']);
  });
});
