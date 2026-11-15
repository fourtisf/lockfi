/**
 * Contract errors in plain sentences.
 *
 * A wallet that says `0x8199f5f3` or "execution reverted" has told the user
 * nothing, and a user who does not know whether money moved will assume the
 * worst. Every sentence here says what happened to their funds — almost
 * always "nothing", because the contracts revert rather than fill badly.
 *
 * Names are the custom errors in lib/contracts/abis.ts (TidewellVault,
 * TidewellZap, TidewellShaper). Unknown ones still get a sentence.
 */

const NOTHING = 'Nothing was moved.';

/** A sentence for one decoded custom error. */
export function explainRevert(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    case 'Slippage':
      return `The price moved more than 0.5% before your transaction landed, so it stopped. ${NOTHING} Try again.`;
    case 'InsufficientLiquidity':
      return `The price moved before your transaction landed: it would have added less than 99.5% of the liquidity it was quoted, so it stopped. ${NOTHING} Try again.`;
    case 'PriceOutOfBounds':
      return `The pool's price would have ended more than 0.5% from where it was quoted — it moved, or this deposit is large for the pool's depth. ${NOTHING} Try again, or with a smaller amount.`;
    case 'Expired':
      return `The transaction waited past its 10-minute deadline, so it stopped. ${NOTHING} Try again.`;
    case 'DepositsClosed':
      return `This vault is not taking new deposits. Withdrawing and claiming still work. ${NOTHING}`;
    case 'InsufficientShares':
      return `That is more than you have staked in this vault. ${NOTHING}`;
    case 'ZeroLiquidity':
      return `That amount is too small to add any liquidity. ${NOTHING} Try a larger amount.`;
    case 'WrongValue':
      return `The ETH attached did not match the amount. ${NOTHING} Reload the page and try again.`;
    case 'EmptyBin': {
      const i = Number(args[0] ?? 0);
      return `Bin ${i + 1} would receive no liquidity. ${NOTHING} Deposit more, use fewer bins, or widen the range.`;
    }
    case 'TooManyBins':
      return `${String(args[0] ?? 'That many')} bins is more than the 60 one transaction can mint. ${NOTHING}`;
    case 'NoBins':
      return `The shape has no bins to mint. ${NOTHING}`;
    case 'WeightsMustSumTo10000':
      return `The shape's weights add up to ${String(args[0] ?? '?')} basis points instead of 10,000 — a fault on our side. ${NOTHING}`;
    case 'UnsupportedToken':
      return `This pool does not trade against ETH, so it cannot be entered with ETH. ${NOTHING}`;
    case 'UnsupportedPool':
    case 'PoolNotInitialized':
      return `This pool is not one the vault supports. ${NOTHING}`;
    case 'Insolvent':
      return `The vault could not cover this payment, so it stopped. ${NOTHING} Please report this.`;
    case 'ZeroAddress':
      return `The transaction named no recipient. ${NOTHING}`;
    case 'BadRange':
      return `The destination range is not valid for this pool. ${NOTHING}`;
    case 'BadConfig':
      return `The router settings are outside what the contract allows (cadence at least an hour, slippage 0.01–10%, a TWAP guard above zero). ${NOTHING}`;
    case 'MilestonesNotAscending':
      return `Milestone ${Number(args[0] ?? 0) + 1} is not above the one before it. Milestones must ascend. ${NOTHING}`;
    default:
      return `The contract refused it (${name}). ${NOTHING}`;
  }
}

/** Thrown when a transaction was mined but reverted. */
export class RevertedOnChainError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super(`Transaction ${hash} reverted`);
    this.name = 'RevertedOnChainError';
    this.hash = hash;
  }
}

/**
 * Thrown when a transaction was sent but no receipt arrived in time. It may
 * still land, so the user is pointed at the explorer, never told it failed.
 */
export class UnconfirmedError extends Error {
  readonly hash: string;
  constructor(hash: string, cause?: unknown) {
    super(`Transaction ${hash} not confirmed yet`, { cause });
    this.name = 'UnconfirmedError';
    this.hash = hash;
  }
}

interface ErrorLike {
  name?: string;
  code?: number | string;
  message?: string;
  shortMessage?: string;
  reason?: string;
  cause?: unknown;
  data?: { errorName?: string; args?: readonly unknown[] } | unknown;
}

/** The error and every cause beneath it, outermost first. */
function chain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === 'object'; i++) {
    out.push(cur as ErrorLike);
    cur = (cur as ErrorLike).cause;
  }
  return out;
}

/**
 * A sentence for anything a wallet, viem or wagmi can throw at a signing
 * flow. Walks the cause chain, so a revert decoded three wrappers deep is
 * still found.
 */
export function explainError(err: unknown): string {
  const errors = chain(err);

  if (errors.some((e) => e.name === 'UnconfirmedError')) {
    return 'It was sent, but no confirmation has arrived yet. Check the explorer before trying again.';
  }
  if (errors.some((e) => e.name === 'RevertedOnChainError')) {
    return 'It reverted on chain. Nothing changed except the gas it used.';
  }
  if (
    errors.some(
      (e) =>
        e.name === 'UserRejectedRequestError' || e.code === 4001 || e.code === 'ACTION_REJECTED',
    )
  ) {
    return 'You cancelled it in your wallet. Nothing was sent.';
  }

  const revert = errors.find((e) => e.name === 'ContractFunctionRevertedError');
  if (revert) {
    const data = revert.data as { errorName?: string; args?: readonly unknown[] } | undefined;
    if (data?.errorName && data.errorName !== 'Error' && data.errorName !== 'Panic') {
      return explainRevert(data.errorName, data.args ?? []);
    }
    if (revert.reason) return `The contract refused it: ${revert.reason}. ${NOTHING}`;
    return `The contract refused it. ${NOTHING}`;
  }

  if (errors.some((e) => e.name === 'InsufficientFundsError')) {
    return 'Your wallet does not have enough ETH for this amount plus gas. Nothing was sent.';
  }
  if (errors.some((e) => /ChainMismatch/.test(e.name ?? ''))) {
    return 'Your wallet is on another network. Switch to Robinhood Chain and try again. Nothing was sent.';
  }
  if (errors.some((e) => /ConnectorNotConnected|ConnectorAccountNotFound/.test(e.name ?? ''))) {
    return 'Your wallet is not connected. Connect it and try again. Nothing was sent.';
  }
  if (errors.some((e) => e.name === 'ExecutionRevertedError')) {
    return `The transaction would fail on chain, so it was not sent. ${NOTHING}`;
  }
  if (errors.some((e) => e.name === 'HttpRequestError' || e.name === 'TimeoutError')) {
    return 'Robinhood Chain did not answer. Nothing was sent. Try again in a moment.';
  }

  const first = errors[0];
  const text = first?.shortMessage ?? first?.message;
  return text ? `${text.split('\n')[0]}` : 'Something went wrong. Nothing was sent.';
}
