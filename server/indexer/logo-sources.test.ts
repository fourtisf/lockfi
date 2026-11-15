/**
 * Logos from GeckoTerminal, DexScreener and Blockscout.
 *
 * The response bodies below are real: read off the live APIs on 2026-11-14
 * for real Robinhood Chain tokens, trimmed to the fields that matter. A parser
 * tested against a shape somebody remembered is a parser that has never met
 * the API — these met it.
 *
 * No test here touches the network: every source takes its fetch as an
 * argument.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  RETRY_ERROR_MS,
  RETRY_NONE_MS,
  blockscout,
  dexScreener,
  geckoTerminal,
  sweepLogos,
  type FetchJson,
  type LogoAnswer,
  type LogoSource,
} from './logo-sources';
import { refreshLogos } from './logos';

const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const ESTR = '0xc9f412f082866aa2eabd0de6280da54c839c3013';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

/** GET .../networks/robinhood/tokens/multi/CASHCAT,ESTR,PONS — real, trimmed. */
const GECKO_MULTI = {
  data: [
    { id: `robinhood_${CASHCAT}`, type: 'token', attributes: { address: CASHCAT, name: 'Cash Cat', symbol: 'CASHCAT', image_url: 'https://coin-images.coingecko.com/coins/images/102174280/large/cashcat-logo.jpg?1782922765', decimals: 18 } },
    { id: `robinhood_${ESTR}`, type: 'token', attributes: { address: ESTR, name: 'Elon Strategy', symbol: 'ESTR', image_url: null, decimals: 18 } },
    { id: `robinhood_${PONS}`, type: 'token', attributes: { address: PONS, name: 'Pons', symbol: 'PONS', image_url: 'https://coin-images.coingecko.com/coins/images/102174571/large/jhitvkisdq8fhxvimdkpcw7y3dx5.?1784093932', decimals: 18 } },
  ],
};

/** GET .../tokens/v1/robinhood/CASHCAT,ESTR,PONS — real, trimmed. Checksummed addresses, as served. */
const DEX_PAIRS = [
  { chainId: 'robinhood', dexId: 'uniswap', pairAddress: '0xA70fc67C9F69da90B63a0e4C05D229954574E313', baseToken: { address: '0x020bfC650A365f8BB26819deAAbF3E21291018b4', name: 'Cash Cat', symbol: 'CASHCAT' }, quoteToken: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', name: 'WETH', symbol: 'WETH' }, priceUsd: '0.04475', info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/Lq7a3pS9Wn8EuGp0?width=800&height=800&quality=95&format=auto' } },
  { chainId: 'robinhood', dexId: 'uniswap', pairAddress: '0x06b3208F93E37Ed7a3f813e4e6E8cf7680fD9720', baseToken: { address: '0xc9f412F082866aA2EabD0DE6280dA54C839c3013', name: 'Elon Strategy', symbol: 'ESTR' }, quoteToken: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', name: 'WETH', symbol: 'WETH' }, priceUsd: '0.00002727', info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/xHsn4ZCDXa9KXfL6?width=800&height=800&quality=95&format=auto' } },
  { chainId: 'robinhood', dexId: 'uniswap', pairAddress: '0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA', baseToken: { address: '0x39dBED3a2bd333467115dE45665cC57F813C4571', name: 'Pons', symbol: 'PONS' }, quoteToken: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', name: 'WETH', symbol: 'WETH' }, priceUsd: '0.1225', info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/dkmXs8KYMyMXjuU1?width=800&height=800&quality=95&format=auto' } },
];

/** A fetch that answers from a table of URL fragments, and records what it was asked. */
function fakeFetch(routes: [RegExp, { status: number; body: unknown } | 'throw'][]) {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) return { status: 404, body: null };
    if (hit[1] === 'throw') throw new Error('network down');
    return hit[1];
  };
  return { fetchJson, calls };
}

