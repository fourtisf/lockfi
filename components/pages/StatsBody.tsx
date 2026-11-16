'use client';

import Link from 'next/link';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { CopyAddress } from '@/components/ui/CopyAddress';
import { useNow } from '@/hooks/useNow';
import { DATA_SOURCE } from '@/lib/data';
import { ageLabel, count, usd, usdFee } from '@/lib/format';
import { BRAND } from '@/lib/site';
import { statsTotals, vaultStats } from '@/lib/stats';

const money = (n: number | null) => (n === null ? '—' : n < 100 ? usdFee(n) : usd(n));

function when(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
}

/**
 * Every vault's record since deployment (§32), from its own events: what is
 * staked, by how many, the fees its stakers have earned and claimed, and
 * Tidewell's 10% — collected and paid to the treasury. Token totals are facts;
 * dollars are those facts at today's prices, and say so.
 */
export function StatsBody() {
  const { pools, vaults } = useMarket();
  const { openStake } = useUi();
  const now = useNow();
  const rows = vaults
    .map((v) => vaultStats(v, pools.find((p) => p.id === v.poolId)))
    .sort((a, b) => b.stakedUsd - a.stakedUsd);
  const t = statsTotals(rows);
  const live = DATA_SOURCE === 'live';
  const fee = vaults[0]?.protocolFeeBps;

  if (rows.length === 0) {
    return (
      <div className="card pg-card">
        <p className="pg-note">No vault is deployed yet, so there is nothing to report.</p>
      </div>
    );
  }

  return (
    <div className="pg-stack">
      <section className="card pg-card" aria-labelledby="st-sum">
        <h2 id="st-sum" className="sect-h">
          All vaults
        </h2>
        <dl className="pg-dl st-sum">
          <div>
            <dt>Staked now</dt>
            <dd className="num">{usd(t.stakedUsd)}</dd>
            <span className="pg-sub">
              in {rows.length} {rows.length === 1 ? 'vault' : 'vaults'}, at today&rsquo;s prices
            </span>
          </div>
          <div>
            <dt>Stakers now</dt>
            <dd className="num">{count(t.stakers)}</dd>
            <span className="pg-sub">
              {live ? `${count(t.everStakers)} have staked · ${count(t.deposits)} deposits` : 'simulated'}
            </span>
          </div>
          <div>
            <dt>Fees earned by stakers</dt>
            <dd className="num up">{money(t.feesToStakersUsd)}</dd>
            <span className="pg-sub">claimed so far {money(t.claimedUsd)}</span>
          </div>
          <div>
            <dt>{BRAND}&rsquo;s fee</dt>
            <dd className="num">{money(t.protocolUsd)}</dd>
            <span className="pg-sub">
              {fee !== undefined ? `${fee / 100}% of fees collected` : 'of fees collected'} · paid to treasury{' '}
              {money(t.protocolPaidUsd)}
            </span>
          </div>
        </dl>
        <p className="pg-note">
          From the vaults&rsquo; own events since deployment, read to the chain head. Fees count once the vault
          collects them, which every deposit, withdraw and claim does; fees earned since the last collection are in
          the position and count at the next one. No emissions: every dollar here was paid by a trader.
          {!live && ' This is a simulated build: since-deployment totals are read on the live site.'}
        </p>
      </section>

      <section className="card pg-card" aria-labelledby="st-v">
        <h2 id="st-v" className="sect-h">
          Every vault
        </h2>
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}>
          <table className="tbl st-tbl stack-sm">
            <thead>
              <tr>
                <th scope="col">Vault</th>
                <th scope="col" className="r">
                  Staked
                </th>
                <th scope="col" className="r">
                  Fees to stakers
                </th>
                <th scope="col" className="r st-hide">
                  {BRAND}&rsquo;s fee
                </th>
                <th scope="col" className="r">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tt = r.vault.totals;
                const since = when(tt?.stakedSince ?? null);
                const collected = tt?.lastCollectedAt && now !== null ? ageLabel((now - new Date(tt.lastCollectedAt).getTime()) / 3_600_000) : null;
                return (
                  <tr key={r.vault.address} className="static">
                    <td data-label="Vault">
                      <div className="n">
                        {r.label}{' '}
                        {tt && !tt.depositsOpen && <span className="pill down">deposits closed</span>}
                      </div>
                      <div className="s">
                        {count(r.stakers)} {r.stakers === 1 ? 'staker' : 'stakers'}
                        {since ? ` · since ${since}` : ''}
                        {collected ? ` · last collected ${collected} ago` : ''}
                      </div>
                    </td>
                    <td className="r num" data-label="Staked">
                      {usd(r.stakedUsd)}
                    </td>
                    <td className="r num" data-label="Fees to stakers">
                      <span className={r.feesToStakersUsd ? 'up' : undefined}>{money(r.feesToStakersUsd)}</span>
                      {r.feesToStakersTokens && <div className="hint">{r.feesToStakersTokens}</div>}
                    </td>
                    <td className="r num st-hide" data-label={`${BRAND}'s fee`}>
                      {money(r.protocolUsd)}
                    </td>
                    <td className="r">
                      <button className="btn btn-quiet btn-sm" onClick={() => openStake(r.vault.poolId)}>
                        Stake
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pg-rows">
          {rows.map((r) => (
            <CopyAddress key={r.vault.address} label={`Vault · ${r.label}`} address={r.vault.address} />
          ))}
        </div>
        <p className="pg-note">
          Each vault holds one Uniswap v4 pool&rsquo;s liquidity, full range. {BRAND}&rsquo;s fee is capped by each
          vault&rsquo;s contract and cannot be raised; withdrawals and claims cannot be closed by anyone. Every address
          and control is on <Link href="/contracts">Contracts</Link>.
        </p>
      </section>
    </div>
  );
}
