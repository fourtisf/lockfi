/**
 * Everything the site knows about TidewellVault's interface, in one file.
 *
 * The vault pays fees per share, credited the moment they are earned and
 * claimable any time in the pool's two tokens — native ETH for a pool whose
 * currency0 is address(0) (ALFA, after the security review: no WETH stream,
 * no harvest, no keeper). Every read and write the browser makes against a
 * vault goes through what is declared here, so a change to the contract is
 * a change to this file.
 *
 * The functions are declared by signature rather than taken whole from the
 * generated abis.ts, so the site states exactly what it depends on;
 * vault.test.ts checks each one against the generated ABI. The errors are
 * the generated ones, all of them, so every revert decodes (errors.ts).
 */
import { encodeAbiParameters, keccak256, parseAbi, zeroAddress } from 'viem';
import { CHAIN, CONTRACTS } from '../chain';
import type { PoolKey } from '../data/types';
import { tidewellVaultAbi } from './abis';
import type { VaultDeployment } from './deployments';

type Address = `0x${string}`;

const VAULT_CALLS = parseAbi([
  'function claim(address recipient) returns (uint256 amount0, uint256 amount1)',
  // Includes fees not yet collected: the figure a staker could have now.
  'function claimable(address account) view returns (uint256 amount0, uint256 amount1)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function amountsForLiquidity(uint128 liquidity) view returns (uint256 amount0, uint256 amount1)',
  'function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function protocolFeeBps() view returns (uint16)',
  'function depositsOpen() view returns (bool)',
  'function withdraw(uint128 liquidity, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) returns (uint256 amount0, uint256 amount1)',
  // Both tokens at once: what the deposit mints, and the deposit itself.
  'function previewDeposit(uint256 amount0Desired, uint256 amount1Desired) view returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function deposit(uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
]);

type VaultError = Extract<(typeof tidewellVaultAbi)[number], { type: 'error' }>;
const VAULT_ERRORS = tidewellVaultAbi.filter((x): x is VaultError => x.type === 'error');

export const vaultAbi = [...VAULT_CALLS, ...VAULT_ERRORS] as const;

/** The view functions the site reads, by name — what vault.test.ts holds the generated ABI to. */
export const VAULT_FUNCTIONS = [
  'claim',
  'claimable',
  'balanceOf',
  'totalSupply',
  'amountsForLiquidity',
  'poolKey',
  'protocolFeeBps',
  'depositsOpen',
  'withdraw',
  'previewDeposit',
  'deposit',
] as const;

const WETH = CONTRACTS.weth.toLowerCase();

/**
 * Which of the pool's currencies is ETH (native or WETH), or null when
 * neither is: a vault needs no ETH side, but entering one with ETH, and
 * compounding back into it, does.
 */
export function ethIndexOf(key: Pick<PoolKey, 'currency0' | 'currency1'>): 0 | 1 | null {
  const c0 = key.currency0.toLowerCase();
  if (c0 === zeroAddress || c0 === WETH) return 0;
  return key.currency1.toLowerCase() === WETH ? 1 : null;
}

/** True when the ETH side is native ETH (address 0), which a zap pays with msg.value. */
export function ethIsNative(key: Pick<PoolKey, 'currency0'>): boolean {
  return key.currency0.toLowerCase() === zeroAddress;
}

/** keccak256(abi.encode(key)) — the v4 PoolId, as StateView wants it. */
export function poolIdOf(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
      ],
      [key],
    ),
  );
}

/** The four reads, per vault, that describe a wallet's stake in it. */
export function walletReadCalls(vault: Address, account: Address) {
  const chainId = CHAIN.id;
  return [
    { address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [account], chainId },
    { address: vault, abi: vaultAbi, functionName: 'totalSupply', chainId },
    { address: vault, abi: vaultAbi, functionName: 'claimable', args: [account], chainId },
    { address: vault, abi: vaultAbi, functionName: 'poolKey', chainId },
  ] as const;
}
export const WALLET_READS_PER_VAULT = 4;

/** One deployed vault as the connected wallet stands in it (raw chain reads). */
export interface WalletVaultReads {
  deployment: VaultDeployment;
  key: PoolKey;
  /** Vault shares, which are liquidity units. */
  shares: bigint;
  totalSupply: bigint;
  /** Fees claimable now, per currency — including fees not yet collected. */
  claimable0: bigint;
  claimable1: bigint;
  /** Which currency is ETH, or null when the pool has no ETH side. */
  ethIndex: 0 | 1 | null;
  /** What the shares would withdraw as right now, per currency. */
  amount0: bigint;
  amount1: bigint;
  /**
   * False while the read of what the shares are worth is in flight or failed:
   * the two amounts above are then not known, and a stake must not be shown
   * as worth $0 — or the portfolio reads it as a 100% loss.
   */
  amountsKnown: boolean;
}

type ReadResult = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

/**
 * One vault's four reads into its raw figures, or null when any failed —
 * a stake read half-way is not shown as a stake.
 */
export function parseWalletReads(
  deployment: VaultDeployment,
  results: readonly ReadResult[],
): Omit<WalletVaultReads, 'amount0' | 'amount1' | 'amountsKnown'> | null {
  if (results.length !== WALLET_READS_PER_VAULT || results.some((r) => r.status !== 'success')) return null;
  const [bal, total, claim, key] = results.map((r) => (r as { result: unknown }).result) as [
    bigint,
    bigint,
    readonly [bigint, bigint],
    { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  ];
  const poolKey: PoolKey = {
    currency0: key.currency0.toLowerCase() as Address,
    currency1: key.currency1.toLowerCase() as Address,
    fee: Number(key.fee),
    tickSpacing: Number(key.tickSpacing),
    hooks: key.hooks.toLowerCase() as Address,
  };
  return {
    deployment,
    key: poolKey,
    shares: BigInt(bal),
    totalSupply: BigInt(total),
    claimable0: BigInt(claim[0]),
    claimable1: BigInt(claim[1]),
    ethIndex: ethIndexOf(poolKey),
  };
}
