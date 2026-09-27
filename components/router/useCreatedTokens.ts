'use client';

/**
 * The tokens the connected wallet created, found the moment it connects
 * (server/api/router-tokens.ts proves each on chain). One request per wallet
 * per page load, shared by everything that shows them: the wallet dialog,
 * the Router page and the notice on connect.
 *
 * The last answer for a wallet is kept in this browser and shown at once on
 * the next visit while a fresh one is asked for, because the first answer can
 * take the explorer's time per candidate.
 */

import { useEffect, useState } from 'react';
import { DATA_SOURCE } from '@/lib/data';
import { tokensCreatedBy, type Creator, type TokenMetaLite } from '@/lib/router/client';

export type CreatedToken = TokenMetaLite & { creator: Creator };

export interface CreatedTokens {
  /** `loading` with tokens is a kept answer being refreshed. */
  status: 'idle' | 'loading' | 'done' | 'error';
  tokens: CreatedToken[];
}

const STORE = 'lockfi:created-tokens:';
const inflight = new Map<string, Promise<CreatedToken[] | null>>();
const answered = new Map<string, CreatedToken[]>();
const listeners = new Set<() => void>();

/**
 * Simulated data has no API behind it. `localStorage['lockfi:router-detect'] = 'on'`
 * asks anyway, for a demo or a test that answers `/api/router/mine` itself.
 */
export function detectReachable(): boolean {
  if (DATA_SOURCE === 'live') return true;
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('lockfi:router-detect') === 'on';
  } catch {
    return false;
  }
}

function kept(wallet: string): CreatedToken[] | null {
  try {
    const raw = window.localStorage.getItem(STORE + wallet);
    const parsed = raw ? (JSON.parse(raw) as { tokens?: unknown }) : null;
    return Array.isArray(parsed?.tokens) ? (parsed!.tokens as CreatedToken[]) : null;
  } catch {
    return null;
  }
}

function keep(wallet: string, tokens: CreatedToken[]): void {
  try {
    window.localStorage.setItem(STORE + wallet, JSON.stringify({ tokens, at: Date.now() }));
  } catch {
    /* private mode: keeping is a convenience */
  }
}

/** Ask again for a wallet, e.g. after it has launched a token. */
export function refreshCreatedTokens(wallet: string): void {
  const w = wallet.toLowerCase();
  inflight.delete(w);
  answered.delete(w);
  listeners.forEach((l) => l());
}

export function useCreatedTokens(wallet: string | null | undefined): CreatedTokens {
  const w = wallet?.toLowerCase() ?? null;
  const [state, setState] = useState<CreatedTokens>({ status: 'idle', tokens: [] });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!w || !detectReachable()) {
      setState({ status: 'idle', tokens: [] });
      return;
    }
    const done = answered.get(w);
    if (done) {
      setState({ status: 'done', tokens: done });
      return;
    }
    setState({ status: 'loading', tokens: kept(w) ?? [] });
    let p = inflight.get(w);
    if (!p) {
      p = tokensCreatedBy(w);
      inflight.set(w, p);
    }
    let alive = true;
    void p.then((tokens) => {
      if (inflight.get(w) === p) inflight.delete(w);
      if (tokens) {
        answered.set(w, tokens);
        keep(w, tokens);
      }
      if (!alive) return;
      setState(tokens ? { status: 'done', tokens } : { status: 'error', tokens: kept(w) ?? [] });
    });
    return () => {
      alive = false;
    };
  }, [w, tick]);

  return state;
}
