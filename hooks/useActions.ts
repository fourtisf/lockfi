'use client';

import { useCallback } from 'react';
import { erc20Abi, parseEventLogs, zeroAddress, type TransactionReceipt } from 'viem';
import { readContract, simulateContract, writeContract } from 'wagmi/actions';
import { useTx } from '@/hooks/useTx';
import { useWallet } from '@/hooks/useWallet';
import { CHAIN, CONTRACTS } from '@/lib/chain';
import { tidewellRouterFactoryAbi, tidewellShaperAbi, tidewellZapAbi } from '@/lib/contracts/abis';
import { deploymentFor } from '@/lib/contracts/deployments';
import type { RouterConfig } from '@/lib/contracts/router';
import { shapeToTickBins, tokenShareOfBins } from '@/lib/contracts/shaped';
import { signingStatus, type MintAvailability } from '@/lib/contracts/status';
import { stateViewAbi } from '@/lib/contracts/uniswap';
import {
  MAX_ZAP_LOSS_BPS,
  ethValueAt,
  formatEthDown,
  lossBps,
  minusSlippage,
  sqrtPriceBounds,
  swapAmountForShare,
  txDeadline,
  weiToNumber,
  zapStakeSwapAmount,
} from '@/lib/contracts/tx';
import { ethIndexOf, ethIsNative, poolIdOf, vaultAbi } from '@/lib/contracts/vault';
import type { PoolKey } from '@/lib/data/types';
import { MIN_DEPOSIT_USD, minDepositEth } from '@/lib/stake';
import type { DepositSide } from '@/lib/deposit';

type Address = `0x${string}`;
const WETH = CONTRACTS.weth as Address;
const NO_ETH_SIDE = "This vault's pool has no ETH side, so it cannot be entered with ETH. Nothing was sent.";

export interface ShapedMintRequest {
  target: Extract<MintAvailability, { ok: true }>;
  weights: number[];
  minPct: number;
  maxPct: number;
  amountWei: bigint;
}

/**
 * Every transaction the site can send, as one function each. Each one reads
 * what it needs fresh from the chain at the moment it is called, simulates
 * before it asks for a signature (so a revert is explained before the wallet
 * opens), and returns whether it went through. Failures are toasted here.
 * Vault calls go through lib/contracts/vault.ts and nothing else.
 */
