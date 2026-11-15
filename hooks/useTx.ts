'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { Hash, TransactionReceipt } from 'viem';
import { useConfig } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { useUi } from '@/components/providers/UiProvider';
import { CHAIN } from '@/lib/chain';
import { RevertedOnChainError, UnconfirmedError, explainError } from '@/lib/contracts/errors';
import { explorerTx } from '@/lib/contracts/tx';

/** How long to wait for a receipt before pointing at the explorer instead. */
const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Sends one transaction and narrates it: confirm in the wallet, sent (with
 * the explorer link), then confirmed or failed in a sentence. A reverted
 * receipt is a failure, never a success, and a slow one is "check the
 * explorer", never "failed" — it may still land.
 */
export function useTx() {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { showToast } = useUi();

  const send = useCallback(
    async (label: string, write: () => Promise<Hash>): Promise<TransactionReceipt> => {
      showToast({ message: `${label} — confirm in your wallet`, busy: true });
      const hash = await write();
      showToast({ message: `${label} — sent, waiting for confirmation`, busy: true, link: explorerTx(hash) });
      let receipt: TransactionReceipt;
      try {
        receipt = await waitForTransactionReceipt(config, { hash, chainId: CHAIN.id, timeout: RECEIPT_TIMEOUT_MS });
      } catch (err) {
        throw new UnconfirmedError(hash, err);
      } finally {
        // Whatever happened, the wallet's figures may have changed.
        void queryClient.invalidateQueries();
      }
      if (receipt.status !== 'success') throw new RevertedOnChainError(hash);
      showToast({ message: `${label} — confirmed`, link: explorerTx(hash) });
      return receipt;
    },
    [config, queryClient, showToast],
  );

  const fail = useCallback(
    (label: string, err: unknown) => {
      const hash = (err as { hash?: string } | null)?.hash;
      showToast({
        message: `${label}: ${explainError(err)}`,
        link: hash ? explorerTx(hash) : undefined,
        ms: hash ? 14_000 : 9_000,
      });
    },
    [showToast],
  );

  return { send, fail, config, showToast };
}
