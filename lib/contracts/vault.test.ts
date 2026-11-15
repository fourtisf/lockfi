import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { tidewellVaultAbi } from './abis';
import { VAULT_FUNCTIONS, ethIndexOf, ethIsNative, parseWalletReads, poolIdOf, vaultAbi } from './vault';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as const;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as const;

describe('poolIdOf', () => {
  it("matches the chain's own id for native ETH / USDG 0.05%", () => {
    // Read from the vault's poolId() on a fork of Robinhood Chain mainnet.
    expect(poolIdOf({ currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress })).toBe(
      '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982',
    );
  });
});

describe('ethIndexOf / ethIsNative', () => {
  it('finds the ETH side, native or WETH', () => {
    expect(ethIndexOf({ currency0: zeroAddress, currency1: USDG })).toBe(0);
    expect(ethIndexOf({ currency0: WETH, currency1: USDG })).toBe(0);
    expect(ethIndexOf({ currency0: USDG, currency1: WETH })).toBe(1);
    // A vault needs no ETH side; entering one with ETH does.
    expect(ethIndexOf({ currency0: USDG, currency1: `0x${'ee'.repeat(20)}` })).toBeNull();
    expect(ethIsNative({ currency0: zeroAddress })).toBe(true);
    expect(ethIsNative({ currency0: WETH })).toBe(false);
  });
});

describe('parseWalletReads', () => {
  const deployment = { address: `0x${'22'.repeat(20)}` as `0x${string}`, poolId: 'v4:0x', deployedBlock: 0 };
  const key = { currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress };

  it('turns the four reads into a stake', () => {
    const out = parseWalletReads(deployment, [
      { status: 'success', result: 10n },
      { status: 'success', result: 40n },
      { status: 'success', result: [3n, 4n] },
      { status: 'success', result: key },
    ]);
    expect(out).toMatchObject({ shares: 10n, totalSupply: 40n, claimable0: 3n, claimable1: 4n, ethIndex: 0 });
  });

  it('shows nothing for a vault read half-way', () => {
    expect(
      parseWalletReads(deployment, [
        { status: 'success', result: 10n },
        { status: 'failure', error: new Error('x') },
        { status: 'success', result: [3n, 4n] },
        { status: 'success', result: key },
      ]),
    ).toBeNull();
  });
});

/**
 * The site declares the vault functions it calls (vault.ts). Once abis.ts is
 * regenerated from the per-share vault, every one must exist there with the
 * same inputs and outputs. Until then the generated ABI is the old stream
 * vault (it still has `earned`), and this waits for it.
 */
type Item = { type: string; name?: string; inputs?: readonly { type: string }[]; outputs?: readonly { type: string }[] };
const generated = tidewellVaultAbi as readonly Item[];
const regenerated = !generated.some((x) => x.type === 'function' && x.name === 'earned');

describe('vaultAbi against the generated ABI', () => {
  it.skipIf(!regenerated)('declares only functions the contract has, with the same types', () => {
    const shape = (x: Item) =>
      JSON.stringify([x.inputs?.map((i) => i.type), x.outputs?.map((o) => o.type)]);
    for (const name of VAULT_FUNCTIONS) {
      const ours = (vaultAbi as readonly Item[]).find((x) => x.type === 'function' && x.name === name)!;
      const theirs = generated.find((x) => x.type === 'function' && x.name === name);
      expect(theirs, `${name} is missing from the contract`).toBeDefined();
      expect(shape(ours), name).toBe(shape(theirs!));
    }
  });

  it('still decodes the reverts a staker can hit', () => {
    const errors = vaultAbi.filter((x) => x.type === 'error').map((x) => x.name);
    for (const e of ['Slippage', 'Expired', 'DepositsClosed', 'InsufficientShares', 'ZeroLiquidity']) expect(errors).toContain(e);
  });
});
