/**
 * Token logos, from a curated token list.
 *
 * §4 draws the line precisely: "logos and token metadata may come from
 * external sources, numbers may not." So this file and `logo-sources.ts` —
 * which fills the tokens no list covers, from GeckoTerminal, DexScreener and
 * Blockscout — are the ONLY files in `server/` that talk to anything other
 * than a node or the database. A logo from this list always wins over one
 * from those sources. Two rules keep both on the right side of that line:
 *
 *   It reads `logoURI` and nothing else. Not price, not supply, not decimals
 *   — decimals are an input to every price, so they stay an on-chain read
 *   even though a token list would happily supply them.
 *
 *   A failure is silent and total. No list, an unreachable host, malformed
 *   JSON: every token keeps the colour derived from its address, and not one
 *   number on the site changes. A logo is decoration; the site works without
 *   one and must never wait on one.
 *
 * TOKEN_LIST_URL picks the list. Unset, it is `config/tokens.json`, the
 * curated list that ships with the repository — it used to be opt-in, and
 * `bootstrap.sh` never set it, so on the real box the file was never read.
 *
 * It accepts a LOCAL PATH as well as a URL, which matters more than it looks.
 * Robinhood Chain has no public token list, so waiting for one means no token
 * ever gets a real logo. A file in the repository — `config/tokens.json` —
 * lets whoever knows the tokens supply logos for the ones that matter today,
 * in the same Uniswap token-list shape a public list would use, so switching
 * to one later is a one-line change.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { prisma } from '../db';

/** Uniswap's token-list schema, reduced to the one field we are allowed. */
interface TokenListEntry {
  chainId?: number;
  address?: string;
  logoURI?: string;
}

interface TokenList {
  tokens?: TokenListEntry[];
}

const FETCH_TIMEOUT_MS = 10_000;
/** A logo served from our own origin: a stock logo in public/tokens/, or one we stored. */
const SELF_HOSTED = /^\/tokens\/[A-Za-z0-9_.-]+\.(png|webp|svg)$|^\/api\/logo\/0x[0-9a-f]{40}$/;
/** The curated list in the repository, read when TOKEN_LIST_URL is unset. */
const DEFAULT_LIST = 'config/tokens.json';
/** Data URIs and oversized strings do not belong in a database column. */
const MAX_URL_LENGTH = 512;

/**
 * Only http(s). A token list is third-party data, so a `javascript:` or
 * `data:` URI reaching an `img src` in the browser is an injection vector,
 * not a logo.
 */
export function isSafeLogoUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  // Our own files: the company logos for Robinhood's stock tokens, which
  // scripts/build-stock-logos.py writes to public/tokens/. One directory, one
  // flat file name — no slash, so no way out of it.
  if (SELF_HOSTED.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isHttp(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function fetchList(url: string): Promise<TokenList> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`responded ${response.status}`);
  return (await response.json()) as TokenList;
}

/** A list on disk, relative to the app root unless given absolutely. */
async function readList(path: string): Promise<TokenList> {
  const clean = path.replace(/^file:\/\//, '');
  const full = isAbsolute(clean) ? clean : resolve(process.cwd(), clean);
  return JSON.parse(await readFile(full, 'utf8')) as TokenList;
}

/**
 * Pull the list and record a logo for each token we already know about.
 *
 * Tokens we do not know are ignored rather than inserted: a token row exists
 * because a pool referenced it, and a list should not be able to invent one.
 */
export async function refreshLogos(
  options: { url?: string | null; chainId: number; log?: (m: string) => void } = {
    chainId: 0,
  },
): Promise<number> {
  const url = options.url ?? process.env.TOKEN_LIST_URL ?? DEFAULT_LIST;
  const log = options.log ?? (() => {});
  if (!url) return 0;
  // A URL has to be http(s); a path is taken as a path. Anything else — a
  // `javascript:` or `data:` URI — is neither, and is refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !isHttp(url) && !url.startsWith('file://')) {
    log(`TOKEN_LIST_URL must be an http(s) URL or a path, ignoring it: ${url}`);
    return 0;
  }

  let list: TokenList;
  try {
    list = isHttp(url) ? await fetchList(url) : await readList(url);
  } catch (error) {
    // Silent and total: a logo is decoration and the site works without it.
    log(`token list unavailable (${(error as Error).message}); keeping derived marks`);
    return 0;
  }

  const entries = Array.isArray(list.tokens) ? list.tokens : [];
  const wanted = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry?.address !== 'string') continue;
    // A list covering several chains must not colour this one's tokens with
    // another chain's logos.
    if (typeof entry.chainId === 'number' && entry.chainId !== options.chainId) continue;
    if (!isSafeLogoUrl(entry.logoURI)) continue;
    wanted.set(entry.address.toLowerCase(), entry.logoURI);
  }
  if (wanted.size === 0) return 0;

  // Tokens we know, whose recorded logo differs from the list's. Not just
  // the ones with none: a list is edited, and a corrected logo has to reach
  // the site without someone truncating a table to make it happen.
  const known = await prisma.token.findMany({
    where: { address: { in: [...wanted.keys()] } },
    select: { address: true, logoUrl: true },
  });

  let updated = 0;
  for (const token of known) {
    const next = wanted.get(token.address.toLowerCase());
    if (!next || token.logoUrl === next) continue;
    await prisma.token.update({
      where: { address: token.address },
      data: { logoUrl: next, logoSource: 'list' },
    });
    updated++;
  }
  if (updated > 0) log(`  ${updated} token logo(s) from the token list`);
  return updated;
}
