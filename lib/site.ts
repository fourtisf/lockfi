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

/** Tidewell's one official X account. */
export const X_HANDLE = '@usetidewell';
export const X_URL = 'https://x.com/usetidewell';

/** Tidewell's official Telegram channel. */
export const TELEGRAM_URL = 'https://t.me/tidewellchannel';
export const TELEGRAM_LABEL = 't.me/tidewellchannel';

/**
 * The token's contract address (CA), once there is one. `null` means not
 * launched, and the site says "CA: Coming soon".
 *
 * Set it here and only here: every place that prints the CA reads this
 * constant. Scammers post fake CAs around every launch, so the one on this
 * site must never drift between copies.
 *
 * TIDEWELL (symbol TIDEWELL, 18 decimals, 1,000,000,000 supply), read from
 * the contract on Robinhood Chain before it was set here. Checksummed;
 * lib/site.test.ts fails on a mistyped character.
 */
export const TOKEN_CA: `0x${string}` | null = '0x0040dbfd23df97c06FB9A73B59E298D7e5BcE198';

/**
 * Where the token trades before it has a Uniswap pool: Pons's bonding curve.
 * Read on chain when this was written (§30): the curve at `curve` answers
 * `token()` with TOKEN_CA, held all 1,000,000,000 tokens at `launchBlock`,
 * and prices with `getReserves()` = (real ETH + 1.68 ETH virtual, tokens).
 * server/api/token-curve.ts reads it and checks itself against it. `null`
 * hides the token card.
 */
export const TOKEN_LAUNCH: {
  symbol: string;
  launchpad: string;
  url: string;
  curve: `0x${string}`;
  launchBlock: number;
  supply: number;
  /** The curve's virtual ETH reserve, in wei: getReserves().eth minus the curve's balance. */
  virtualEthWei: string;
} | null = {
  symbol: 'TIDEWELL',
  launchpad: 'Pons',
  url: 'https://ponsfamily.com/launchpad/0x0040dbfd23df97c06fb9a73b59e298d7e5bce198',
  curve: '0x0659C0E302EBC742bE9FF0d07ae7bB222ADf7bf9',
  launchBlock: 115623898,
  supply: 1_000_000_000,
  virtualEthWei: '1680000000000000000',
};
