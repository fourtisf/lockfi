/**
 * The keeper's constants, and the one secret in the system.
 *
 * The keeper drives routers only (P4). Vaults need no keeper: they credit
 * fees per share whenever anyone deposits, withdraws, claims or pokes, and
 * pay them in the pool's own two tokens, so there is nothing to harvest,
 * convert or stream.
 *
 * KEEPER_PRIVATE_KEY is read once, never logged, never put into an error
 * message, and deleted from process.env as soon as the account is derived,
 * so nothing later — a child process, an env dump in a crash report — can
 * carry it further. A missing or malformed key makes the keeper refuse to
 * sign and say why; it never exits over it, because PM2 restarting a process
 * that exits on a configuration error is a crash loop that fixes nothing
 * (§17: 8,086 restarts once).
 */

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/** A transaction deadline: now + this, as a timestamp (§2: never a block number). */
export const DEADLINE_SECONDS = 300;
/**
 * A router is poked when its newest observation is at least this old.
 *
 * Its 30-minute TWAP needs six observations at least a minute apart inside
 * the window (TidewellRouter.MIN_TWAP_SAMPLES). Poked exactly every five
 * minutes that is six with nothing to spare, and the keeper's one-minute loop
 * drifts a poke to 5m59s at worst — five samples, and every route reverts
 * TwapUnavailable. Four minutes leaves a sample of margin.
 */
export const POKE_INTERVAL_SECONDS = 240;
/** The router's own TWAP window (TidewellRouter.TWAP_WINDOW). */
export const ROUTER_TWAP_WINDOW_SECONDS = 30 * 60;
/** Seconds between keeper passes over every router. */
export const LOOP_SECONDS = 60;
/** How long to wait for a sent transaction's receipt before calling it unknown. */
export const RECEIPT_TIMEOUT_MS = 120_000;

/** "6h", "40m", "90s": an interval in words for a log line or a health message. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s}s`;
  if (s < 2 * 3600) return `${Math.round(s / 60)}m`;
  if (s < 3 * 86_400) return `${Math.round(s / 360) / 10}h`;
  return `${Math.round(s / 8640) / 10}d`;
}

export type SignerResult =
  | { account: PrivateKeyAccount; problem: null }
  | { account: null; problem: string };

/**
 * The signing account from KEEPER_PRIVATE_KEY, or why there is none.
 *
 * The key is removed from the environment whatever happens next. A malformed
 * key is reported by its SHAPE only — its length and whether it had a 0x —
 * never by any of its characters.
 */
export function readSigner(source: Record<string, string | undefined> = process.env): SignerResult {
  const raw = source.KEEPER_PRIVATE_KEY;
  delete source.KEEPER_PRIVATE_KEY;
  if (raw === undefined || raw.trim() === '') {
    return {
      account: null,
      problem:
        'KEEPER_PRIVATE_KEY is not set, so the keeper cannot sign: no router is poked or routed. ' +
        'Set it in .env (a dedicated hot wallet holding only gas) and restart balast-keeper.',
    };
  }
  const trimmed = raw.trim();
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return {
      account: null,
      problem:
        `KEEPER_PRIVATE_KEY is set but is not a 32-byte hex key (it is ${trimmed.length} characters` +
        `${trimmed.startsWith('0x') ? ', starting 0x' : ''}). The keeper will not sign until it is fixed.`,
    };
  }
  try {
    return { account: privateKeyToAccount(`0x${hex}`), problem: null };
  } catch {
    // Not the library's message: it could quote the input.
    return { account: null, problem: 'KEEPER_PRIVATE_KEY could not be turned into an account. The keeper will not sign.' };
  }
}
