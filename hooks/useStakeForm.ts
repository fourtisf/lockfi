'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReadContract } from 'wagmi';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { useActions } from '@/hooks/useActions';
import { useDepositReads } from '@/hooks/useDepositReads';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useVaultInfo } from '@/hooks/useVaults';
import { useWallet } from '@/hooks/useWallet';
import { zeroAddress } from 'viem';
import { CHAIN, CONTRACTS, PROTOCOL_FEE_BPS } from '@/lib/chain';
import { stakeTarget } from '@/lib/contracts/status';
import { GAS_RESERVE_WEI, maxSpendableWei } from '@/lib/contracts/tx';
import { vaultAbi } from '@/lib/contracts/vault';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool, PoolKey } from '@/lib/data/types';
import {
  type DepositOption,
  type DepositRoute,
  type DepositSide,
  depositOptions,
  depositSides,
  depositUsd,
  displayOrder,
  formatAmountDown,
  parseAmount,
  plusMargin,
  toNumber,
  unlimited,
} from '@/lib/deposit';
import { usdExact } from '@/lib/format';
import { pairLabel } from '@/lib/pair';
import { MIN_DEPOSIT_USD, stakeQuote } from '@/lib/stake';
import { liveEthPrice, vaultView, type VaultView } from '@/lib/vault-view';

const LIVE = DATA_SOURCE === 'live';

/**
 * How a stake form behaves:
 *   preview — the simulator: arithmetic on the typed amounts, and a toast
 *             that says nothing was sent;
 *   live    — a deployed vault and zap: real transactions from the wallet;
 *   closed  — the live site with no vault, or no zap, for this pool.
 */
export type StakeFormMode = 'preview' | 'live' | 'closed';

/** One amount field of the form. */
export interface StakeInput {
  side: DepositSide;
  id: string;
  /** What the field shows. In a two-token deposit one side is worked out from the other. */
  amount: string;
  setAmount: (text: string) => void;
  /** True when this field's figure was worked out from the other one. */
  matched: boolean;
  /** "0.1168" — what Max would put in; null without a balance to take it from. */
  maxLabel: string | null;
  /** Spendable balance as a number of whole tokens; null when unknown. */
  balance: number | null;
}

export interface StakeFormQuote {
  depositUsd: number;
  /** 0–1: of the vault when its live read is in, of the pool otherwise. */
  share: number;
  shareOf: 'vault' | 'pool';
  /** Dollars a week at the trailing rate, after the protocol's fee; null when §7 allows no figure. */
  weeklyUsd: number | null;
}

const SHARES = [0.25, 0.5, 0.75, 1] as const;

function digitsFor(side: DepositSide): number {
  return side.isEth ? 4 : Math.min(side.decimals ?? 2, 2);
}

/**
 * The one stake form, behind both the drawer and the panel on /stakes, so the
 * two cannot disagree on a balance, a minimum, a fee or a quote.
 */
