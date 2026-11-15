import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  encodeErrorResult,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { tidewellShaperAbi, tidewellVaultAbi, tidewellZapAbi } from './abis';
import { RevertedOnChainError, UnconfirmedError, explainError, explainRevert } from './errors';

/** A revert as viem actually delivers it from a simulate or a write. */
function revert(abi: typeof tidewellZapAbi | typeof tidewellVaultAbi | typeof tidewellShaperAbi, errorName: string, args?: readonly unknown[]) {
  const data = encodeErrorResult({ abi, errorName, args } as unknown as Parameters<typeof encodeErrorResult>[0]);
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: 'zapStake' });
  return new ContractFunctionExecutionError(cause, {
    abi,
    functionName: 'zapStake',
    args: [],
    contractAddress: '0x0000000000000000000000000000000000000001',
  });
}

describe('explainError', () => {
  it('decodes a custom error three wrappers deep', () => {
    const msg = explainError(revert(tidewellZapAbi, 'InsufficientLiquidity', [100n, 200n]));
    expect(msg).toMatch(/99\.5%/);
    expect(msg).toMatch(/Nothing was moved/);
  });

  it('says which bin is empty, counting from one', () => {
    expect(explainError(revert(tidewellShaperAbi, 'EmptyBin', [4n]))).toMatch(/^Bin 5 /);
  });

  it('explains every vault error a staker can hit', () => {
    for (const name of ['Slippage', 'Expired', 'DepositsClosed', 'InsufficientShares', 'WrongValue', 'ZeroLiquidity']) {
      const msg = explainError(revert(tidewellVaultAbi, name));
      expect(msg, name).not.toMatch(/refused it \(/);
      expect(msg, name).toMatch(/Nothing was moved/);
    }
  });

  it('treats a wallet rejection as a cancel, not a failure', () => {
    expect(explainError(new UserRejectedRequestError(new Error('User rejected')))).toMatch(/cancelled/);
    expect(explainError({ code: 4001, message: 'rejected' })).toMatch(/cancelled/);
  });

  it('says when the wallet cannot cover the amount plus gas', () => {
    expect(explainError(new InsufficientFundsError({ cause: new Error('x') as never }))).toMatch(/enough ETH/);
  });

  it('says a mined revert cost gas and moved nothing else', () => {
    expect(explainError(new RevertedOnChainError('0xabc'))).toMatch(/gas it used/);
  });

  it('never calls a sent transaction failed just because its receipt is slow', () => {
    const msg = explainError(new UnconfirmedError('0xabc', new Error('timed out')));
    expect(msg).toMatch(/was sent/);
    expect(msg).toMatch(/explorer/);
  });

  it('always returns a sentence', () => {
    expect(explainError(undefined)).toMatch(/Nothing was sent/);
    expect(explainError(new Error('boom\nstack'))).toBe('boom');
  });
});

describe('explainRevert', () => {
  it('names an unknown error rather than hiding it', () => {
    expect(explainRevert('Mystery')).toMatch(/\(Mystery\)/);
  });
  it('quotes the bad weight sum', () => {
    expect(explainRevert('WeightsMustSumTo10000', [9999n])).toMatch(/9999 basis points/);
  });
});
