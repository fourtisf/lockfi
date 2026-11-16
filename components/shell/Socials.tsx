'use client';

import { useState } from 'react';
import { EXPLORER } from '@/lib/chain';
import { TELEGRAM_LABEL, TELEGRAM_URL, TOKEN_CA, X_HANDLE, X_URL } from '@/lib/site';

/** The X logo, drawn in currentColor. */
function XGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Icon link to Tidewell on X, for the top bar. */
export function XButton() {
  return (
    <a
      className="xbtn"
      href={X_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${X_HANDLE} on X`}
      title={`${X_HANDLE} on X`}
    >
      <XGlyph />
    </a>
  );
}

/** The Telegram plane, drawn in currentColor. */
function TelegramGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}

/** Icon link to Tidewell's Telegram channel, for the top bar. */
export function TelegramButton() {
  return (
    <a
      className="xbtn tgbtn"
      href={TELEGRAM_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Tidewell on Telegram"
      title={`Tidewell on Telegram · ${TELEGRAM_LABEL}`}
    >
      <TelegramGlyph />
    </a>
  );
}

/** Text link to Tidewell's Telegram channel, for the footer. */
export function TelegramLink() {
  return (
    <a className="xlink tglink" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
      <TelegramGlyph size={13} /> Telegram
    </a>
  );
}

/** Text link to Tidewell on X, for the footer. */
export function XLink() {
  return (
    <a className="xlink" href={X_URL} target="_blank" rel="noopener noreferrer">
      <XGlyph size={13} /> {X_HANDLE}
    </a>
  );
}

const CA_WARNING = `Only trust the CA shown on this site and on ${X_HANDLE}.`;

/**
 * The token's contract address, or "Coming soon" until there is one
 * (`TOKEN_CA` in lib/site.ts). With an address it can be copied and opened
 * on the explorer.
 */
export function CaChip({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!TOKEN_CA) {
    return (
      <span className="ca-chip" title={`The token's contract address is not out yet. ${CA_WARNING}`}>
        <span className="ca-k">CA</span>
        <span className="ca-v">
          {compact ? (
            <>
              <span className="ca-long">Coming soon</span>
              <span className="ca-short" aria-hidden="true">
                Soon
              </span>
            </>
          ) : (
            'Coming soon'
          )}
        </span>
      </span>
    );
  }
  const ca = TOKEN_CA;
  const short = `${ca.slice(0, 6)}…${ca.slice(-4)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ca);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: the address is still selectable on the explorer */
    }
  };
  return (
    <span className="ca-chip" title={CA_WARNING}>
      <span className="ca-k">CA</span>
      <a className="ca-v num" href={`${EXPLORER}/token/${ca}`} target="_blank" rel="noopener noreferrer" title={ca}>
        {compact ? (
          short
        ) : (
          // Whole where there is room; on a phone the 42 characters would push
          // the page sideways, so the short form shows and Copy still copies all.
          <>
            <span className="ca-long">{ca}</span>
            <span className="ca-short">{short}</span>
          </>
        )}
      </a>
      <button type="button" className="ca-copy" onClick={copy} aria-label="Copy contract address">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export { CA_WARNING };
