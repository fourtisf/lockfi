/**
 * Logos launchpad tokens declare on chain, fetched once and served by us.
 *
 * Most tokens on the boards are launchpad memecoins that no aggregator has a
 * logo for. Their launchpads do — on chain, set by the creator at launch:
 *
 *   Pons      `logo()` on the token (PonsV2LauncherToken): an ipfs:// or
 *             https image URL.
 *   Doppler   `tokenURI()` on the token (DopplerERC20V1Factory, used by
 *             Bankr and others): an ipfs:// URL to JSON metadata whose
 *             `image` is the logo.
 *
 * Read off real tokens on this chain (PINO, PONS, ROBINCAT, 8CEN, shockR,
 * FITMONEY) before this was written. What they showed decides the rules:
 *
 *   - IPFS through a public gateway is not something a browser can be sent
 *     to: ipfs.io and dweb.link answer 429. Filebase answers fast and Pinata
 *     slowly, so the image is fetched here, once, through those.
 *   - Declared is not the same as an image. shockR's "image" is an Imgur
 *     HTML page; FITMONEY's metadata has none. Only bytes that ARE an image
 *     (PNG, JPEG, GIF, WebP, by their magic numbers) are kept. SVG is not:
 *     served from our origin it could carry script.
 *   - PONS's is 2.4 MB. Every image is shrunk to a 128px WebP badge.
 *
 * The URL comes from a token's creator, so fetching it is fetching a
 * stranger's link from our server: https only, never a private or loopback
 * address, no redirects, a size cap and a timeout. Gateways are ours to
 * choose and are trusted further.
 *
 * Like every logo source, this takes an image and nothing else (§4).
 */

import sharp from 'sharp';
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, parseAbi } from 'viem';
import { rpc } from '../chain/client';
import { prisma } from '../db';
import type { LogoAnswer, LogoSource } from './logo-sources';

const ABI = parseAbi([
  'function logo() view returns (string)',
  'function tokenURI() view returns (string)',
]);

/** Read a string getter, or null when the token has none. */
export type ReadString = (address: string, fn: 'logo' | 'tokenURI') => Promise<string | null>;
/** GET a URL's body, or null when it could not be reached. */
export type FetchBody = (url: string, opts: { trusted: boolean }) => Promise<{ status: number; bytes: Buffer } | null>;

const GATEWAYS = (process.env.LOGO_IPFS_GATEWAYS ?? 'https://ipfs.filebase.io/ipfs/,https://gateway.pinata.cloud/ipfs/')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const BADGE_PX = 128;
const USER_AGENT = 'Mozilla/5.0 (compatible; tidewell-indexer)';

export const defaultReadString: ReadString = async (address, fn) => {
  try {
    const value = await rpc(async (client) => {
      try {
        return await client.readContract({ address: getAddress(address), abi: ABI, functionName: fn });
      } catch (error) {
        // A token without the getter reverts or returns nothing. That is an
        // answer — "no" — not a reason to try the next endpoint.
        if (
          error instanceof BaseError &&
          error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)
        ) {
          return null;
        }
        throw error;
      }
    }, `${fn}(${address})`);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  } catch {
    return null;
  }
};

export const defaultFetchBody: FetchBody = async (url, { trusted }) => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
      // A stranger's link may not bounce us somewhere it could not point to.
      redirect: trusted ? 'follow' : 'error',
    });
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) return { status: 413, bytes: Buffer.alloc(0) };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { status: 413, bytes: Buffer.alloc(0) };
    return { status: response.status, bytes };
  } catch {
    return null;
  }
};

/** An https URL a creator gave us that does not point inside a network. */
export function isPublicHttps(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':') || host.startsWith('[')) return false; // IPv6 literal
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) {
      return false;
    }
  }
  return true;
}

/** The content path of an IPFS reference, or null. */
export function ipfsPath(raw: string): string | null {
  const s = raw.trim();
  if (s.startsWith('ipfs://')) return s.slice('ipfs://'.length).replace(/^ipfs\//, '');
  const m = s.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/); // a gateway URL: any gateway will do
  return m ? m[1] : null;
}

