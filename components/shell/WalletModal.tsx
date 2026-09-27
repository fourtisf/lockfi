'use client';

import { useEffect, useRef, useState } from 'react';
import { useUi } from '@/components/providers/UiProvider';
import { CreatedTokensList } from '@/components/router/CreatedTokensList';
import { useCreatedTokens } from '@/components/router/useCreatedTokens';
import { EXPLORER_URL } from '@/lib/chain';
import { shortWallet } from '@/lib/format';
import {
  KNOWN_WALLETS,
  WALLETCONNECT_ICON,
  WALLETCONNECT_PROJECT_ID,
  WALLETCONNECT_RDNS,
  connectWallet,
  connectWalletConnect,
  describeWalletError,
  discoverWallets,
  forgetWallet,
  rememberedWallet,
  restoreWalletConnect,
  silentAccount,
  walletIcon,
  type AnnouncedWallet,
} from '@/lib/wallet';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The wallet dialog.
 *
 * Always lists the wallets people have — MetaMask, Rabby, Coinbase Wallet,
 * Phantom, OKX, Trust, Brave — plus any other the browser announces
 * (EIP-6963), and WalletConnect for a phone when the site has a project id.
 * An installed wallet connects; one that is not gets an Install link. A
 * reload reconnects quietly to the remembered wallet if it still exposes an
 * account; nothing prompts without a click. Traps focus and closes on
 * Escape, like the stake drawer.
 */
