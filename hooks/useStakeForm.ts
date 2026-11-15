'use client';

import { useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { useActions } from '@/hooks/useActions';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useVaultInfo } from '@/hooks/useVaults';
import { useWallet } from '@/hooks/useWallet';
import { PROTOCOL_FEE_BPS } from '@/lib/chain';
import { stakeTarget } from '@/lib/contracts/status';
import { ethIndexOf } from '@/lib/contracts/vault';
import { GAS_RESERVE_WEI, formatEthDown, maxSpendableWei, parseEthInput, weiToNumber } from '@/lib/contracts/tx';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool } from '@/lib/data/types';
import { usdExact } from '@/lib/format';
import { depositProblem, minDepositLabel, stakeQuote } from '@/lib/stake';

const LIVE = DATA_SOURCE === 'live';

/**
 * How a stake form behaves:
 *   preview — the simulator: arithmetic on the typed amount, and a toast that
 *             says nothing was sent;
 *   live    — a deployed vault and zap: a real zapStake from the wallet;
 *   closed  — the live site with no vault or no zap for this pool.
 */
export type StakeFormMode = 'preview' | 'live' | 'closed';

/**
 * The one stake form, behind both the drawer and the panel on /stakes, so
 * the two cannot disagree on a balance, a minimum, a fee or a quote.
 */
export function useStakeForm(pool: Pool | null) {
  const { global } = useMarket();
  const { act } = useUi();
  const { portfolio, balanceWei } = usePortfolio();
  const wallet = useWallet();
  const actions = useActions();
  const target = LIVE && pool ? stakeTarget(pool.id) : null;
  const info = useVaultInfo(target?.vault.address);
  // A live form starts empty: a pre-filled "1 ETH" is an amount nobody chose.
  const [amount, setAmount] = useState(LIVE ? '' : '1');
  const [busy, setBusy] = useState(false);

  // A vault needs no ETH side, but this form pays in ETH: a vault on a pool
  // without one cannot be entered here.
  const noEthSide = pool?.key !== undefined && ethIndexOf(pool.key) === null;
  const mode: StakeFormMode = !LIVE ? 'preview' : target && !noEthSide ? 'live' : 'closed';
  const closedReason: 'no-vault' | 'no-eth-side' | null =
    mode !== 'closed' ? null : target ? 'no-eth-side' : 'no-vault';
  const ethPrice = global.ethPriceUsd;

  // What can be put in. Live: the wallet's ETH less the gas reserve, read
  // from the chain. Preview: the simulator's balance.
  const maxWei = mode === 'live' && balanceWei !== null ? maxSpendableWei(balanceWei) : null;
  const balanceEth: number | null =
    mode === 'preview' ? portfolio.walletBalanceEth : maxWei === null ? null : weiToNumber(maxWei);
  const maxLabel =
    mode === 'preview'
      ? balanceEth === null
        ? null
        : String(balanceEth)
      : maxWei === null
        ? null
        : formatEthDown(maxWei, 4);

  const wei = parseEthInput(amount);
  const eth = Number.parseFloat(amount);
  const typedEth = mode === 'live' ? (wei === null ? Number.NaN : weiToNumber(wei)) : eth;

  // The fee disclosed before signing: the vault's own, read from it, live.
  const feeBps: number | null = mode === 'live' ? info.protocolFeeBps : PROTOCOL_FEE_BPS;

  let problem: string | null = null;
  /** True when the problem is "nothing typed yet": said, but not in red. */
  let quiet = false;
  if (mode === 'preview') {
    problem = depositProblem(eth, balanceEth, ethPrice);
  } else if (mode === 'live' && wallet.status === 'ready') {
    if (amount.trim() === '') {
      problem = 'Enter an amount to stake.';
      quiet = true;
    } else if (info.depositsOpen === false) {
      problem = 'This vault is not taking new deposits. Withdrawing and claiming still work.';
    } else if (balanceWei === null) {
      problem = 'Reading your balance…';
      quiet = true;
    } else {
      problem = depositProblem(typedEth, balanceEth, ethPrice);
      if (problem?.startsWith('That is above')) {
        problem = `That is more than you can stake: ${maxLabel} ETH, keeping ${formatEthDown(GAS_RESERVE_WEI, 4)} ETH for gas.`;
      }
      if (!problem && feeBps === null) {
        problem = info.failed ? "Could not read the vault's fee from the chain. Try again in a moment." : 'Reading the vault…';
        quiet = !info.failed;
      }
    }
  }

  const usable = Number.isFinite(typedEth) && typedEth > 0 && (balanceEth === null || typedEth <= balanceEth);
  const quote = pool ? stakeQuote(pool, usable ? typedEth : 0, ethPrice, feeBps ?? PROTOCOL_FEE_BPS) : null;

  const canSubmit = !busy && problem === null && (mode === 'preview' || (mode === 'live' && wallet.status === 'ready'));

  const submit = async () => {
    if (!pool || !canSubmit) return;
    if (mode === 'preview') {
      act('Staking');
      return;
    }
    if (!target || wei === null) return;
    setBusy(true);
    try {
      const ok = await actions.stake(target.vault.address, wei, pool.token.symbol);
      if (ok) setAmount('');
    } finally {
      setBusy(false);
    }
  };

  /** Set the amount to a share of what can be put in (1 = Max). */
  const setShare = (f: number) => {
    if (mode === 'live' && maxWei !== null) {
      setAmount(formatEthDown((maxWei * BigInt(Math.round(f * 10_000))) / 10_000n, 4));
    } else if (balanceEth !== null) {
      setAmount((balanceEth * f).toFixed(2));
    }
  };

  return {
    mode,
    closedReason,
    target,
    amount,
    setAmount,
    setShare,
    balanceEth,
    maxLabel,
    feeBps,
    problem,
    quiet,
    quote,
    minLabel: minDepositLabel(ethPrice),
    /**
     * The protocol fee, disclosed before signing (§7). A real vault takes it
     * from fees as they are collected — never from a deposit — and the
     * figure is the one the vault reports.
     */
    feeLabel:
      feeBps === null
        ? 'reading from the vault…'
        : mode === 'preview'
          ? `${feeBps / 100}% of fees earned`
          : `${feeBps / 100}% of fees as they are collected`,
    /**
     * The weekly estimate as the page prints it: dollars for a real vault,
     * which pays in the pool's two tokens; WETH in the simulator, which
     * rehearses the WETH stream. Null when §7 allows no figure.
     */
    weeklyLabel:
      quote?.weeklyWeth == null
        ? null
        : mode === 'preview'
          ? `${quote.weeklyWeth.toFixed(3)} WETH`
          : usdExact(quote.weeklyWeth * ethPrice, 2),
    canSubmit,
    submit,
    busy,
    walletStatus: wallet.status,
  };
}
