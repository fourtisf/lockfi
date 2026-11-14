/**
 * Where this front-end lives. One place, because the canonical URL shows up in
 * metadata, Open Graph cards, the nginx config and every link we ever print.
 */

/** The product's name, everywhere it is printed (§19). */
export const BRAND = 'Tidewell';

/**
 * The apex domain. No protocol, no trailing slash. Registered for Tidewell
 * (§19); the old balast.xyz 301s here (deploy/nginx.conf).
 */
export const DOMAIN = 'tidewell.live';

export const SITE_URL = `https://${DOMAIN}`;

/**
 * Spellings a user might type instead. Each one should be registered and
 * 301'd to DOMAIN — an unowned confusable is a phishing domain someone else
 * gets to point at a wallet drainer.
 *
 * `tidewall.live` is the obvious one: wall for well. It is not registered yet;
 * until it is, it is the one real gap. See deploy/nginx.conf.
 */
export const DEFENSIVE_DOMAINS = ['www.tidewell.live'] as const;

/** Served before the rename; redirects here, path preserved. */
export const LEGACY_DOMAINS = ['balast.xyz', 'www.balast.xyz'] as const;