export function WalletModal() {
  const { walletOpen, closeWallet, wallet, setWallet, showToast } = useUi();
  const created = useCreatedTokens(wallet?.address);
  const [announced, setAnnounced] = useState<AnnouncedWallet[]>([]);
  const [session, setSession] = useState<AnnouncedWallet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // Discover once, on the client, and keep listening: an extension can
  // announce itself after the page is up.
  useEffect(() => {
    const stop = discoverWallets((found) => {
      setAnnounced((prev) => (prev.some((w) => w.info.uuid === found.info.uuid) ? prev : [...prev, found]));
    });
    return stop;
  }, []);

  // Quiet reconnect to the remembered wallet.
  useEffect(() => {
    const rdns = rememberedWallet();
    if (!rdns || wallet) return;
    let cancelled = false;
    if (rdns === WALLETCONNECT_RDNS) {
      void restoreWalletConnect().then(async (restored) => {
        if (cancelled || !restored) return;
        const address = await silentAccount(restored);
        if (cancelled || !address) return;
        setSession(restored);
        setWallet({ address, name: restored.info.name, rdns, provider: restored.provider });
      });
      return () => {
        cancelled = true;
      };
    }
    const found = announced.find((w) => w.info.rdns === rdns);
    if (!found) return;
    void silentAccount(found).then((address) => {
      if (!cancelled && address) {
        setSession(found);
        setWallet({ address, name: found.info.name, rdns, provider: found.provider });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [announced, wallet, setWallet]);

  // Follow the connected wallet's own account changes and disconnects.
  useEffect(() => {
    if (!wallet || !session) return;
    const provider = session.provider;
    const on = provider.on?.bind(provider);
    const off = provider.removeListener?.bind(provider);
    if (!on || !off) return;
    const onAccounts = (payload: unknown) => {
      const next = Array.isArray(payload) && typeof payload[0] === 'string' ? (payload[0] as string) : null;
      if (!next) {
        forgetWallet();
        setWallet(null);
        showToast('Wallet disconnected');
      } else if (next.toLowerCase() !== wallet.address.toLowerCase()) {
        setWallet({ ...wallet, address: next });
      }
    };
    const onDisconnect = () => onAccounts([]);
    on('accountsChanged', onAccounts);
    on('disconnect', onDisconnect);
    return () => {
      off('accountsChanged', onAccounts);
      off('disconnect', onDisconnect);
    };
  }, [wallet, session, setWallet, showToast]);

  // Escape closes, Tab cycles inside, focus returns where it came from.
  useEffect(() => {
    if (!walletOpen) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeWallet();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusTo.current?.focus();
    };
  }, [walletOpen, closeWallet]);

  if (!walletOpen) return null;

  const finish = async (candidate: AnnouncedWallet) => {
    const address = await connectWallet(candidate);
    setSession(candidate);
    setWallet({ address, name: candidate.info.name, rdns: candidate.info.rdns, provider: candidate.provider });
    showToast(`Connected to ${candidate.info.name}`);
    closeWallet();
  };

  const choose = async (candidate: AnnouncedWallet) => {
    setBusy(candidate.info.uuid);
    setError(null);
    try {
      await finish(candidate);
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  const chooseWalletConnect = async () => {
    setBusy(WALLETCONNECT_RDNS);
    setError(null);
    try {
      await finish(await connectWalletConnect());
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    try {
      await (session?.provider as { disconnect?: () => Promise<void> } | undefined)?.disconnect?.();
    } catch {
      /* the session may already be gone */
    }
    forgetWallet();
    setSession(null);
    setWallet(null);
    showToast('Wallet disconnected');
    closeWallet();
  };

  const copy = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      showToast('Address copied');
    } catch {
      showToast(wallet.address);
    }
  };

  // The list: every known wallet, installed or not, then any other wallet
  // that announced itself, then the phone.
  const byRdns = new Map(announced.map((w) => [w.info.rdns, w] as const));
  const known = KNOWN_WALLETS.map((w) => ({ ...w, found: byRdns.get(w.rdns) ?? null }));
  const others = announced.filter((w) => !KNOWN_WALLETS.some((k) => k.rdns === w.info.rdns));
  const installed = known.filter((w) => w.found).length + others.length;

  return (
    <div className="modal-scrim" onClick={closeWallet} role="presentation">
      <div
        className="modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-h">
          <h2 id="wallet-title">{wallet ? 'Your wallet' : 'Connect a wallet'}</h2>
          <button className="x" onClick={closeWallet} aria-label="Close">
            ✕
          </button>
        </div>

        {wallet ? (
          <>
            <p className="lede">Connected with {wallet.name}.</p>
            <div className="wallet-addr num" title={wallet.address}>
              {wallet.address}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-ghost btn-sm" onClick={copy}>
                Copy
              </button>
              <a
                className="btn btn-ghost btn-sm"
                href={`${EXPLORER_URL}/address/${wallet.address}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Explorer
              </a>
              <button className="btn btn-ghost btn-sm" onClick={disconnect}>
                Disconnect
              </button>
            </div>
            <div className="ct-sect">
              <h3 className="lbl">Tokens you created</h3>
              <CreatedTokensList found={created} compact />
            </div>
            <p className="hint" style={{ marginTop: 14 }}>
              Every transaction here goes to Uniswap&rsquo;s contracts or to a LockFi Router you
              chose, and the node dry-runs it before your wallet is asked to sign.
            </p>
          </>
        ) : (
          <>
            <p className="lede">
              {installed > 0
                ? 'Pick a wallet. LockFi never takes custody: your positions stay in your wallet.'
                : 'No wallet extension is installed in this browser. Install one below, or scan with your phone.'}
            </p>
            <div className="wallet-list">
              {[...known.filter((w) => w.found).map((w) => w.found!), ...others].map((w) => (
                <button
                  key={w.info.uuid}
                  className="wallet-opt"
                  onClick={() => choose(w)}
                  disabled={busy !== null}
                >
                  {/* The wallet's own icon (a data: URI per the standard), else its known mark. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={walletIcon(w.info)} alt="" />
                  <span>
                    <span className="n">{w.info.name}</span>
                    <span className="s">{busy === w.info.uuid ? 'Waiting for the wallet…' : 'Installed'}</span>
                  </span>
                  <span className="act">Connect</span>
                </button>
              ))}

              {WALLETCONNECT_PROJECT_ID && (
                <button className="wallet-opt" onClick={chooseWalletConnect} disabled={busy !== null}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={WALLETCONNECT_ICON} alt="" />
                  <span>
                    <span className="n">WalletConnect</span>
                    <span className="s">
                      {busy === WALLETCONNECT_RDNS ? 'Waiting for your phone…' : 'Scan with any mobile wallet'}
                    </span>
                  </span>
                  <span className="act">Scan</span>
                </button>
              )}

              {known
                .filter((w) => !w.found)
                .map((w) => (
                  <a
                    key={w.rdns}
                    className="wallet-opt off"
                    href={w.install}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {/* Not installed, so nothing announced an icon: the mark this site serves. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.icon} alt="" />
                    <span>
                      <span className="n">{w.name}</span>
                      <span className="s">Not installed</span>
                    </span>
                    <span className="act">Install</span>
                  </a>
                ))}
            </div>
            {error && (
              <p className="hint down" role="alert" style={{ marginTop: 12 }}>
                {error}
              </p>
            )}
            <p className="hint" style={{ marginTop: 14 }}>
              The wallet is asked to switch to Robinhood Chain, and to add it if it has never seen
              it. Connecting signs nothing.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