describe('geckoTerminal', () => {
  it('reads image_url per token, and null as no logo', async () => {
    const { fetchJson, calls } = fakeFetch([[/geckoterminal/, { status: 200, body: GECKO_MULTI }]]);
    const answers = await geckoTerminal(fetchJson, 'robinhood').lookup([CASHCAT, ESTR, PONS]);
    expect(calls[0]).toBe(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/${CASHCAT},${ESTR},${PONS}`,
    );
    expect(answers.get(CASHCAT)).toEqual({ kind: 'found', url: GECKO_MULTI.data[0].attributes.image_url });
    expect(answers.get(ESTR)).toEqual({ kind: 'none' });
    expect(answers.get(PONS)?.kind).toBe('found');
  });

  it('treats a token it does not mention as unknown, not as an error', async () => {
    // Real: an unknown address answers 200 {"data":[]}.
    const { fetchJson } = fakeFetch([[/geckoterminal/, { status: 200, body: { data: [] } }]]);
    const answers = await geckoTerminal(fetchJson).lookup([CASHCAT]);
    expect(answers.get(CASHCAT)).toEqual({ kind: 'none' });
  });

  it('reads a rate limit as an error, so the token is asked again soon', async () => {
    // Real: a burst of calls answers 429.
    const { fetchJson } = fakeFetch([[/geckoterminal/, { status: 429, body: { status: { error_code: 429 } } }]]);
    const answers = await geckoTerminal(fetchJson).lookup([CASHCAT, ESTR]);
    expect([...answers.values()]).toEqual([{ kind: 'error' }, { kind: 'error' }]);
  });

  it('refuses placeholder art and anything that is not http(s)', async () => {
    const body = {
      data: [
        { attributes: { address: CASHCAT, image_url: 'https://assets.geckoterminal.com/missing.png' } },
        { attributes: { address: ESTR, image_url: 'javascript:alert(1)' } },
      ],
    };
    const { fetchJson } = fakeFetch([[/geckoterminal/, { status: 200, body }]]);
    const answers = await geckoTerminal(fetchJson).lookup([CASHCAT, ESTR]);
    expect(answers.get(CASHCAT)).toEqual({ kind: 'none' });
    expect(answers.get(ESTR)).toEqual({ kind: 'none' });
  });
});

describe('dexScreener', () => {
  it('reads info.imageUrl for each pair’s base token, matching checksummed addresses', async () => {
    const { fetchJson, calls } = fakeFetch([[/dexscreener/, { status: 200, body: DEX_PAIRS }]]);
    const answers = await dexScreener(fetchJson, 'robinhood').lookup([CASHCAT, ESTR, PONS]);
    expect(calls[0]).toBe(`https://api.dexscreener.com/tokens/v1/robinhood/${CASHCAT},${ESTR},${PONS}`);
    expect(answers.get(ESTR)).toEqual({ kind: 'found', url: DEX_PAIRS[1].info.imageUrl });
    expect(answers.get(CASHCAT)?.kind).toBe('found');
  });

  it('never gives the quote token the base token’s face', async () => {
    // WETH is the quote in every one of these pairs. Asked about WETH, the
    // answer must be "none", not CASHCAT's cat.
    const { fetchJson } = fakeFetch([[/dexscreener/, { status: 200, body: DEX_PAIRS }]]);
    const answers = await dexScreener(fetchJson).lookup([WETH]);
    expect(answers.get(WETH)).toEqual({ kind: 'none' });
  });

  it('reads a failure as an error', async () => {
    const { fetchJson } = fakeFetch([[/dexscreener/, 'throw']]);
    const answers = await dexScreener(fetchJson).lookup([CASHCAT]);
    expect(answers.get(CASHCAT)).toEqual({ kind: 'error' });
  });
});

describe('blockscout', () => {
  it('reads icon_url, null as none, and its 403 "Not found" as none', async () => {
    const { fetchJson } = fakeFetch([
      [/0x5fc5/, { status: 200, body: { address_hash: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', icon_url: 'https://assets.coingecko.com/coins/images/51281/standard/GDN_USDG_Token_200x200.png?1730484111' } }],
      [new RegExp(ESTR), { status: 200, body: { address_hash: ESTR, symbol: 'ESTR', icon_url: null } }],
      // Real: an address the explorer does not know.
      [/0x0{38}aa/, { status: 403, body: { message: 'Not found' } }],
    ]);
    const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const unknown = '0x00000000000000000000000000000000000000aa';
    const answers = await blockscout(fetchJson, 'https://explorer.test').lookup([usdg, ESTR, unknown]);
    expect(answers.get(usdg)?.kind).toBe('found');
    expect(answers.get(ESTR)).toEqual({ kind: 'none' });
    expect(answers.get(unknown)).toEqual({ kind: 'none' });
  });

  it('reads any other refusal as an error', async () => {
    // A 403 with no "Not found" is a block (it answered exactly that to a
    // request with no User-Agent), not an answer about the token.
    const { fetchJson } = fakeFetch([[/explorer/, { status: 403, body: null }]]);
    const answers = await blockscout(fetchJson, 'https://explorer.test').lookup([ESTR]);
    expect(answers.get(ESTR)).toEqual({ kind: 'error' });
  });
});

// ----------------------------------------------------------------- sweep --

/** A source with fixed answers, recording every address it was asked. */
function fixedSource(name: LogoSource['name'], answers: Record<string, LogoAnswer>): LogoSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    name,
    batch: 30,
    asked,
    async lookup(addresses) {
      asked.push(...addresses);
      return new Map(addresses.map((a) => [a, answers[a] ?? { kind: 'none' as const }]));
    },
  };
}

async function token(address: string, symbol: string, logoUrl: string | null = null): Promise<void> {
  await prisma.token.create({
    data: { address, symbol, name: symbol, decimals: 18, logoUrl, firstSeen: new Date('2026-11-01T00:00:00Z') },
  });
}

describe('sweepLogos', () => {
  const now = new Date('2026-11-14T12:00:00Z');

  beforeAll(async () => {
    if (!(await isReachable())) {
      throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
    }
  });

  beforeEach(async () => {
    await resetDatabase();
    await token(CASHCAT, 'CASHCAT');
    await token(ESTR, 'ESTR');
    await token(PONS, 'PONS');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('fills each token from the first source that has it, and asks later sources only for the rest', async () => {
    const gecko = fixedSource('geckoterminal', { [CASHCAT]: { kind: 'found', url: 'https://g.test/cashcat.png' } });
    const dex = fixedSource('dexscreener', {
      [CASHCAT]: { kind: 'found', url: 'https://d.test/should-not-win.png' },
      [ESTR]: { kind: 'found', url: 'https://d.test/estr.png' },
    });
    const scout = fixedSource('blockscout', {});

    const result = await sweepLogos({ now, sources: [gecko, dex, scout], registry: null });

    expect(result).toMatchObject({ looked: 3, found: 2, bySource: { geckoterminal: 1, dexscreener: 1 } });
    expect(dex.asked.sort()).toEqual([ESTR, PONS].sort());
    expect(scout.asked).toEqual([PONS]);

    const rows = await prisma.token.findMany({ orderBy: { symbol: 'asc' } });
    const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    expect(by.CASHCAT).toMatchObject({ logoUrl: 'https://g.test/cashcat.png', logoSource: 'geckoterminal' });
    expect(by.ESTR).toMatchObject({ logoUrl: 'https://d.test/estr.png', logoSource: 'dexscreener' });
    // PONS: every source answered and none had one — ask again in a day.
    expect(by.PONS.logoUrl).toBeNull();
    expect(by.PONS.logoRetryAt?.getTime()).toBe(now.getTime() + RETRY_NONE_MS);
  });

  it('retries soon when a source failed, so a rate limit delays a logo instead of losing it', async () => {
    const gecko = fixedSource('geckoterminal', { [PONS]: { kind: 'error' } });
    await sweepLogos({ now, sources: [gecko] });
    const pons = await prisma.token.findUniqueOrThrow({ where: { address: PONS } });
    expect(pons.logoRetryAt?.getTime()).toBe(now.getTime() + RETRY_ERROR_MS);
  });

  it('does not ask again before a token is due, and never touches one that has a logo', async () => {
    await prisma.token.update({ where: { address: CASHCAT }, data: { logoUrl: 'https://curated.test/c.png', logoSource: 'list' } });
    const first = fixedSource('geckoterminal', {});
    await sweepLogos({ now, sources: [first] });
    expect(first.asked.sort()).toEqual([ESTR, PONS].sort());

    const again = fixedSource('geckoterminal', {});
    expect((await sweepLogos({ now: new Date(now.getTime() + 60_000), sources: [again] })).looked).toBe(0);
    expect(again.asked).toEqual([]);

    const curated = await prisma.token.findUniqueOrThrow({ where: { address: CASHCAT } });
    expect(curated).toMatchObject({ logoUrl: 'https://curated.test/c.png', logoSource: 'list' });
  });

  it('lets the curated list replace a logo a source supplied', async () => {
    await sweepLogos({
      now,
      sources: [fixedSource('dexscreener', { [PONS]: { kind: 'found', url: 'https://d.test/pons.png' } })],
    });
    // A list file written for this test, in the scratch-safe tmp dir.
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'tidewell-list-'));
    const file = join(dir, 'tokens.json');
    await writeFile(file, JSON.stringify({ tokens: [{ chainId: 4663, address: PONS, logoURI: 'https://curated.test/pons.png' }] }));

    expect(await refreshLogos({ url: file, chainId: 4663 })).toBe(1);
    const pons = await prisma.token.findUniqueOrThrow({ where: { address: PONS } });
    expect(pons).toMatchObject({ logoUrl: 'https://curated.test/pons.png', logoSource: 'list' });
  });

  it('keeps every logo off a token posing as a Robinhood stock token', async () => {
    // The registry: Robinhood's factory made AAPL and SPCX at these addresses.
    const OFFICIAL_SPCX = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';
    const registry = {
      addresses: new Set([OFFICIAL_SPCX, '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9']),
      tickers: new Set(['SPCX', 'AAPL', 'NVDA']),
    };
    const add = (address: string, symbol: string, name: string, logoUrl: string | null, logoSource: string | null) =>
      prisma.token.create({ data: { address, symbol, name, decimals: 18, logoUrl, logoSource, firstSeen: new Date() } });
    // The copy on the live boards: not Robinhood's, wearing the feather.
    await add('0x9507fba0a82f6c3f2efd4215d52361db17871437', 'SPCX', 'Space Exploration Technologies Corp .Robinhood Token', 'https://g.test/feather.png', 'geckoterminal');
    // A ticker copy with no Robinhood in its name, and no logo yet.
    await add('0xdecf74e4aa6ff30b1612e65665aaf650bedecba3', 'NVDA', 'NVDA', null, null);
    // The real one, and an ordinary memecoin with a short ticker.
    await add(OFFICIAL_SPCX, 'SPCX', 'SpaceX • Robinhood Token', null, null);
    await add('0x00000000000000000000000000000000000000ee', 'ON', 'On Something', null, null);
    // A logo a person curated stays, whatever its name says.
    await add('0x00000000000000000000000000000000000000ef', 'HOODON', 'Robinhood Token Index', 'https://curated.test/x.png', 'list');

    const asked = fixedSource('geckoterminal', {});
    await sweepLogos({ now, sources: [asked], registry, size: 50 });

    const by = Object.fromEntries((await prisma.token.findMany()).map((t) => [t.address, t]));
    expect(by['0x9507fba0a82f6c3f2efd4215d52361db17871437']).toMatchObject({ logoUrl: null, logoSource: 'impostor' });
    expect(by['0xdecf74e4aa6ff30b1612e65665aaf650bedecba3'].logoSource).toBe('impostor');
    expect(by['0x00000000000000000000000000000000000000ef']).toMatchObject({ logoUrl: 'https://curated.test/x.png', logoSource: 'list' });
    // Neither copy was looked up; the real token and the memecoin were.
    expect(asked.asked).not.toContain('0x9507fba0a82f6c3f2efd4215d52361db17871437');
    expect(asked.asked).not.toContain('0xdecf74e4aa6ff30b1612e65665aaf650bedecba3');
    expect(asked.asked).toEqual(expect.arrayContaining([OFFICIAL_SPCX, '0x00000000000000000000000000000000000000ee']));
  });

  it('does nothing when switched off', async () => {
    process.env.LOGO_SOURCES = 'off';
    try {
      const gecko = fixedSource('geckoterminal', {});
      expect((await sweepLogos({ now, sources: [gecko] })).looked).toBe(0);
      expect(gecko.asked).toEqual([]);
    } finally {
      delete process.env.LOGO_SOURCES;
    }
  });
});
