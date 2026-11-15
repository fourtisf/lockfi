'use client';

import { useEffect, useState } from 'react';
import { EXPLORER } from '@/lib/chain';

/** 0x1234…cdef: enough to recognise, never enough to trust — the copy is the whole address. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A contract address a person can check and copy: its label, the short form,
 * a Copy button that copies the whole address, and a link to the explorer.
 */
export function CopyAddress({ label, address }: { label: string; address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Older browsers and insecure contexts: a hidden textarea still copies.
      const ta = document.createElement('textarea');
      ta.value = address;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
  };

  return (
    <div className="ca-row">
      <span className="ca-label">{label}</span>
      <code className="num ca-addr" title={address}>
        {shortAddress(address)}
      </code>
      <button type="button" className="ca-copy" onClick={() => void copy()} aria-label={`Copy ${label} address`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <a
        className="ca-link"
        href={`${EXPLORER}/address/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${label} on the explorer`}
        title="Open on the explorer"
      >
        ↗
      </a>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} address copied` : ''}
      </span>
    </div>
  );
}