export function useActions() {
  const { send, fail, config } = useTx();
  const { address } = useWallet();
  const { zap, shaper } = signingStatus();
  const routerFactory = deploymentFor(CHAIN.id)?.routerFactory ?? null;

  const need = useCallback((): Address => {
    if (!address) throw new Error('Connect a wallet first.');
    return address;
  }, [address]);

  const keyOf = useCallback(
    async (vault: Address): Promise<PoolKey> => {
      const k = await readContract(config, { address: vault, abi: vaultAbi, functionName: 'poolKey', chainId: CHAIN.id });
      return { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks };
    },
    [config],
  );

  /**
   * Exactly `amount` of `token` for `spender` to pull, when the wallet has
   * not already allowed that much. Never an unlimited approval.
   */
  const allowExactly = useCallback(
    async (label: string, account: Address, token: Address, spender: Address, amount: bigint, symbol: string) => {
      const allowance = await readContract(config, {
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, spender],
        chainId: CHAIN.id,
      });
      if (allowance >= amount) return;
      await send(`${label} · allow exactly ${symbol}`, () =>
        writeContract(config, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account, chainId: CHAIN.id }),
      );
    },
    [config, send],
  );

  /**
   * zapStake: liquidity is quoted by simulating with a floor of 1, then
   * required at 99.5% of that in the real call — after checking the quote is
   * not a deposit too large for the pool (MAX_ZAP_LOSS_BPS).
   *
   * `tokenIn` is address(0) for native ETH (wrapped by the zap for a WETH
   * pool), WETH, or either pool currency; an ERC-20 input must already be
   * approved to the zap.
   */
  const zapIn = useCallback(
    async (label: string, account: Address, vault: Address, tokenIn: Address, amountIn: bigint) => {
      if (!zap) throw new Error('The zap is not deployed.');
      const key = await keyOf(vault);
      const ethIndex = ethIndexOf(key);
      const t = tokenIn.toLowerCase();
      // Which currency the input is measured in, for the loss check below.
      const valueIndex: 0 | 1 | null =
        t === zeroAddress || t === WETH.toLowerCase()
          ? ethIndex
          : t === key.currency0.toLowerCase()
            ? 0
            : t === key.currency1.toLowerCase()
              ? 1
              : null;
      if (valueIndex === null) throw new Error(t === zeroAddress ? NO_ETH_SIDE : 'That token is not one of this pool’s. Nothing was sent.');
      const swap = zapStakeSwapAmount(amountIn, key.fee);
      const deadline = txDeadline();
      const value = tokenIn === zeroAddress ? amountIn : 0n;
      const { result: quoted } = await simulateContract(config, {
        address: zap,
        abi: tidewellZapAbi,
        functionName: 'zapStake',
        args: [vault, tokenIn, amountIn, swap, 1n, deadline],
        value,
        account,
        chainId: CHAIN.id,
      });
      // What that liquidity is worth at the price BEFORE the swap. A deposit
      // too large for the pool sells the price down and mints far less than
      // it put in; minLiquidity, quoted with that impact baked in, cannot
      // see it. Refunds are not counted, so this errs safe.
      const [[a0, a1], [sqrtPriceX96]] = await Promise.all([
        readContract(config, { address: vault, abi: vaultAbi, functionName: 'amountsForLiquidity', args: [quoted], chainId: CHAIN.id }),
        readContract(config, { address: CONTRACTS.stateView as Address, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(key)], chainId: CHAIN.id }),
      ]);
      const loss = lossBps(amountIn, ethValueAt(a0, a1, sqrtPriceX96, valueIndex));
      if (loss > MAX_ZAP_LOSS_BPS) {
        throw new Error(
          `This deposit would lose about ${(loss / 100).toFixed(1)}% of its value to its own swap — it is large for this pool's depth. Nothing was sent. Try a smaller amount.`,
        );
      }
      const minLiquidity = minusSlippage(quoted);
      return send(label, () =>
        writeContract(config, {
          address: zap,
          abi: tidewellZapAbi,
          functionName: 'zapStake',
          args: [vault, tokenIn, amountIn, swap, minLiquidity > 0n ? minLiquidity : 1n, deadline],
          value,
          account,
          chainId: CHAIN.id,
        }),
      );
    },
    [config, send, zap, keyOf],
  );

  const stake = useCallback(
    async (vault: Address, amountWei: bigint, symbol: string): Promise<boolean> => {
      const label = `Stake ${formatEthDown(amountWei, 4)} ETH into ${symbol}`;
      try {
        await zapIn(label, need(), vault, zeroAddress, amountWei);
        return true;
      } catch (err) {
        fail(label, err);
        return false;
      }
    },
    [zapIn, need, fail],
  );

  /**
   * One token into a vault through the zap: native ETH as the transaction's
   * value, or an ERC-20 approved to the zap for exactly the amount first.
   */
  const stakeOne = useCallback(
    async (vault: Address, side: DepositSide, amount: bigint, label: string): Promise<boolean> => {
      try {
        const account = need();
        if (!zap) throw new Error('The zap is not deployed.');
        if (side.isEth) {
          await zapIn(label, account, vault, zeroAddress, amount);
        } else {
          await allowExactly(label, account, side.currency, zap, amount, side.symbol);
          await zapIn(label, account, vault, side.currency, amount);
        }
        return true;
      } catch (err) {
        fail(label, err);
        return false;
      }
    },
    [need, zap, zapIn, allowExactly, fail],
  );

  /**
   * Both tokens straight into the vault, in its ratio: no swap. The vault's
   * own previewDeposit, read now, says what it will take of each; the
   * minimums are that less 0.5%. An ERC-20 side is approved to the vault for
   * exactly its desired amount — the most the vault may pull from this
   * wallet, and only in a deposit this wallet makes. Native ETH is the
   * transaction's value; the vault refunds what it does not use.
   */
  const depositBoth = useCallback(
    async (vault: Address, sides: [DepositSide, DepositSide], desired: [bigint, bigint], label: string): Promise<boolean> => {
      try {
        const account = need();
        if (sides[1].native) throw new Error('A native-ETH side can only be currency0. Nothing was sent.');
        const [liquidity, take0, take1] = await readContract(config, {
          address: vault,
          abi: vaultAbi,
          functionName: 'previewDeposit',
          args: desired,
          chainId: CHAIN.id,
        });
        if (liquidity === 0n) throw new Error('These amounts mint no liquidity at the current price. Nothing was sent.');
        for (const s of sides) {
          if (!s.native && desired[s.index] > 0n) await allowExactly(label, account, s.currency, vault, desired[s.index], s.symbol);
        }
        const args = [desired[0], desired[1], minusSlippage(take0), minusSlippage(take1), account, txDeadline()] as const;
        const value = sides[0].native ? desired[0] : 0n;
        await simulateContract(config, { address: vault, abi: vaultAbi, functionName: 'deposit', args, value, account, chainId: CHAIN.id });
        await send(label, () =>
          writeContract(config, { address: vault, abi: vaultAbi, functionName: 'deposit', args, value, account, chainId: CHAIN.id }),
        );
        return true;
      } catch (err) {
        fail(label, err);
        return false;
      }
    },
    [need, config, allowExactly, send, fail],
  );

  /** Withdraw shares; the minimums are what they are worth now, less 0.5%. */
  const withdraw = useCallback(
    async (vault: Address, shares: bigint, symbol: string): Promise<boolean> => {
      const label = `Withdraw from ${symbol}`;
      try {
        const account = need();
        const [a0, a1] = await readContract(config, {
          address: vault,
          abi: vaultAbi,
          functionName: 'amountsForLiquidity',
          args: [shares],
          chainId: CHAIN.id,
        });
        const args = [shares, minusSlippage(a0), minusSlippage(a1), account, txDeadline()] as const;
        await simulateContract(config, { address: vault, abi: vaultAbi, functionName: 'withdraw', args, account, chainId: CHAIN.id });
        await send(label, () =>
          writeContract(config, { address: vault, abi: vaultAbi, functionName: 'withdraw', args, account, chainId: CHAIN.id }),
        );
        return true;
      } catch (err) {
        fail(label, err);
        return false;
      }
    },
    [config, need, send, fail],
  );

  /** Claim both tokens' fees to the wallet. */
  const claimOnce = useCallback(
    (label: string, account: Address, vault: Address): Promise<TransactionReceipt> =>
      send(label, () =>
        writeContract(config, { address: vault, abi: vaultAbi, functionName: 'claim', args: [account], account, chainId: CHAIN.id }),
      ),
    [config, send],
  );

  const claim = useCallback(
    async (vault: Address, symbol: string): Promise<boolean> => {
      const label = `Claim from ${symbol}`;
      try {
        await claimOnce(label, need(), vault);
        return true;
      } catch (err) {
        fail(label, err);
        return false;
      }
    },
    [claimOnce, need, fail],
  );

  /** One claim per vault with something to claim, one after another. */
  const claimAll = useCallback(
    async (targets: { vault: Address; symbol: string }[]): Promise<boolean> => {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const label = targets.length > 1 ? `Claim ${i + 1} of ${targets.length} · ${t.symbol}` : `Claim from ${t.symbol}`;
        try {
          await claimOnce(label, need(), t.vault);
        } catch (err) {
          fail(label, err);
          return false;
        }
      }
      return true;
    },
    [claimOnce, need, fail],
  );

  /**
   * Compound is two transactions, and says so: claim both tokens, then zap
   * the ETH side back into the vault. The token side stays in the wallet.
   *
   * How much ETH to stake back is what a simulated claim returns just before
   * the real one. Fees per share only grow, so the real claim pays at least
   * that: the zap never spends ETH the claim did not bring in. A pool that
   * holds WETH rather than ETH needs an approval for exactly that WETH in
   * between — never an unlimited one.
   */
  const compound = useCallback(
    async (vault: Address, symbol: string, ethPriceUsd: number): Promise<boolean> => {
      let label = `Compound ${symbol} · 1 of 2: claim`;
      try {
        const account = need();
        if (!zap) throw new Error('The zap is not deployed.');
        const minEth = minDepositEth(ethPriceUsd);
        if (minEth === null) {
          throw new Error(`The ETH price is not known yet, so the $${MIN_DEPOSIT_USD} minimum cannot be checked. Claim instead.`);
        }
        const key = await keyOf(vault);
        const ethIndex = ethIndexOf(key);
        if (ethIndex === null) throw new Error(`${NO_ETH_SIDE} Claim instead.`);
        const { result } = await simulateContract(config, {
          address: vault,
          abi: vaultAbi,
          functionName: 'claim',
          args: [account],
          account,
          chainId: CHAIN.id,
        });
        const ethClaimed = ethIndex === 0 ? result[0] : result[1];
        if (weiToNumber(ethClaimed) < minEth) {
          throw new Error(
            `The ETH side of what you can claim is under the $${MIN_DEPOSIT_USD} minimum, so there is nothing to stake back. Claim instead.`,
          );
        }
        await claimOnce(label, account, vault);

        const native = ethIsNative(key);
        if (!native) {
          const allowance = await readContract(config, {
            address: WETH,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, zap],
            chainId: CHAIN.id,
          });
          if (allowance < ethClaimed) {
            label = `Compound ${symbol} · let the zap spend ${formatEthDown(ethClaimed, 6)} WETH`;
            await send(label, () =>
              writeContract(config, { address: WETH, abi: erc20Abi, functionName: 'approve', args: [zap, ethClaimed], account, chainId: CHAIN.id }),
            );
          }
        }
        label = `Compound ${symbol} · 2 of 2: stake ${formatEthDown(ethClaimed, 6)} ${native ? 'ETH' : 'WETH'}`;
        await zapIn(label, account, vault, native ? zeroAddress : WETH, ethClaimed);
        return true;
      } catch (err) {
        fail(label.includes('1 of 2') ? label : `${label} (what was claimed is in your wallet)`, err);
        return false;
      }
    },
    [need, zap, keyOf, config, claimOnce, send, zapIn, fail],
  );

  /**
   * One shaped position from ETH, through TidewellShaper. The pool's price is
   * read now, the page's shape is put on the tick grid around it
   * (lib/contracts/shaped.ts), and the swap is sized from those bins.
   */
  const mintShaped = useCallback(
    async (req: ShapedMintRequest, symbol: string): Promise<boolean> => {
      const label = `Mint ${symbol} position`;
      try {
        const account = need();
        if (!shaper) throw new Error('The shaper is not deployed.');
        const { target, amountWei } = req;
        const [sqrtPriceX96, tick, , lpFee] = await readContract(config, {
          address: CONTRACTS.stateView as Address,
          abi: stateViewAbi,
          functionName: 'getSlot0',
          args: [target.poolId],
          chainId: CHAIN.id,
        });
        if (sqrtPriceX96 === 0n) throw new Error('This pool has no price yet.');
        const plan = shapeToTickBins({
          weights: req.weights,
          minPct: req.minPct,
          maxPct: req.maxPct,
          currentTick: tick,
          tickSpacing: target.key.tickSpacing,
          tokenIsCurrency0: target.tokenIsCurrency0,
        });
        if (!plan.ok) throw new Error(plan.reason);
        const share = tokenShareOfBins(plan.bins, sqrtPriceX96, target.tokenIsCurrency0);
        const swap = swapAmountForShare(amountWei, share, lpFee);
        const { min, max } = sqrtPriceBounds(sqrtPriceX96);
        const args = [
          target.key,
          plan.bins.map((b) => ({ lower: b.lower, upper: b.upper, weightBps: BigInt(b.weightBps) })),
          zeroAddress,
          amountWei,
          swap,
          min,
          max,
          txDeadline(),
        ] as const;
        await simulateContract(config, {
          address: shaper,
          abi: tidewellShaperAbi,
          functionName: 'mintShaped',
          args,
          value: amountWei,
          account,
          chainId: CHAIN.id,
        });
        await send(`${label} · ${plan.bins.length} ${plan.bins.length === 1 ? 'bin' : 'bins'}`, () =>
          writeContract(config, {
            address: shaper,
            abi: tidewellShaperAbi,
            functionName: 'mintShaped',
            args,
            value: amountWei,
            account,
            chainId: CHAIN.id,
          }),
        );
        return true;
      } catch (err) {
        fail(label, err);
        return false;
      }
    },
    [need, shaper, config, send, fail],
  );

  /**
   * Deploy a TidewellRouter through the factory. The caller becomes its
   * owner; the keeper only ever triggers routes. Returns the new router's
   * address, read from the factory's RouterCreated event.
   */
  const createRouter = useCallback(
    async (cfg: RouterConfig, keeper: Address, symbol: string): Promise<Address | null> => {
      const label = `Create ${symbol} router`;
      try {
        const account = need();
        if (!routerFactory) throw new Error('The router factory is not deployed.');
        const args = [cfg, keeper] as const;
        await simulateContract(config, {
          address: routerFactory,
          abi: tidewellRouterFactoryAbi,
          functionName: 'createRouter',
          args,
          account,
          chainId: CHAIN.id,
        });
        const receipt = await send(label, () =>
          writeContract(config, {
            address: routerFactory,
            abi: tidewellRouterFactoryAbi,
            functionName: 'createRouter',
            args,
            account,
            chainId: CHAIN.id,
          }),
        );
        const created = parseEventLogs({ abi: tidewellRouterFactoryAbi, eventName: 'RouterCreated', logs: receipt.logs }).find(
          (l) => l.address.toLowerCase() === routerFactory.toLowerCase(),
        );
        return created ? (created.args.router as Address) : null;
      } catch (err) {
        fail(label, err);
        return null;
      }
    },
    [need, routerFactory, config, send, fail],
  );

  return { stake, stakeOne, depositBoth, withdraw, claim, claimAll, compound, mintShaped, createRouter };
}
