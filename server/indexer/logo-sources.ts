/**
 * Token logos from the explorers and aggregators that already have them.
 *
 * Robinhood Chain has no public token list, so `config/tokens.json` alone
 * left almost every token on its derived mark. Three services do know this
 * chain's tokens, keyed by address, and between them cover most of what
 * trades here:
 *
 *   GeckoTerminal   CoinGecko's images. `data[].attributes.image_url`, null
 *                   when it has none. Tight rate limit: 429 after a handful
 *                   of calls in a burst.
 *   DexScreener     images a project registered with its token profile.
 *                   `[].info.imageUrl`, which belongs to the pair's
 *                   `baseToken` only.
 *   Blockscout      the chain's official explorer. `icon_url`, one token per
 *                   call. Unknown tokens answer 403 `{"message":"Not found"}`,
 *                   and every call needs a User-Agent or it is refused.
 *
 * Those shapes were read off the live APIs on 2026-11-14, for real tokens on
 * this chain (CASHCAT, ESTR, PONS, USDG, WETH), not assumed.
 *
 * The same two rules as `logos.ts`, because they are §4's rules:
 *
 *   ONLY the image URL is taken. Every one of these responses also carries
 *   prices, volumes and supplies, and none of it is read — numbers come from
 *   chain events and nowhere else.
 *
 *   Failure is silent and changes no number. A source that is down or
 *   rate-limited leaves its tokens to be asked again later; a token no source
 *   has a logo for keeps the mark derived from its own address.
 *
 * A curated logo (`config/tokens.json`) always wins: this only fills tokens
 * that have no logo at all, and never replaces one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CHAIN } from '../../lib/chain';
import { prisma } from '../db';
import { launchpad } from './launchpad-logos';
import { isSafeLogoUrl } from './logos';

/** One lookup's answer for one token. */
export type LogoAnswer =
  /** The source has a logo for it. */
  | { kind: 'found'; url: string }
  /** The source answered and has none. */
  | { kind: 'none' }
  /** The source could not answer — down, rate-limited, malformed. */
  | { kind: 'error' };

export interface LogoSource {
  name: 'launchpad' | 'geckoterminal' | 'dexscreener' | 'blockscout';
  /** Addresses per call. */
  batch: number;
  lookup(addresses: string[]): Promise<Map<string, LogoAnswer>>;
}

/** GET a JSON document; the HTTP status comes back alongside the body. */
export type FetchJson = (url: string) => Promise<{ status: number; body: unknown }>;

const TIMEOUT_MS = 10_000;
/** Blockscout refuses a request with no User-Agent. Generic on purpose. */
const USER_AGENT = 'Mozilla/5.0 (compatible; tidewell-indexer)';

export const defaultFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body (an HTML error page) is read as no body at all.
  }
  return { status: response.status, body };
};

/** Placeholder art some services return in place of null. */
function isPlaceholder(url: string): boolean {
  return /missing(\.png|_|-)|\/missing$/i.test(url);
}

function usable(url: unknown): url is string {
  return isSafeLogoUrl(url) && !isPlaceholder(url);
}

function allAs(addresses: string[], answer: LogoAnswer): Map<string, LogoAnswer> {
  return new Map(addresses.map((a) => [a, answer]));
}

export function geckoTerminal(
  fetchJson: FetchJson = defaultFetchJson,
  network = process.env.LOGO_GECKOTERMINAL_NETWORK ?? 'robinhood',
): LogoSource {
  return {
    name: 'geckoterminal',
    batch: 30,
    async lookup(addresses) {
      try {
        const { status, body } = await fetchJson(
          `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/multi/${addresses.join(',')}`,
        );
        if (status !== 200) return allAs(addresses, { kind: 'error' });
        const data = (body as { data?: unknown })?.data;
        if (!Array.isArray(data)) return allAs(addresses, { kind: 'error' });
        // Answered: anything it did not mention, it does not know.
        const out = allAs(addresses, { kind: 'none' });
        for (const item of data) {
          const attributes = (item as { attributes?: Record<string, unknown> })?.attributes;
          const address = typeof attributes?.address === 'string' ? attributes.address.toLowerCase() : null;
          if (address && out.has(address) && usable(attributes?.image_url)) {
            out.set(address, { kind: 'found', url: attributes.image_url as string });
          }
        }
        return out;
      } catch {
        return allAs(addresses, { kind: 'error' });
      }
    },
  };
}

