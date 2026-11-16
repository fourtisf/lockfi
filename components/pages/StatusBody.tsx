'use client';

import { useQuery } from '@tanstack/react-query';
import { shortAddress } from '@/components/ui/CopyAddress';
import { useTokenLive } from '@/hooks/useTokenLive';
import { DATA_SOURCE } from '@/lib/data';
import { count, lagLabel } from '@/lib/format';

const API_BASE = (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';
const LIVE = DATA_SOURCE === 'live';

interface Health {
  status: string;
  message?: string;
  indexed?: { lastBlock: string; at: string; lagSeconds: number } | null;
  pools?: number;
  swaps?: number;
  usdg?: string | null;
  usdgSource?: string;
  usdgNote?: string;
  keeper?: { status?: string; message?: string };
  vaultWatch?: { message?: string; vaults?: { vault: string; poolId: string; ageSeconds: number | null; historyHours?: number; stale?: boolean }[] };
}

const STATUS_WORDS: Record<string, string> = {
  ok: 'Up to date',
  'catching-up': 'Catching up',
  stalled: 'Stalled',
  'never-indexed': 'Not started',
  misconfigured: 'Misconfigured',
  'keeper-overdue': 'Keeper overdue',
};

function ago(iso: string | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return `${lagLabel(s)} ago`;
}

/**
 * What the services behind the live site are doing (§31), read from
 * /api/health and /api/token every 15 seconds: the indexer and how far
 * behind it is, the USD anchor, the vault watcher, the keeper and the token
 * curve. The same facts the top bar's chip summarises, in full.
 */
export function StatusBody() {
  const { data: health, isError } = useQuery({
    queryKey: ['health-page'],
    enabled: LIVE,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Health> => {
      // 503 is an answer here (stalled, misconfigured): read its body too.
      const r = await fetch(`${API_BASE}/api/health`);
      return (await r.json()) as Health;
    },
  });
  const { token } = useTokenLive();

  if (!LIVE) {
    return (
      <section className="card pg-card">
        <h2 className="sect-h">Simulated build</h2>
        <p className="pg-note">
          This build shows simulated data. There is no indexer, vault watcher or keeper behind it, so there is no status to
          report. The live site reports each of them here.
        </p>
      </section>
    );
  }

  return (
    <div className="pg-stack">
      <section className="card pg-card" aria-labelledby="s-idx">
        <h2 id="s-idx" className="sect-h">
          Indexer{' '}
          <span className="pill brand">{health ? STATUS_WORDS[health.status] ?? health.status : isError ? 'Unreachable' : 'Reading…'}</span>
        </h2>
        {health?.message && <p className="pg-note">{health.message}</p>}
        {isError && <p className="pg-note">The API did not answer just now. This retries every 15 seconds.</p>}
        <dl className="pg-dl">
          <div>
            <dt>Behind the chain</dt>
            <dd className="num">{health?.indexed ? lagLabel(health.indexed.lagSeconds) : '—'}</dd>
            <span className="pg-sub">pool figures are as of the last block read</span>
          </div>
          <div>
            <dt>Last block read</dt>
            <dd className="num">{health?.indexed ? count(Number(health.indexed.lastBlock)) : '—'}</dd>
            <span className="pg-sub">{health?.indexed ? new Date(health.indexed.at).toUTCString().replace(' GMT', ' UTC') : ''}</span>
          </div>
          <div>
            <dt>Pools · swaps</dt>
            <dd className="num">
              {health?.pools !== undefined ? count(health.pools) : '—'} · {health?.swaps !== undefined ? count(health.swaps) : '—'}
            </dd>
            <span className="pg-sub">read from the chain so far</span>
          </div>
        </dl>
        {health?.usdg && (
          <p className="pg-note">
            USD anchor: USDG <code className="num">{shortAddress(health.usdg)}</code>
            {health.usdgSource ? ` (${health.usdgSource})` : ''}. {health.usdgNote ?? ''}
          </p>
        )}
      </section>

      <section className="card pg-card" aria-labelledby="s-vw">
        <h2 id="s-vw" className="sect-h">Vault figures</h2>
        <p className="pg-note">{health?.vaultWatch?.message ?? 'Each vault’s pool is read directly from the chain, apart from the indexer.'}</p>
        <div className="pg-rows">
          {(health?.vaultWatch?.vaults ?? []).map((v) => (
            <div className="ca-row" key={v.vault}>
              <span className="ca-label">Vault {shortAddress(v.vault)}</span>
              <code className="num ca-addr">
                {v.ageSeconds === null ? 'not read yet' : `read ${lagLabel(v.ageSeconds)} ago`}
                {v.stale ? ' · stale' : ''}
              </code>
            </div>
          ))}
        </div>
      </section>

      <section className="card pg-card" aria-labelledby="s-tok">
        <h2 id="s-tok" className="sect-h">Token curve</h2>
        <p className="pg-note">
          {token
            ? token.graduated
              ? `$${token.symbol} has graduated from the ${token.launchpad} curve.`
              : `$${token.symbol} on the ${token.launchpad} curve, read ${ago(token.asOf)}. ${
                  token.verified ? 'The replay of every trade matches the curve’s reserves.' : 'The replay does not match the curve’s reserves yet; its change and chart are withheld.'
                }`
            : 'Reading the token’s launchpad curve…'}
        </p>
      </section>

      <section className="card pg-card" aria-labelledby="s-kp">
        <h2 id="s-kp" className="sect-h">Keeper</h2>
        <p className="pg-note">{health?.keeper?.message ?? 'Vaults need no keeper: fees are credited whenever anyone deposits, withdraws, claims or pokes.'}</p>
      </section>
    </div>
  );
}
