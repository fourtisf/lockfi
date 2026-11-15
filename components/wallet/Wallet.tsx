'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Connector } from 'wagmi';
import { useUi } from '@/components/providers/UiProvider';
import { useWallet } from '@/hooks/useWallet';
import { CHAIN } from '@/lib/chain';
import { explainError } from '@/lib/contracts/errors';
import { signingStatus } from '@/lib/contracts/status';
import { explorerAddress } from '@/lib/contracts/tx';
import { shortWallet } from '@/lib/format';

const ITEMS = 'button:not([disabled]), a[href]';

/**
 * A popover's open state: closes on Escape (returning focus to its trigger),
 * on a click outside, and focuses its first item when it opens.
 *
 * Escape is stopped here, so a popover inside the stake drawer closes itself
 * without also closing the drawer, whose listener sits on `document`.
 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return { open, setOpen, rootRef, triggerRef, panelRef, onKeyDown };
}

/** The wallets this browser offers, or why there are none. */
function WalletChoices({ onDone }: { onDone: () => void }) {
  const { choices, connect, connecting, connectError } = useWallet();
  const [picked, setPicked] = useState<string | null>(null);

  if (choices.length === 0) {
    return (
      <p className="wm-note">
        No browser wallet found. Install a wallet extension such as MetaMask, Rabby or Coinbase
        Wallet, then reload this page.
      </p>
    );
  }

  const choose = (c: Connector) => {
    setPicked(c.id);
    connect(c);
    onDone();
  };

  return (
    <>
      <div className="wm-h">Connect a browser wallet</div>
      {choices.map((c) => (
        <button key={c.uid} className="wm-item" onClick={() => choose(c)} disabled={connecting}>
          {c.icon ? (
            // An EIP-6963 icon is a data: URI the extension supplies; in an
            // <img> it can only ever be a picture.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.icon} alt="" width={20} height={20} />
          ) : (
            <span className="wm-dot" aria-hidden="true" />
          )}
          {c.id === 'injected' ? 'Browser wallet' : c.name}
          {connecting && picked === c.id && <span className="muted"> · check your wallet</span>}
        </button>
      ))}
      {connectError && (
        <p className="wm-note down" role="alert">
          {/rejected|denied|cancel/i.test(connectError.message)
            ? 'Connection cancelled in your wallet.'
            : explainError(connectError)}
        </p>
      )}
      <p className="wm-note">Connecting shares your address with this page. It cannot move funds without your signature.</p>
    </>
  );
}

/** The top bar's wallet control: connect, show the address, switch network, disconnect. */
export function WalletButton() {
  const wallet = useWallet();
  const { showToast } = useUi();
  const pop = usePopover();
  const { status, address } = wallet;

  // Picking a wallet keeps the list open, so a cancelled or failed connection
  // is explained where it was asked for. Once connected it closes; on the
  // wrong network it stays, now offering the switch.
  const previous = useRef(status);
  const { setOpen } = pop;
  useEffect(() => {
    if (previous.current !== 'ready' && status === 'ready') setOpen(false);
    previous.current = status;
  }, [status, setOpen]);

  const label =
    status === 'ready' && address
      ? shortWallet(address)
      : status === 'wrong-chain'
        ? 'Wrong network'
        : status === 'connecting'
          ? 'Connecting…'
          : 'Connect wallet';

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      showToast('Address copied.');
    } catch {
      showToast('Could not copy — select the address and copy it instead.');
    }
    pop.setOpen(false);
  };

  return (
    <div className="wm" ref={pop.rootRef} onKeyDown={pop.onKeyDown}>
      <button
        ref={pop.triggerRef}
        className={`btn btn-ghost${status === 'wrong-chain' ? ' wm-warn' : ''}`}
        onClick={() => pop.setOpen((o) => !o)}
        aria-expanded={pop.open}
        aria-haspopup="true"
        aria-label={status === 'ready' && address ? `Wallet ${address}` : label}
        title={status === 'ready' && address ? address : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M3 10h18M16 14.5h2" />
        </svg>
        <span className={`wallet-long${status === 'ready' ? ' num' : ''}`}>{label}</span>
      </button>

      {pop.open && (
        <div className="wm-pop" ref={pop.panelRef} role="group" aria-label="Wallet">
          {status === 'disconnected' || status === 'connecting' ? (
            <WalletChoices onDone={() => undefined} />
          ) : (
            <>
              <div className="wm-h">{wallet.connectorName ?? 'Wallet'}</div>
              <div className="wm-addr num">{address}</div>
              {status === 'wrong-chain' && (
                <>
                  <p className="wm-note">
                    Your wallet is on another network
                    {wallet.walletChainId ? <> (chain <span className="num">{wallet.walletChainId}</span>)</> : null}.
                    {' '}Tidewell runs on {CHAIN.name}.
                  </p>
                  <SwitchButton className="wm-item wm-strong" />
                </>
              )}
              {status === 'ready' && (
                <>
                  <button className="wm-item" onClick={copy}>
                    Copy address
                  </button>
                  {address && (
                    <a className="wm-item" href={explorerAddress(address)} target="_blank" rel="noopener noreferrer">
                      View on explorer
                    </a>
                  )}
                </>
              )}
              <button
                className="wm-item"
                onClick={() => {
                  wallet.disconnect();
                  pop.setOpen(false);
                  pop.triggerRef.current?.focus();
                }}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Asks the wallet to move to Robinhood Chain, adding the chain if it lacks it. */
function SwitchButton({ className }: { className: string }) {
  const { switchToChain, switching, switchError } = useWallet();
  return (
    <>
      <button className={className} onClick={switchToChain} disabled={switching}>
        {switching ? 'Check your wallet…' : `Switch to ${CHAIN.name}`}
      </button>
      {switchError && (
        <p className="wm-note down" role="alert">
          {explainError(switchError)}
        </p>
      )}
    </>
  );
}

/** "Connect wallet" in a form, opening the wallet list above the button. */
function ConnectButton({ className }: { className: string }) {
  const { status } = useWallet();
  const pop = usePopover();
  return (
    <div className="wm wm-inline" ref={pop.rootRef} onKeyDown={pop.onKeyDown}>
      <button
        ref={pop.triggerRef}
        className={className}
        onClick={() => pop.setOpen((o) => !o)}
        aria-expanded={pop.open}
        aria-haspopup="true"
        disabled={status === 'connecting'}
      >
        {status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
      </button>
      {pop.open && (
        <div className="wm-pop up" ref={pop.panelRef} role="group" aria-label="Connect a wallet">
          <WalletChoices onDone={() => pop.setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * Stands in for a signing button until it can sign: "Connect wallet" with no
 * wallet, "Switch to Robinhood Chain" on the wrong network, then the button.
 */
export function SignGate({ children, className = 'btn btn-brand' }: { children: ReactNode; className?: string }) {
  const { status } = useWallet();
  if (status === 'ready') return <>{children}</>;
  if (status === 'wrong-chain') {
    return (
      <div className="wm wm-inline">
        <SwitchButton className={className} />
      </div>
    );
  }
  return <ConnectButton className={className} />;
}

/**
 * §8 P5 asked for an external audit before mainnet; ALFA chose to launch
 * without one. While config/deployments.json says `audited: false`, every
 * signing button says so, in words, beside it: disclosure, not a blocker.
 */
export function AuditNotice({ className = '' }: { className?: string }) {
  if (!signingStatus().unaudited) return null;
  return (
    <p className={`audit ${className}`} role="note">
      <b>Not yet independently audited</b> — use at your own risk.
    </p>
  );
}
