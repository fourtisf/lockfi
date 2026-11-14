/**
 * Where this front-end lives. One place, because the canonical URL shows up in
 * metadata, Open Graph cards, the nginx config and every link we ever print.
 */

/** The product's name, everywhere it is printed (§19). */
export const BRAND = 'Tidewell';

/**
 * The apex domain. No protocol, no trailing slash.
 *
 * Still the Balast domain: the product was renamed Tidewell (§19) and no
 * Tidewell domain has been registered yet. Change this one line when one is,
 * together with deploy/nginx.conf.
 */
export const DOMAIN = 'balast.xyz';

export const SITE_URL = `https://${DOMAIN}`;

/**
 * Spellings a user might type instead. Each one should be registered and
 * 301'd to DOMAIN — an unowned confusable is a phishing domain someone else
 * gets to point at a wallet drainer.
 *
 * `ballast.xyz`, the English spelling on this same TLD, is NOT ours: it is
 * registered and parked for sale by a third party. Until that is acquired,
 * this is the one real gap in the setup. See deploy/nginx.conf.
 */
export const DEFENSIVE_DOMAINS = ['www.balast.xyz'] as const;