export function dexScreener(
  fetchJson: FetchJson = defaultFetchJson,
  chain = process.env.LOGO_DEXSCREENER_CHAIN ?? 'robinhood',
): LogoSource {
  return {
    name: 'dexscreener',
    batch: 30,
    async lookup(addresses) {
      try {
        const { status, body } = await fetchJson(
          `https://api.dexscreener.com/tokens/v1/${chain}/${addresses.join(',')}`,
        );
        if (status !== 200 || !Array.isArray(body)) return allAs(addresses, { kind: 'error' });
        const out = allAs(addresses, { kind: 'none' });
        for (const pair of body as Record<string, unknown>[]) {
          if (pair?.chainId !== undefined && pair.chainId !== chain) continue;
          // The image is the BASE token's. A pair listed under its quote
          // token's address must not paint WETH with a memecoin's face.
          const base = (pair?.baseToken as { address?: unknown } | undefined)?.address;
          const image = (pair?.info as { imageUrl?: unknown } | undefined)?.imageUrl;
          if (typeof base !== 'string') continue;
          const address = base.toLowerCase();
          if (out.get(address)?.kind === 'none' && usable(image)) {
            out.set(address, { kind: 'found', url: image });
          }
        }
        return out;
      } catch {
        return allAs(addresses, { kind: 'error' });
      }
    },
  };
}

export function blockscout(
  fetchJson: FetchJson = defaultFetchJson,
  base = process.env.LOGO_BLOCKSCOUT_URL ?? 'https://robinhoodchain.blockscout.com',
): LogoSource {
  return {
    name: 'blockscout',
    batch: 1,
    async lookup(addresses) {
      const out = new Map<string, LogoAnswer>();
      for (const address of addresses) {
        try {
          const { status, body } = await fetchJson(`${base}/api/v2/tokens/${address}`);
          const message = (body as { message?: unknown } | null)?.message;
          if (status === 200) {
            const icon = (body as { icon_url?: unknown } | null)?.icon_url;
            out.set(address, usable(icon) ? { kind: 'found', url: icon } : { kind: 'none' });
          } else if ((status === 403 || status === 404) && message === 'Not found') {
            // How this explorer says it does not know the token.
            out.set(address, { kind: 'none' });
          } else {
            out.set(address, { kind: 'error' });
          }
        } catch {
          out.set(address, { kind: 'error' });
        }
      }
      return out;
    },
  };
}

/**
 * Robinhood's stock tokens, as its factory recorded them on chain
 * (config/robinhood-stocks.json, written by scripts/build-stock-logos.py).
 */
export interface StockRegistry {
  addresses: Set<string>;
  /** Tickers of three letters or more: short ones (F, V, ON) are ordinary words. */
  tickers: Set<string>;
}