export function useStakeForm(pool: Pool | null) {
  const { global, vaults } = useMarket();
  const { act } = useUi();
  const { portfolio, balanceWei } = usePortfolio();
  const wallet = useWallet();
  const actions = useActions();
  const target = LIVE && pool ? stakeTarget(pool.id) : null;
  const info = useVaultInfo(target?.vault.address);
  const vault = pool ? (vaults.find((v) => v.poolId === pool.id) ?? null) : null;
  const view: VaultView | null = pool && vault ? vaultView(vault, pool, null) : null;
  // ETH's price from the vault's live pool read when there is one: the
  // snapshot's can be months old while the indexer catches up.
  const ethPrice = liveEthPrice(vaults, global.ethPriceUsd);
  const key: PoolKey | undefined = pool?.key;
  const reads = useDepositReads(target ? key : undefined);

  const mode: StakeFormMode = !LIVE ? 'preview' : target && key ? 'live' : 'closed';
  const closedReason: 'no-vault' | null = mode === 'closed' ? 'no-vault' : null;

  // The two sides: from the live read, the chain, and the snapshot, in that order.
  const sides = useMemo((): [DepositSide, DepositSide] | null => {
    if (!pool) return null;
    if (mode === 'preview' || !key) {
      // The simulator has no keys: its pools pair a token with ETH or USDG.
      const quoteEth = pool.quote === 'ETH';
      return [
        {
          index: 0,
          currency: '0x0000000000000000000000000000000000000000',
          symbol: quoteEth ? 'ETH' : 'USDG',
          decimals: quoteEth ? 18 : 6,
          native: quoteEth,
          isEth: quoteEth,
          priceUsd: quoteEth ? ethPrice : 1,
        },
        {
          index: 1,
          currency: pool.token.address as `0x${string}`,
          symbol: pool.token.symbol,
          decimals: pool.token.decimals,
          native: false,
          isEth: false,
          priceUsd: pool.priceUsd > 0 ? pool.priceUsd : null,
        },
      ];
    }
    const live = vault?.live?.currencies;
    // The vault's live read first; then ETH at its live price, the pool's
    // own token at the snapshot's, and USDG — the dollar anchor — at $1.
    const priceFor = (currency: string): number | null => {
      const c = currency.toLowerCase();
      const fromLive = live?.find((x) => x.address === c)?.priceUsd;
      if (fromLive != null) return fromLive;
      if (c === zeroAddress || c === CONTRACTS.weth.toLowerCase()) return ethPrice > 0 ? ethPrice : null;
      if (c === pool.token.address.toLowerCase()) return pool.priceUsd > 0 ? pool.priceUsd : null;
      return pool.quote === 'USDG' ? 1 : null;
    };
    // A symbol while the chain is still being asked: the pool's own token by
    // name, and the other side of a USDG pool as USDG. A vault the watcher has
    // not read yet (one deployed minutes ago) showed "token | token | token +
    // token" until the browser's own reads answered. Decimals are never
    // guessed: until they are read, nothing can be signed.
    const fallbackSymbol = (currency: string): string | undefined => {
      const c = currency.toLowerCase();
      if (c === pool.token.address.toLowerCase()) return pool.token.symbol;
      if (pool.quote === 'USDG' && c !== zeroAddress && c !== CONTRACTS.weth.toLowerCase()) return 'USDG';
      return undefined;
    };
    const known = [key.currency0, key.currency1].map((c, i) => {
      const l = live?.find((x) => x.address === c.toLowerCase());
      const r = reads[i];
      return {
        symbol: l?.symbol ?? r?.symbol ?? fallbackSymbol(c),
        decimals: l?.decimals ?? r?.decimals ?? null,
        priceUsd: priceFor(c),
      };
    });
    return depositSides(key, known);
  }, [pool, mode, key, vault?.live?.currencies, reads, ethPrice]);

  const options: DepositOption[] = sides ? depositOptions(sides) : [];
  const [route, setRouteState] = useState<DepositRoute>(0);
  // The ETH side first, by default, whenever the pool changes.
  useEffect(() => {
    if (options.length > 0) setRouteState(options[0].route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool?.id, options.length]);
  const [amounts, setAmounts] = useState<[string, string]>(['', '']);
  /** In a two-token deposit, the side the person typed; the other is matched to it. */
  const [anchor, setAnchor] = useState<0 | 1>(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAmounts(LIVE ? ['', ''] : ['1', '']);
    setAnchor(0);
  }, [pool?.id]);
  const setRoute = (next: DepositRoute) => {
    setRouteState(next);
    // Two tokens start from the side shown first (ETH): the other is matched to it.
    if (next !== 'both') setAnchor(next);
    else if (sides) setAnchor(displayOrder(sides)[0].index);
  };

  // Spendable balances, in smallest units: native ETH less the gas reserve.
  const balanceRaw = (side: DepositSide): bigint | null => {
    if (mode === 'preview') {
      const eth = portfolio.walletBalanceEth;
      if (eth === null || side.decimals === null) return null;
      // The simulator's wallet holds ETH; its other side is worth the same.
      const whole = side.isEth ? eth : side.priceUsd ? (eth * ethPrice) / side.priceUsd : 0;
      return parseAmount(whole.toFixed(Math.min(side.decimals, 6)), side.decimals);
    }
    if (side.native) return balanceWei === null ? null : maxSpendableWei(balanceWei);
    if (side.isEth && route !== 'both') return balanceWei === null ? null : maxSpendableWei(balanceWei);
    return reads[side.index]?.balance ?? null;
  };

  const raw = (side: DepositSide): bigint | null => parseAmount(amounts[side.index], side.decimals);

  // What one side of a two-token deposit needs of the other, from the vault.
  const anchorSide = sides ? sides[anchor] : null;
  const otherSide = sides ? sides[anchor === 0 ? 1 : 0] : null;
  const anchorRaw = anchorSide ? raw(anchorSide) : null;
  const previewArgs =
    route === 'both' && mode === 'live' && anchorRaw !== null && anchorRaw > 0n && otherSide?.decimals != null
      ? ((anchor === 0 ? [anchorRaw, unlimited(otherSide.decimals)] : [unlimited(otherSide.decimals), anchorRaw]) as [bigint, bigint])
      : undefined;
  const preview = useReadContract({
    address: target?.vault.address,
    abi: vaultAbi,
    functionName: 'previewDeposit',
    args: previewArgs,
    chainId: CHAIN.id,
    query: { enabled: previewArgs !== undefined, refetchInterval: 15_000 },
  });
  let matchedRaw: bigint | null = null;
  if (route === 'both' && sides && anchorSide && otherSide && anchorRaw !== null && anchorRaw > 0n) {
    if (mode === 'live') {
      const r = preview.data as readonly [bigint, bigint, bigint] | undefined;
      matchedRaw = previewArgs && r ? (anchor === 0 ? r[2] : r[1]) : null;
    } else if (anchorSide.priceUsd && otherSide.priceUsd && anchorSide.decimals !== null && otherSide.decimals !== null) {
      // The simulator: equal value on both sides, from its prices.
      const whole = (toNumber(anchorRaw, anchorSide.decimals) * anchorSide.priceUsd) / otherSide.priceUsd;
      matchedRaw = parseAmount(whole.toFixed(Math.min(otherSide.decimals, 8)), otherSide.decimals);
    }
  }

  const inputs: StakeInput[] = !sides
    ? []
    : (route === 'both' ? displayOrder(sides) : [sides[route]]).map((side, position) => {
        const bal = balanceRaw(side);
        // Only said once there is something matched to show.
        const matched = route === 'both' && side.index !== anchor && matchedRaw !== null;
        // In a two-token deposit the side not typed shows its match or
        // nothing; it once showed whatever was last typed there, unmatched.
        const shown =
          route === 'both' && side.index !== anchor
            ? matchedRaw !== null && side.decimals !== null
              ? formatAmountDown(matchedRaw, side.decimals, Math.max(digitsFor(side), 6))
              : ''
            : amounts[side.index];
        return {
          side,
          // "amount" for the first field, "amount-2" for a second: stable ids for labels and tests.
          id: position === 0 ? 'amount' : 'amount-2',
          amount: shown,
          setAmount: (text: string) => {
            setAmounts((prev) => (side.index === 0 ? [text, prev[1]] : [prev[0], text]));
            if (route === 'both') setAnchor(side.index);
          },
          matched,
          maxLabel: bal === null || side.decimals === null ? null : formatAmountDown(bal, side.decimals, digitsFor(side)),
          balance: bal === null || side.decimals === null ? null : toNumber(bal, side.decimals),
        };
      });

  /** Set the form to a share of what the wallet can put in (1 = Max). */
  const setShare = (f: number) => {
    if (!sides) return;
    let side: DepositSide = route === 'both' ? sides[anchor] : sides[route];
    if (route === 'both') {
      // The largest balanced deposit is limited by whichever side is worth less.
      const worth = sides.map((s) => {
        const b = balanceRaw(s);
        return b === null || s.decimals === null || !s.priceUsd ? null : toNumber(b, s.decimals) * s.priceUsd;
      });
      if (worth[0] !== null && worth[1] !== null) side = worth[0] <= worth[1] ? sides[0] : sides[1];
      setAnchor(side.index);
    }
    const bal = balanceRaw(side);
    if (bal === null || side.decimals === null) return;
    const part = (bal * BigInt(Math.round(f * 10_000))) / 10_000n;
    const text = formatAmountDown(part, side.decimals, digitsFor(side));
    setAmounts((prev) => (side.index === 0 ? [text, prev[1]] : [prev[0], text]));
  };

  // What is being put in, per side, in smallest units.
  const parts: { side: DepositSide; raw: bigint | null }[] = !sides
    ? []
    : route === 'both'
      ? sides.map((s) => ({ side: s, raw: s.index === anchor ? anchorRaw : matchedRaw }))
      : [{ side: sides[route], raw: raw(sides[route]) }];
  const value = depositUsd(
    parts.map((p) => ({
      amount: p.raw !== null && p.side.decimals !== null ? toNumber(p.raw, p.side.decimals) : 0,
      priceUsd: p.side.priceUsd,
    })),
  );

  // The fee disclosed before signing: the vault's own, read from it, live.
  const feeBps: number | null = mode === 'live' ? info.protocolFeeBps : PROTOCOL_FEE_BPS;

  let problem: string | null = null;
  /** True when the problem is "nothing typed yet": said, but not in red. */
  let quiet = false;
  const ready = mode === 'preview' || (mode === 'live' && wallet.status === 'ready');
  if (mode === 'preview' && portfolio.walletBalanceEth === null) {
    problem = 'Connect a wallet to stake.';
  } else if (ready && sides) {
    const typed = route === 'both' ? anchorRaw : parts[0]?.raw ?? null;
    const typedText = route === 'both' ? amounts[anchor] : amounts[route as 0 | 1];
    if (parts.some((p) => p.side.decimals === null)) {
      problem = 'Reading the token from the chain…';
      quiet = true;
    } else if (typedText.trim() === '') {
      problem = 'Enter an amount to stake.';
      quiet = true;
    } else if (typed === null || typed <= 0n) {
      problem = 'Enter an amount to stake.';
    } else if (mode === 'live' && info.depositsOpen === false) {
      problem = 'This vault is not taking new deposits. Withdrawing and claiming still work.';
    } else if (route === 'both' && matchedRaw === null) {
      problem = mode === 'live' && preview.isError ? 'Could not work out the matching amount from the vault. Try again.' : 'Working out the matching amount…';
      quiet = !(mode === 'live' && preview.isError);
    } else {
      for (const p of parts) {
        const bal = balanceRaw(p.side);
        if (bal === null) {
          problem = mode === 'live' ? `Reading your ${p.side.symbol} balance…` : 'Connect a wallet to stake.';
          quiet = mode === 'live';
          break;
        }
        if (p.raw !== null && p.raw > bal && p.side.decimals !== null) {
          const have = formatAmountDown(bal, p.side.decimals, digitsFor(p.side));
          problem =
            route === 'both' && p.side.index !== anchor
              ? `That needs ${formatAmountDown(p.raw, p.side.decimals, digitsFor(p.side))} ${p.side.symbol} — above your balance of ${have}. Lower the amount, or use Max.`
              : mode === 'live' && (p.side.native || (p.side.isEth && route !== 'both'))
                ? `That is above your balance: you can stake ${have} ETH, keeping ${formatAmountDown(GAS_RESERVE_WEI, 18, 4)} ETH for gas.`
                : `That is above your balance of ${have} ${p.side.isEth && route !== 'both' ? 'ETH' : p.side.symbol}.`;
          break;
        }
      }
      if (!problem) {
        const usesNative = parts.some((p) => p.side.native || (p.side.isEth && route !== 'both'));
        if (mode === 'live' && !usesNative && balanceWei !== null && balanceWei === 0n) {
          problem = 'You need a little ETH on Robinhood Chain to pay for gas.';
        } else if (value === null) {
          problem = `A price is not known yet, so the $${MIN_DEPOSIT_USD} minimum cannot be checked.`;
        } else if (value < MIN_DEPOSIT_USD) {
          problem = `Minimum $${MIN_DEPOSIT_USD} — this is ${usdExact(value, 2)}.`;
        } else if (feeBps === null) {
          problem = info.failed ? "Could not read the vault's fee from the chain. Try again in a moment." : 'Reading the vault…';
          quiet = !info.failed;
        }
      }
    }
  }

  // The estimate: the vault's own live rate when it is in, else the pool's.
  const quote: StakeFormQuote | null = !pool
    ? null
    : (() => {
        const usd = value ?? 0;
        if (view?.live) {
          const share = usd > 0 ? usd / (view.stakedUsd + usd) : 0;
          const y = view.yield;
          return {
            depositUsd: usd,
            share,
            shareOf: 'vault' as const,
            weeklyUsd: y.basis === 'insufficient' ? null : (usd * (y.pct / 100) * 7) / 365,
          };
        }
        const q = stakeQuote(pool, ethPrice > 0 ? usd / ethPrice : 0, ethPrice, feeBps ?? PROTOCOL_FEE_BPS);
        return { depositUsd: usd, share: q.share, shareOf: 'pool' as const, weeklyUsd: q.weeklyWeth === null ? null : q.weeklyWeth * ethPrice };
      })();

  const canSubmit = !busy && problem === null && ready;

  const submit = async () => {
    if (!pool || !sides || !canSubmit) return;
    if (mode === 'preview') {
      act('Staking');
      return;
    }
    if (!target) return;
    setBusy(true);
    try {
      let ok = false;
      if (route === 'both') {
        const a = anchorRaw ?? 0n;
        const m = matchedRaw ?? 0n;
        const other = sides[anchor === 0 ? 1 : 0];
        const otherBal = balanceRaw(other);
        // The matched side may move with the price before this lands: allow
        // it 0.5% more, never more than the wallet has. The minimums the
        // action sets catch a move larger than that.
        const room = plusMargin(m);
        const otherDesired = otherBal !== null && room > otherBal ? otherBal : room;
        const desired: [bigint, bigint] = anchor === 0 ? [a, otherDesired] : [otherDesired, a];
        const [d0, d1] = displayOrder(sides);
        ok = await actions.depositBoth(
          target.vault.address,
          sides,
          desired,
          `Stake ${amounts[anchor]} ${sides[anchor].symbol} + matching ${other.symbol} into ${pairLabel(pool)} (${d0.symbol} + ${d1.symbol}, no swap)`,
        );
      } else {
        const side = sides[route];
        const amount = raw(side);
        if (amount === null) return;
        ok = await actions.stakeOne(target.vault.address, side, amount, `Stake ${amounts[route]} ${side.isEth ? 'ETH' : side.symbol} into ${pairLabel(pool)}`);
      }
      if (ok) setAmounts(['', '']);
    } finally {
      setBusy(false);
    }
  };

  const single = route !== 'both' && sides ? sides[route] : null;
  const minLabel =
    single && single.priceUsd
      ? `Minimum $${MIN_DEPOSIT_USD} · ≈ ${(MIN_DEPOSIT_USD / single.priceUsd).toFixed(single.isEth ? 4 : 2)} ${single.isEth ? 'ETH' : single.symbol} at today's price`
      : route === 'both'
        ? `Minimum $${MIN_DEPOSIT_USD} in total, both sides together`
        : `Minimum $${MIN_DEPOSIT_USD} · the price is not known yet, so it cannot be shown in ${single?.symbol ?? 'tokens'}`;

  return {
    mode,
    closedReason,
    target,
    view,
    options,
    route,
    setRoute,
    routeNote: options.find((o) => o.route === route)?.note ?? null,
    inputs,
    shares: SHARES,
    setShare,
    /** Shares of a balance need a balance: no wallet, no chips. */
    hasBalance: inputs.some((i) => i.maxLabel !== null),
    feeBps,
    problem,
    quiet,
    quote,
    ethPrice,
    minLabel,
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
    /** The weekly estimate in dollars, or null when §7 allows no figure. */
    weeklyLabel: quote?.weeklyUsd == null ? null : usdExact(quote.weeklyUsd, 2),
    canSubmit,
    submit,
    busy,
    walletStatus: wallet.status,
  };
}

export type StakeForm = ReturnType<typeof useStakeForm>;
