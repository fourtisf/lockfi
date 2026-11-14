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

interface UiState {
  query: string;
  setQuery: (q: string) => void;
  wallet: string | null;
  connect: () => void;
  toast: string | null;
  showToast: (message: string) => void;
  /**
   * An action that would sign a transaction. Nothing can be signed until the
   * contracts ship (P2), so the toast says exactly that instead of reporting a
   * success that did not happen.
   */
  act: (action: string) => void;
  stakePoolId: string | null;
  openStake: (poolId: string) => void;
  closeStake: () => void;
}

const UiContext = createContext<UiState | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  // Stays null until P2 wires a connector.
  const [wallet] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [stakePoolId, setStakePoolId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const act = useCallback(
    (action: string) => showToast(`${action} is a preview — no transaction was sent.`),
    [showToast],
  );

  // There is no wallet connector before P2. Pretending to connect one, with a
  // made-up address in the top bar, would be the first dishonest number on the
  // page, so the button says what is true instead.
  const connect = useCallback(() => {
    showToast('Wallets arrive with the contracts in P2. This preview sends nothing.');
  }, [showToast]);

  const value = useMemo<UiState>(
    () => ({
      query,
      setQuery,
      wallet,
      connect,
      toast,
      showToast,
      act,
      stakePoolId,
      openStake: setStakePoolId,
      closeStake: () => setStakePoolId(null),
    }),
    [query, wallet, connect, toast, showToast, act, stakePoolId],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiState {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
