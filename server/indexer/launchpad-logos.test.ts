/**
 * Launchpad logos: declared on chain, fetched once, checked, shrunk, stored.
 *
 * Every case here is one met on the real chain while building this: Pons's
 * logo() on IPFS (PINO), Doppler's tokenURI() metadata (8CEN), an "image"
 * that is an Imgur HTML page (shockR), metadata with no image at all
 * (FITMONEY), a 2.4 MB logo (PONS), and gateways that answer 429.
 */

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { ipfsPath, isPublicHttps, launchpad, sniff, storedLogoUrl, type FetchBody, type ReadString } from './launchpad-logos';

const PINO = '0x73dec2699b6f70715b332c61826f23d1f82abc99';
const CENTS = '0x07bd9f743e7e9e37ec5ac65a4a664418fa5eeba3';
const SHOCKR = '0x8cf42d3dfb700d6af915e1a18f1bb8be74691ba3';
const FITMONEY = '0x52137c8c891a45e00cb6b54eaa6c78d4a7f73ba3';
const PLAIN = '0x00000000000000000000000000000000000000aa';

let PNG: Buffer;
let BIG_JPEG: Buffer;

/** Contract getters, as the real tokens answered them. */
const reads: Record<string, Partial<Record<'logo' | 'tokenURI', string>>> = {
  [PINO]: { logo: 'ipfs://bafkreipino' },
  [CENTS]: { tokenURI: 'ipfs://bafkreicentsmeta' },
  [SHOCKR]: { tokenURI: 'ipfs://bafkreishockrmeta' },
  [FITMONEY]: { tokenURI: 'ipfs://bafkreifitmeta' },
};
const read: ReadString = async (address, fn) => reads[address]?.[fn] ?? null;

function gatewayFetch(files: Record<string, { status: number; bytes: Buffer }>) {
  const calls: string[] = [];
  const fetchBody: FetchBody = async (url) => {
    calls.push(url);
    const hit = Object.entries(files).find(([key]) => url.endsWith(key));
    return hit ? hit[1] : { status: 404, bytes: Buffer.from('not found') };
  };
  return { fetchBody, calls };
}

const json = (doc: unknown) => ({ status: 200, bytes: Buffer.from(JSON.stringify(doc)) });

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL.');
  PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0b6e86' } }).png().toBuffer();
  BIG_JPEG = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: '#f97316' } }).jpeg().toBuffer();
});

