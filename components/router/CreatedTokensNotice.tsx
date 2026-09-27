'use client';

/**
 * Says so when a wallet that just connected turns out to have created
 * tokens, once per wallet per browser session. The list itself is in the
 * wallet dialog and on the Router page.
 */

import { useEffect } from 'react';
import { useUi } from '@/components/providers/UiProvider';
import { useCreatedTokens } from './useCreatedTokens';

const SEEN = 'lockfi:created-tokens-told:';

export function CreatedTokensNotice() {
  const { wallet, showToast } = useUi();
  const found = useCreatedTokens(wallet?.address);
  useEffect(() => {
    if (!wallet || found.status !== 'done' || found.tokens.length === 0) return;
    const key = SEEN + wallet.address.toLowerCase();
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      /* no session storage: say it every time rather than never */
    }
    const names = found.tokens.map((t) => t.symbol);
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    showToast(`Found ${names.length === 1 ? 'a token' : `${names.length} tokens`} you created: ${list}. See them in your wallet or on the Router page.`);
  }, [wallet, found, showToast]);
  return null;
}
