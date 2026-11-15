/**
 * Contract reverts, in sentences an operator can act on.
 *
 * Every keeper_runs row that did not succeed carries one of these as its
 * reason, and /api/health repeats the latest. "execution reverted" tells the
 * person reading the health page nothing; "the router has under 30 minutes of
 * its own price history — clears on its own as the keeper pokes it" tells
 * them whether to do anything at all.
 */

import { formatEther } from 'viem';

export interface DecodedRevert {
  name: string;
  args: readonly unknown[];
}

interface ErrorLike {
  name?: string;
  message?: string;
  shortMessage?: string;
  cause?: unknown;
  data?: { errorName?: string; args?: readonly unknown[] };
}

/** The error and every cause beneath it, outermost first. */
function causes(error: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = error;
  for (let i = 0; i < 12 && current && typeof current === 'object'; i++) {
    out.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return out;
}

/**
 * The custom error a simulation or call reverted with, decoded against the
 * contract's ABI by viem (ContractFunctionRevertedError), or null when the
 * failure was not a contract revert — a timeout, a refused request.
 */
export function decodeRevert(error: unknown): DecodedRevert | null {
  for (const e of causes(error)) {
    if (e.name === 'ContractFunctionRevertedError' && e.data?.errorName) {
      return { name: e.data.errorName, args: e.data.args ?? [] };
    }
  }
  return null;
}

/** A one-line, bounded summary of any error, for a run's reason. */
export function errorSummary(error: unknown): string {
  const e = error as ErrorLike;
  const text = e?.shortMessage ?? e?.message ?? String(error);
  return text.split('\n')[0].slice(0, 300);
}

const eth = (wei: unknown) => {
  try {
    return `${Number(formatEther(BigInt(wei as bigint))).toPrecision(6)} WETH`;
  } catch {
    return String(wei);
  }
};

/** A sentence for one decoded revert of a router poke or route. */
export function revertSentence(revert: DecodedRevert): string {
  const [a, b] = revert.args;
  switch (revert.name) {
    case 'Slippage':
      return `the route's swap would buy ${String(a)} of the token, under the ${String(b)} its 30-minute TWAP allows (Slippage) — not routed at a bad price`;
    case 'TwapUnavailable':
      return 'the router has under 30 minutes of its own price history (it needs six observations a minute apart); the keeper pokes it every few minutes, so this clears on its own (TwapUnavailable)';
    case 'TwapDeviation':
      return `the pool's spot tick ${String(a)} is further from the router's 30-minute average ${String(b)} than its guard allows (TwapDeviation) — a price pushed around just now is not routed into`;
    case 'NotDue':
      return 'the router is not due yet (NotDue)';
    case 'NoMilestoneReached':
      return `the token's FDV of ${eth(a)} is below the next milestone of ${eth(b)} (NoMilestoneReached)`;
    case 'NothingToRoute':
      return "there is no WETH waiting, or less than the router's minimum (NothingToRoute)";
    case 'IsPaused':
      return 'the router is paused by its owner (IsPaused)';
    case 'NotKeeper':
      return "the signer is not this contract's keeper (NotKeeper)";
    case 'Expired':
      return 'the deadline passed before the transaction could land (Expired)';
    case 'Reentrancy':
      return 'the contract refused a re-entrant call (Reentrancy)';
    default:
      return `the contract refused it (${revert.name}${revert.args.length ? `: ${revert.args.map(String).join(', ')}` : ''})`;
  }
}
