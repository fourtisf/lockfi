/** Past this the figures are not "a little behind": they describe another day. */
export const STALE_BANNER_SECONDS = 6 * 3600;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "8 Jul 2026", in UTC, by hand: the server and the browser must print the same string. */
export function asOfDate(lagSeconds: number, now = Date.now()): string {
  const d = new Date(now - lagSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
