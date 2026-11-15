'use client';

import type { StakeForm } from '@/hooks/useStakeForm';
import { BRAND } from '@/lib/site';

/**
 * The deposit half of a stake form — how to pay in, how much — shared by the
 * stake panel on /stakes and the drawer, so they cannot drift apart.
 */
export function StakeFields({ form, idPrefix }: { form: StakeForm; idPrefix: string }) {
  return (
    <div className="sf">
      {form.options.length > 1 && (
        <>
          <div className="sf-k" id={`${idPrefix}-route-k`}>
            Deposit with
          </div>
          <div className="seg sf-route" role="group" aria-labelledby={`${idPrefix}-route-k`}>
            {form.options.map((o) => (
              <button
                key={String(o.route)}
                type="button"
                className={form.route === o.route ? 'on' : undefined}
                aria-pressed={form.route === o.route}
                onClick={() => form.setRoute(o.route)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {form.routeNote && <p className="note-s sf-note">{form.routeNote}</p>}
        </>
      )}

      {form.inputs.map((input) => (
        <div key={input.id} className="sf-field">
          <label htmlFor={`${idPrefix}-${input.id}`} className="sr-only">
            Amount to stake in {input.side.isEth && form.route !== 'both' ? 'ETH' : input.side.symbol}
          </label>
          <div className={`inp${input.matched ? ' matched' : ''}`}>
            <input
              id={`${idPrefix}-${input.id}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={input.amount}
              onChange={(e) => input.setAmount(e.target.value.replace(',', '.'))}
              aria-describedby={input.matched ? `${idPrefix}-${input.id}-m` : undefined}
            />
            <span className="unit">{input.side.isEth && form.route !== 'both' ? 'ETH' : input.side.symbol}</span>
            {input.maxLabel !== null && (
              <span className="bal num" title="Your balance you can stake">
                {input.maxLabel}
              </span>
            )}
          </div>
          {input.matched && (
            <p className="note-s sf-matched" id={`${idPrefix}-${input.id}-m`}>
              Matched to the pool&rsquo;s ratio by the vault. Type here to set this side instead.
            </p>
          )}
        </div>
      ))}

      {/* Shares of a balance need a balance: no wallet, no chips. */}
      {form.hasBalance && (
        <div className="quick" role="group" aria-label="Share of balance">
          {form.shares.map((f) => (
            <button key={f} type="button" onClick={() => form.setShare(f)}>
              {f === 1 ? 'Max' : `${f * 100}%`}
            </button>
          ))}
        </div>
      )}
      <p className="note-s" style={{ textAlign: 'left' }}>
        {form.minLabel}
      </p>
    </div>
  );
}

/** What the deposit would be and earn, and what it costs — disclosed before signing (§7). */
export function StakeOutputs({ form, className = 'out' }: { form: StakeForm; className?: string }) {
  const q = form.quote;
  return (
    <div className={className}>
      <div>
        <span>{q?.shareOf === 'vault' ? 'Your share of the vault' : 'Your share of pool'}</span>
        <b className="num">{((q?.share ?? 0) * 100).toFixed(2)}%</b>
      </div>
      <div>
        <span title={form.view?.yieldTitle}>
          Est. weekly fees · {form.view?.live ? "the vault's trailing 7d" : 'from trailing 7d'}
        </span>
        <b className="num">{form.weeklyLabel ?? '—'}</b>
      </div>
      <div>
        <span>{BRAND} fee</span>
        <b className="num">{form.feeLabel}</b>
      </div>
      <div>
        <span>Lockup</span>
        <b>None — withdraw any time</b>
      </div>
    </div>
  );
}
