'use client';

/**
 * "Your tokens" on the Router page before the factory is deployed: the
 * wallet's own tokens are found the moment it connects, so a team can see
 * the router will know them, and which launch it was, before it opens.
 */

import { useEffect, useState } from 'react';
import { useUi } from '@/components/providers/UiProvider';
import { CreatedTokensList } from './CreatedTokensList';
import { detectReachable, useCreatedTokens } from './useCreatedTokens';

export function RouterMine() {
  const { wallet, openWallet } = useUi();
  const found = useCreatedTokens(wallet?.address);
  // decided after the first paint: the override lives in this browser's storage
  const [reachable, setReachable] = useState(false);
  useEffect(() => setReachable(detectReachable()), []);
  if (!reachable) return null;
  return (
    <div className="card panel" style={{ marginBottom: 16 }} data-testid="router-mine">
      <h2 className="sect-h" style={{ marginBottom: 8 }}>Your tokens</h2>
      {wallet ? (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            Tokens this wallet created, found from the transactions that created them, launches on Pons included. The router
            opens for them once it is deployed on this chain.
          </p>
          <CreatedTokensList found={found} />
        </>
      ) : (
        <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p className="hint" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            Connect the wallet you launched from and LockFi finds every token it created, launches on Pons included.
          </p>
          <button type="button" className="btn btn-brand btn-sm" onClick={openWallet}>
            Connect wallet
          </button>
        </div>
      )}
    </div>
  );
}