/** What the bytes are, by their first few — never by what anyone said. */
export function sniff(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

type Fetched = { bytes: Buffer } | 'missing' | 'unreachable';

/** Fetch an ipfs://, gateway, https or data: reference. */
async function fetchRef(ref: string, fetchBody: FetchBody): Promise<Fetched> {
  const data = ref.match(/^data:([^,]*?)(;base64)?,(.*)$/s);
  if (data) {
    try {
      const bytes = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]), 'utf8');
      return bytes.length <= MAX_BYTES ? { bytes } : 'missing';
    } catch {
      return 'missing';
    }
  }
  const path = ipfsPath(ref);
  if (path) {
    let reached = false;
    for (const gateway of GATEWAYS) {
      const res = await fetchBody(gateway + path, { trusted: true });
      if (!res) continue;
      if (res.status === 200 && res.bytes.length > 0) return { bytes: res.bytes };
      // A gateway that answered "not here" or "not allowed" has answered; a
      // rate limit or an outage has not.
      if (res.status !== 429 && res.status < 500) reached = true;
    }
    return reached ? 'missing' : 'unreachable';
  }
  if (!isPublicHttps(ref)) return 'missing';
  const res = await fetchBody(ref, { trusted: false });
  if (!res) return 'unreachable';
  if (res.status === 200 && res.bytes.length > 0) return { bytes: res.bytes };
  return res.status === 429 || res.status >= 500 ? 'unreachable' : 'missing';
}

/** The image a Doppler-style metadata document names, if it names one. */
function imageFromMetadata(bytes: Buffer): string | null {
  try {
    const doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    for (const key of ['image', 'image_url', 'logo', 'logoURI', 'icon']) {
      const v = doc[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* not JSON: no image */
  }
  return null;
}

/** A logo badge: the image shrunk and re-encoded, or null if it is not an image. */
export async function toBadge(bytes: Buffer): Promise<Buffer | null> {
  if (!sniff(bytes)) return null;
  try {
    // A cap against decompression bombs, set above real logos: PONS's is
    // 7806px square — 61 million pixels — and was refused at 40 million.
    // libvips resizes in tiles, so this does not mean decoding it whole.
    return await sharp(bytes, { animated: false, limitInputPixels: 120_000_000 })
      .resize(BADGE_PX, BADGE_PX, { fit: 'cover' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** The URL a stored logo is served at. */
export function storedLogoUrl(address: string): string {
  return `/api/logo/${address.toLowerCase()}`;
}

async function resolveOne(address: string, read: ReadString, fetchBody: FetchBody): Promise<LogoAnswer> {
  const candidates: string[] = [];
  let failed = false;

  const logo = await read(address, 'logo');
  if (logo) candidates.push(logo);

  const uri = await read(address, 'tokenURI');
  if (uri) {
    const meta = await fetchRef(uri, fetchBody);
    if (meta === 'unreachable') failed = true;
    else if (meta !== 'missing') {
      // Some creators point tokenURI straight at the image.
      if (sniff(meta.bytes)) candidates.push(uri);
      else {
        const image = imageFromMetadata(meta.bytes);
        if (image) candidates.push(image);
      }
    }
  }

  for (const ref of candidates) {
    const fetched = await fetchRef(ref, fetchBody);
    if (fetched === 'unreachable') {
      failed = true;
      continue;
    }
    if (fetched === 'missing') continue;
    const badge = await toBadge(fetched.bytes);
    if (!badge) continue;
    await prisma.tokenLogo.upsert({
      where: { address },
      create: { address, contentType: 'image/webp', bytes: badge, origin: ref.slice(0, 512), fetchedAt: new Date() },
      update: { contentType: 'image/webp', bytes: badge, origin: ref.slice(0, 512), fetchedAt: new Date() },
    });
    return { kind: 'found', url: storedLogoUrl(address) };
  }
  return failed ? { kind: 'error' } : { kind: 'none' };
}

/**
 * The launchpad source: first in line, because it is the token's own
 * declaration, made on chain at launch and impossible for anyone else to add.
 */
export function launchpad(read: ReadString = defaultReadString, fetchBody: FetchBody = defaultFetchBody): LogoSource {
  return {
    name: 'launchpad',
    batch: 30,
    async lookup(addresses) {
      const out = new Map<string, LogoAnswer>();
      // A few at a time: each is two contract reads and up to two fetches.
      const queue = [...addresses];
      const worker = async () => {
        for (let address = queue.shift(); address; address = queue.shift()) {
          out.set(address, await resolveOne(address, read, fetchBody).catch(() => ({ kind: 'error' }) as const));
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      return out;
    },
  };
}
