/**
 * Where this front-end lives. One place, because the canonical URL shows up in
 * metadata, Open Graph cards, the nginx config and every link we ever print.
 */

/**
 * The product's name, in one place: the navigation, the footer, page titles
 * and link previews read it from here (§39).
 */
export const BRAND = 'LockFi';

/** The apex domain. No protocol, no trailing slash. */
export const DOMAIN = 'lockfi.org';

export const SITE_URL = `https://${DOMAIN}`;

/**
 * Where the site used to live. balast.xyz 301s to DOMAIN (deploy/nginx.conf),
 * and the database still holds logo URLs recorded under it, so a URL on one
 * of these is still one of our own files (§39).
 */
export const LEGACY_SITE_URLS = ['https://balast.xyz'] as const;

/**
 * The same-origin path of a URL on this site, the current domain or a former
 * one; null for anybody else's URL. A relative path is already one.
 */
export function ownSitePath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return url;
  for (const origin of [SITE_URL, ...LEGACY_SITE_URLS]) {
    if (url.startsWith(`${origin}/`)) return url.slice(origin.length);
  }
  return null;
}

/**
 * Hosts that 301 to DOMAIN. An unowned confusable is a phishing domain
 * someone else gets to point at a wallet drainer.
 *
 * `lockfi.com` is NOT ours: it is parked for sale by a third party, and it is
 * what a person typing the name reaches by default. Acquiring it is the one
 * real gap in the setup. See deploy/nginx.conf.
 */
export const DEFENSIVE_DOMAINS = ['www.lockfi.org', 'balast.xyz', 'www.balast.xyz'] as const;

/**
 * Where the project talks.
 *
 * X, @lockfiorg, and the Telegram group, t.me/lockfiorg: the two accounts
 * the owner named.
 *
 * Each link is a constant, deliberately not an environment variable. It was
 * one, and the live site went out pointing at `x.com/HANDLE_ANDA` — a
 * placeholder typed into the box's .env by hand — while the code carried
 * the real account as a default the placeholder overrode. A fact this
 * public belongs in the repository, where a change is a reviewed commit.
 *
 * The token's contract address is not announced yet (§43). Until it is,
 * the top bar and the footer read "CA · coming soon", and /learn says any
 * address circulating as LockFi's before it appears on this site is not ours.
 */
export const SOCIAL = {
  x: 'https://x.com/lockfiorg',
  telegram: 'https://t.me/lockfiorg',
} as const;

/**
 * LockFi's token contract address, once it is announced. A constant for the
 * same reason as the X link: a stale value in the box's .env must never be
 * able to point the site at the wrong token. null reads "coming soon".
 */
export const TOKEN_CA: `0x${string}` | null = '0x2Cc477Fb4Fb0E63CcF5A3673C1628eDc1007B734';

/** The X handle, for the site's own metadata; derived so it cannot disagree with the link. */
export const X_HANDLE = `@${SOCIAL.x.replace(/\/+$/, '').split('/').pop()}`;

/**
 * Where the API lives, from the browser's point of view. Empty means the
 * same origin, which is the deployed shape: nginx proxies `/api/` to the
 * Fastify process. Set only for local development against `next dev`.
 */
export const API_BASE =
  (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';

/**
 * A token's logo, served by our own API rather than fetched by the browser
 * from wherever the source found it.
 *
 * The board once showed four empty discs: URLs that loaded from the box and
 * not from a browser — a host that answers a server and refuses a page, or
 * the other way round. Routing every logo through `/api/logo/{address}`
 * makes "the box can load it" and "the page shows it" the same test, and
 * lets the API cache the bytes so a hundred badges cost the source nothing.
 */
export function logoProxy(address: string): string {
  return `${API_BASE}/api/logo/${address.toLowerCase()}`;
}
