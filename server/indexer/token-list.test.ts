/**
 * The curated token list, and the stock logos it points at.
 *
 * `config/tokens.json` is generated for Robinhood's stock tokens by
 * scripts/build-stock-logos.py and edited by hand for anything else, and a
 * logo always wins over one from an external source — so a broken entry here
 * puts a broken image on the boards with nothing to override it. These checks
 * are what a reviewer would otherwise have to do by eye.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeLogoUrl } from './logos';

const ROOT = join(__dirname, '..', '..');
const list = JSON.parse(readFileSync(join(ROOT, 'config', 'tokens.json'), 'utf8')) as {
  tokens: { chainId: number; address: string; symbol?: string; logoURI: string }[];
};

describe('config/tokens.json', () => {
  it('lists only this chain, by lowercase address, each once', () => {
    const seen = new Set<string>();
    for (const t of list.tokens) {
      expect(t.chainId, t.address).toBe(4663);
      expect(t.address, t.symbol).toMatch(/^0x[0-9a-f]{40}$/);
      expect(seen.has(t.address), `${t.address} listed twice`).toBe(false);
      seen.add(t.address);
    }
  });

  it('points every logo at something the site can serve', () => {
    for (const t of list.tokens) {
      expect(isSafeLogoUrl(t.logoURI), `${t.symbol}: ${t.logoURI}`).toBe(true);
      if (t.logoURI.startsWith('/')) {
        expect(existsSync(join(ROOT, 'public', t.logoURI)), `${t.symbol}: ${t.logoURI} is missing`).toBe(true);
      }
    }
  });

  it('leaves no stock logo on disk that nothing refers to', () => {
    const referenced = new Set(list.tokens.map((t) => t.logoURI));
    const files = existsSync(join(ROOT, 'public', 'tokens')) ? readdirSync(join(ROOT, 'public', 'tokens')) : [];
    const orphans = files.filter((f) => !referenced.has(`/tokens/${f}`));
    expect(orphans).toEqual([]);
  });

  it('gives Apple the Apple token, by Robinhood’s address, not by name', () => {
    // The official AAPL, from the factory's Deployed event. A copycat
    // calling itself AAPL is not in this list and keeps its own mark.
    const aapl = list.tokens.find((t) => t.address === '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9');
    expect(aapl?.logoURI).toBe('/tokens/AAPL.png');
    expect(list.tokens.filter((t) => t.symbol === 'AAPL')).toHaveLength(1);
  });
});