beforeEach(async () => {
  await resetDatabase();
  for (const address of [PINO, CENTS, SHOCKR, FITMONEY, PLAIN]) {
    await prisma.token.create({ data: { address, symbol: 'T', name: 'T', decimals: 18, firstSeen: new Date() } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('launchpad', () => {
  it('stores a Pons logo() from IPFS as a badge we serve ourselves', async () => {
    const { fetchBody } = gatewayFetch({ bafkreipino: { status: 200, bytes: PNG } });
    const answers = await launchpad(read, fetchBody).lookup([PINO]);
    expect(answers.get(PINO)).toEqual({ kind: 'found', url: storedLogoUrl(PINO) });
    const stored = await prisma.tokenLogo.findUniqueOrThrow({ where: { address: PINO } });
    expect(stored.contentType).toBe('image/webp');
    expect(sniff(Buffer.from(stored.bytes))).toBe('webp');
    expect(stored.origin).toBe('ipfs://bafkreipino');
  });

  it('follows a Doppler tokenURI() to its metadata, and the metadata to its image', async () => {
    const { fetchBody } = gatewayFetch({
      bafkreicentsmeta: json({ name: '8CentsInAJar', image: 'ipfs://bafkreicentsimg' }),
      bafkreicentsimg: { status: 200, bytes: PNG },
    });
    expect((await launchpad(read, fetchBody).lookup([CENTS])).get(CENTS)?.kind).toBe('found');
  });

  it('keeps nothing that is not an image, whatever the metadata calls it', async () => {
    // shockR's real "image" is an Imgur page; FITMONEY's metadata has none.
    const { fetchBody } = gatewayFetch({
      bafkreishockrmeta: json({ name: 'shockR', image: 'ipfs://bafkreishockrimg' }),
      bafkreishockrimg: { status: 200, bytes: Buffer.from('<!doctype html><title>Imgur</title>') },
      bafkreifitmeta: json({ name: 'fitmoney' }),
    });
    const answers = await launchpad(read, fetchBody).lookup([SHOCKR, FITMONEY]);
    expect(answers.get(SHOCKR)).toEqual({ kind: 'none' });
    expect(answers.get(FITMONEY)).toEqual({ kind: 'none' });
    expect(await prisma.tokenLogo.count()).toBe(0);
  });

  it('asks nothing of the network for a token with no launchpad getters', async () => {
    const { fetchBody, calls } = gatewayFetch({});
    expect((await launchpad(read, fetchBody).lookup([PLAIN])).get(PLAIN)).toEqual({ kind: 'none' });
    expect(calls).toEqual([]);
  });

  it('treats rate-limited gateways as unanswered, so the token is asked again soon', async () => {
    const fetchBody: FetchBody = async () => ({ status: 429, bytes: Buffer.from('slow down') });
    expect((await launchpad(read, fetchBody).lookup([PINO])).get(PINO)).toEqual({ kind: 'error' });
  });

  it('tries the next gateway when the first cannot answer', async () => {
    const calls: string[] = [];
    const fetchBody: FetchBody = async (url) => {
      calls.push(url);
      return calls.length === 1 ? null : { status: 200, bytes: PNG };
    };
    expect((await launchpad(read, fetchBody).lookup([PINO])).get(PINO)?.kind).toBe('found');
    expect(calls).toHaveLength(2);
  });

  it('shrinks a 2000px logo to a small badge', async () => {
    const { fetchBody } = gatewayFetch({ bafkreipino: { status: 200, bytes: BIG_JPEG } });
    await launchpad(read, fetchBody).lookup([PINO]);
    const stored = await prisma.tokenLogo.findUniqueOrThrow({ where: { address: PINO } });
    const meta = await sharp(Buffer.from(stored.bytes)).metadata();
    expect([meta.width, meta.height]).toEqual([128, 128]);
    expect(stored.bytes.length).toBeLessThan(BIG_JPEG.length / 10);
  });

  it('never fetches a creator link that points inside a network', async () => {
    reads[PLAIN] = { logo: 'https://169.254.169.254/latest/meta-data' };
    const { fetchBody, calls } = gatewayFetch({});
    try {
      expect((await launchpad(read, fetchBody).lookup([PLAIN])).get(PLAIN)).toEqual({ kind: 'none' });
      expect(calls).toEqual([]);
    } finally {
      delete reads[PLAIN];
    }
  });
});

describe('the guards', () => {
  it('accepts public https only', () => {
    expect(isPublicHttps('https://md.example.uk/static/images/a.jpg')).toBe(true);
    for (const url of [
      'http://example.com/a.png',
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://10.0.0.5/a.png',
      'https://192.168.1.1/a.png',
      'https://172.20.0.1/a.png',
      'https://169.254.169.254/x',
      'https://[::1]/a.png',
      'file:///etc/passwd',
    ]) {
      expect(isPublicHttps(url), url).toBe(false);
    }
  });

  it('reads IPFS references in both forms', () => {
    expect(ipfsPath('ipfs://bafkreiabc')).toBe('bafkreiabc');
    expect(ipfsPath('ipfs://ipfs/bafkreiabc')).toBe('bafkreiabc');
    expect(ipfsPath('https://some.gateway/ipfs/bafkreiabc/logo.png')).toBe('bafkreiabc/logo.png');
    expect(ipfsPath('https://example.com/logo.png')).toBeNull();
  });

  it('knows an image by its bytes, and SVG or HTML is not one', () => {
    expect(sniff(PNG)).toBe('png');
    expect(sniff(BIG_JPEG)).toBe('jpeg');
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniff(Buffer.from('<!doctype html>'))).toBeNull();
  });
});
