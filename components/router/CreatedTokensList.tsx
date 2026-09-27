'use client';

/**
 * The tokens the connected wallet created, as a list: shown in the wallet
 * dialog and on the Router page, found by `useCreatedTokens` the moment the
 * wallet connects.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { EXPLORER_URL } from '@/lib/chain';
import { shortWallet } from '@/lib/format';
import { tokenMark } from '@/lib/token-mark';
import type { TokenMeta } from '@/lib/data/types';
import type { CreatedTokens } from './useCreatedTokens';

export function CreatedTokensList({
  found,
  onPick,
  compact = false,
}: {
  found: CreatedTokens;
  /** On the Router page: pick the token for a router rather than follow a link. */
  onPick?: (address: string) => void;
  compact?: boolean;
}) {
  const snap = useMarket();
  const { closeWallet, showToast } = useUi();
  // a logo the board already has for the token
  const logos = useMemo(() => {
    const by = new Map<string, string>();
    for (const p of [...snap.pools, ...(snap.otherPools ?? [])]) if (p.token.logoUrl) by.set(p.token.address.toLowerCase(), p.token.logoUrl);
    return by;
  }, [snap.pools, snap.otherPools]);

  const { status, tokens } = found;
  if (tokens.length === 0) {
    if (status === 'loading') return <p className="hint" data-testid="created-tokens-state">Looking for tokens this wallet created…</p>;
    if (status === 'error') return <p className="hint" data-testid="created-tokens-state">Could not look just now. Try again in a minute, or paste the token&apos;s address on the Router page.</p>;
    if (status === 'done')
      return (
        <p className="hint" data-testid="created-tokens-state">
          No token created by this wallet was found. If you launched one from another wallet, connect that one; or paste the
          token&apos;s address on the Router page.
        </p>
      );
    return null;
  }

  const copy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      showToast('Token address copied');
    } catch {
      showToast(address);
    }
  };

  return (
    <ul className={`ct-list${compact ? ' compact' : ''}`} data-testid="created-tokens">
      {tokens.map((t) => {
        const meta: TokenMeta = {
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          logoColor: tokenMark(t.address).bg,
          logoUrl: logos.get(t.address.toLowerCase()),
        };
        return (
          <li key={t.address} className="ct-row">
            <TokenBadge token={meta} />
            <div className="ct-id">
              <b>{t.symbol}</b>
              <span className="muted">
                {t.name && t.name !== t.symbol ? `${t.name} · ` : ''}
                {t.creator.via ? 'launched through ' : 'deployed '}
                {t.creator.via ? <code className="num">{shortWallet(t.creator.via)}</code> : 'directly'}
              </span>
              <button type="button" className="rt-addr" onClick={() => void copy(t.address)} title={`Copy ${t.address}`}>
                {shortWallet(t.address)}
              </button>
            </div>
            <div className="ct-act">
              {onPick ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPick(t.address)}>
                  Use for a router
                </button>
              ) : (
                <Link className="btn btn-ghost btn-sm" href={`/router?token=${t.address}`} onClick={closeWallet}>
                  Router
                </Link>
              )}
              <a className="rt-exp" href={`${EXPLORER_URL}/tx/${t.creator.tx}`} target="_blank" rel="noopener noreferrer" title="The transaction that created it">
                Created ↗
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