export function loadRegistry(
  path = process.env.ROBINHOOD_STOCKS ?? 'config/robinhood-stocks.json',
): StockRegistry | null {
  const full = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(full)) return null;
  try {
    const doc = JSON.parse(readFileSync(full, 'utf8')) as {
      stocks?: { address?: string; symbol?: string }[];
    };
    const stocks = Array.isArray(doc.stocks) ? doc.stocks : [];
    return {
      addresses: new Set(stocks.map((s) => String(s.address).toLowerCase())),
      tickers: new Set(
        stocks.map((s) => String(s.symbol ?? '').toUpperCase()).filter((t) => t.length >= 3),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Take every logo off tokens that pass themselves off as Robinhood stock
 * tokens without being in the factory's registry, and keep them off.
 *
 * The board showed an "SPCX … Robinhood Token" the factory never made,
 * wearing Robinhood's feather — supplied by a logo source, because a copy's
 * creator can register any image. Matching logos by address cannot stop
 * that: the address is the copy's own. What can is knowing which addresses
 * are Robinhood's. A token claiming the name ("Robinhood Token") or an
 * official ticker of three letters or more, and not in the registry, gets
 * no logo from any source, ever. A logo a person put in the curated list is
 * the one exception: a human decided.
 */
export async function stripImpostors(registry: StockRegistry): Promise<number> {
  return prisma.$executeRaw`
    UPDATE tokens
    SET logo_url = NULL, logo_source = 'impostor', logo_retry_at = NULL
    WHERE NOT (lower(address) = ANY(${[...registry.addresses]}))
      AND (upper(symbol) = ANY(${[...registry.tickers]}) OR name ILIKE '%robinhood%token%')
      AND logo_source IS DISTINCT FROM 'impostor'
      AND logo_source IS DISTINCT FROM 'list'
  `;
}

/**
 * Priority order. The token's own on-chain declaration first (launchpad
 * tokens — most of the boards — and nobody else can add one), then
 * CoinGecko's curation, then images projects registered, the explorer last.
 */
export function defaultLogoSources(fetchJson: FetchJson = defaultFetchJson): LogoSource[] {
  return [launchpad(), geckoTerminal(fetchJson), dexScreener(fetchJson), blockscout(fetchJson)];
}

/** No source has one: ask again in a day, in case a project registers one. */
export const RETRY_NONE_MS = 24 * 3600_000;
/** A source could not answer: ask again soon. */
export const RETRY_ERROR_MS = 30 * 60_000;
/** Tokens looked up per sweep. One GeckoTerminal call's worth. */
export const SWEEP_SIZE = 30;

/**
 * The tokens most worth a logo that do not have one and are due a look.
 *
 * Never-looked-at first, then by what they traded in the last 24 hours of
 * indexed time, then by all-time swaps. Recent volume is what puts a row at
 * the top of the boards, so those rows get their logos first; ordering by
 * all-time swaps alone left a token four hours old and third on Trending
 * waiting behind hundreds of quiet old ones.
 */
async function dueTokens(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ address: string }[]>`
    WITH head AS (SELECT MAX(hour) AS h FROM pool_fee_hourly),
    sides AS (
      SELECT id, token0 AS address FROM pools
      UNION ALL
      SELECT id, token1 AS address FROM pools
    ),
    activity AS (
      SELECT s.address,
             SUM(f.swaps)::bigint AS swaps,
             SUM(CASE WHEN f.hour > head.h - interval '24 hours' THEN f.volume_usd ELSE 0 END) AS recent
      FROM sides s
      JOIN pool_fee_hourly f ON f.pool_id = s.id
      CROSS JOIN head
      GROUP BY s.address
    )
    SELECT t.address
    FROM tokens t
    LEFT JOIN activity a ON a.address = t.address
    WHERE t.logo_url IS NULL
      AND t.logo_source IS DISTINCT FROM 'impostor'
      -- Recorded but never read: a launch that has not traded in the window.
      AND t.decimals >= 0
      AND (t.logo_retry_at IS NULL OR t.logo_retry_at <= ${now})
    ORDER BY (t.logo_retry_at IS NOT NULL), COALESCE(a.recent, 0) DESC, COALESCE(a.swaps, 0) DESC, t.address
    LIMIT ${limit}
  `;
  return rows.map((r) => r.address.toLowerCase());
}

export interface SweepResult {
  looked: number;
  found: number;
  bySource: Record<string, number>;
}

/**
 * Look up logos for the tokens most in need of one, through each source in
 * turn, and record what was found.
 *
 * A token found by an earlier source is not asked of a later one. A token no
 * source has a logo for is retried in a day; one that any source failed to
 * answer for is retried in half an hour, so a rate limit delays a logo
 * rather than losing it.
 */
export async function sweepLogos(
  options: {
    now?: Date;
    sources?: LogoSource[];
    size?: number;
    log?: (m: string) => void;
    /** Override for tests; null skips the impostor rule. */
    registry?: StockRegistry | null;
  } = {},
): Promise<SweepResult> {
  if (process.env.LOGO_SOURCES === 'off' || CHAIN.id !== 4663) {
    return { looked: 0, found: 0, bySource: {} };
  }
  const now = options.now ?? new Date();
  const sources = options.sources ?? defaultLogoSources();
  const log = options.log ?? (() => {});

  // Before anything is looked up: no impostor is asked about, and none keeps
  // a logo it was given before this rule existed.
  const registry = options.registry === undefined ? loadRegistry() : options.registry;
  if (registry) {
    const stripped = await stripImpostors(registry);
    if (stripped > 0) log(`  ${stripped} impostor(s) of Robinhood stock tokens: logos removed`);
  }

  const due = await dueTokens(now, options.size ?? SWEEP_SIZE);
  const result: SweepResult = { looked: due.length, found: 0, bySource: {} };
  if (due.length === 0) return result;

  const found = new Map<string, { url: string; source: string }>();
  const failed = new Set<string>();

  for (const source of sources) {
    const remaining = due.filter((a) => !found.has(a));
    if (remaining.length === 0) break;
    for (let i = 0; i < remaining.length; i += source.batch) {
      const chunk = remaining.slice(i, i + source.batch);
      const answers = await source.lookup(chunk);
      for (const address of chunk) {
        const answer = answers.get(address) ?? { kind: 'error' as const };
        if (answer.kind === 'found') found.set(address, { url: answer.url, source: source.name });
        else if (answer.kind === 'error') failed.add(address);
      }
    }
  }

  for (const address of due) {
    const hit = found.get(address);
    if (hit) {
      // Only where there is still no logo: a curated one that arrived while
      // this sweep was asking always wins.
      await prisma.token.updateMany({
        where: { address, logoUrl: null },
        data: { logoUrl: hit.url, logoSource: hit.source, logoRetryAt: null },
      });
      result.found++;
      result.bySource[hit.source] = (result.bySource[hit.source] ?? 0) + 1;
    } else {
      const wait = failed.has(address) ? RETRY_ERROR_MS : RETRY_NONE_MS;
      await prisma.token.update({
        where: { address },
        data: { logoRetryAt: new Date(now.getTime() + wait) },
      });
    }
  }

  if (result.found > 0) {
    const detail = Object.entries(result.bySource)
      .map(([name, n]) => `${n} from ${name}`)
      .join(', ');
    log(`  ${result.found} token logo(s): ${detail}`);
  }
  return result;
}
