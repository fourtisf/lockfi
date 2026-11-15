'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** What a toast says, and optionally where to check it. */
export interface ToastInput {
  message: string;
  /** An explorer link for a transaction the toast is about. */
  link?: string;
  /** Still in progress (waiting for a signature or a receipt): stays up until replaced. */
  busy?: boolean;
  /** How long it stays up, when not busy. */
  ms?: number;
}

export interface ToastState extends ToastInput {
  id: number;
}

interface UiState {
  query: string;
  setQuery: (q: string) => void;
  toast: ToastState | null;
  showToast: (message: string | ToastInput) => void;
  /**
   * An action that would sign a transaction, on a surface where nothing can
   * be signed — the simulator, whose pools exist nowhere on chain. The toast
   * says exactly that instead of reporting a success that did not happen.
   */
  act: (action: string) => void;
  stakePoolId: string | null;
  openStake: (poolId: string) => void;
  closeStake: () => void;
}

const UiContext = createContext<UiState | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [stakePoolId, setStakePoolId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef(0);

  const showToast = useCallback((input: string | ToastInput) => {
    const next: ToastInput = typeof input === 'string' ? { message: input } : input;
    toastId.current += 1;
    setToast({ ...next, id: toastId.current });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    if (next.busy) return;
    toastTimer.current = setTimeout(() => setToast(null), next.ms ?? (next.link ? 10_000 : 3200));
  }, []);

  const act = useCallback(
    (action: string) => showToast(`${action} is a preview — no transaction was sent.`),
    [showToast],
  );

  const value = useMemo<UiState>(
    () => ({
      query,
      setQuery,
      toast,
      showToast,
      act,
      stakePoolId,
      openStake: setStakePoolId,
      closeStake: () => setStakePoolId(null),
    }),
    [query, toast, showToast, act, stakePoolId],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiState {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
