'use client';

import { useUi } from '@/components/providers/UiProvider';

export function Toast() {
  const { toast } = useUi();
  return (
    <div
      className={`toast${toast ? ' on' : ''}${toast?.link ? ' has-link' : ''}`}
      role="status"
      aria-live="polite"
    >
      {toast?.busy && <i className="spin" aria-hidden="true" />}
      {toast && <span>{toast.message}</span>}
      {toast?.link && (
        <a href={toast.link} target="_blank" rel="noopener noreferrer">
          View on explorer
        </a>
      )}
    </div>
  );
}
