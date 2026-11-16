'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenCard } from '@/components/pools/TokenCard';
import { Change } from '@/components/ui/Change';
import { CopyAddress } from '@/components/ui/CopyAddress';
import { PriceChart } from '@/components/ui/PriceChart';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { EXPLORER } from '@/lib/chain';
import { mintAvailability } from '@/lib/contracts/status';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool } from '@/lib/data/types';
import { ageLabel, price, signedPct, tone, usd } from '@/lib/format';
import { feeTierLabel, pairLabel } from '@/lib/pair';
import { BRAND, SITE_URL, TOKEN_CA, TOKEN_LAUNCH } from '@/lib/site';
import { feeYieldQualifier, feeYieldValue } from '@/lib/yield';
import { xPostHref } from '@/lib/x';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOLS_SHOWN = 8;
type Hours = 24 | 168;
interface Chart {
  poolId: string;
  hours: number;
  asOf: string | null;
  points: { t: string; p: number }[];
}

function useChart(poolId: string | null, hours: Hours): { chart: Chart | null; failed: boolean } {
  const [state, setState] = useState<{ key: string; chart: Chart | null; failed: boolean }>({ key: '', chart: null, failed: false });
  const key = `${poolId}:${hours}`;
  useEffect(() => {
    if (!poolId || DATA_SOURCE !== 'live') return;
    let gone = false;
    const load = () =>
      fetch(`/api/chart/${encodeURIComponent(poolId)}?hours=${hours}`)
        .then((r) => (r.ok ? (r.json() as Promise<Chart>) : Promise.reject(new Error(String(r.status)))))
        .then((chart) => !gone && setState({ key, chart, failed: false }))
        .catch(() => !gone && setState((s) => ({ key, chart: s.key === key ? s.chart : null, failed: true })));
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [poolId, hours, key]);
  return state.key === key ? { chart: state.chart, failed: state.failed } : { chart: null, failed: false };
}

/**
 * One token, on a page of its own (§32): a link that can be shared, with
 * the token's price, move and valuation from its deepest pool — the same
 * pool and figures its row on the boards shows — its price over the last day
 * or week from the indexer's own swaps, and every pool it trades in, each
 * with what can be done there: stake where a vault is, add liquidity where
 * the shaper can mint.
 */
function Head({ title }: { title: string }) {
  return (
    <div className="head">
      <div>
        <h1>{title}</h1>
        <p className="lede">Price, depth, fees and every pool it trades in, read from the chain.</p>
      </div>
    </div>
  );
}

export function TokenBody({ address }: { address: string }) {
  const { pools, vaults } = useMarket();
  const { openStake } = useUi();
  const valid = ADDRESS.test(address);
  const a = address.toLowerCase();
  const mine = valid ? pools.filter((p) => p.token.address.toLowerCase() === a).sort((x, y) => y.tvlUsd - x.tvlUsd) : [];
  const deepest: Pool | null = mine[0] ?? null;
  const [hours, setHours] = useState<Hours>(168);
  // CASHCAT trades in 51 pools, most of them empty: the deepest first, the rest on request.
  const [allPools, setAllPools] = useState(false);
  const { chart, failed } = useChart(deepest?.id ?? null, hours);
  const vaultPools = new Set(vaults.map((v) => v.poolId));

  if (!valid) {
    return (
      <>
        <Head title="Token" />
        <div className="card pg-card">
          <p className="pg-note">That is not a token address. A token page lives at /token/ followed by its contract address.</p>
        </div>
      </>
    );
  }

  const isOurToken = TOKEN_CA !== null && a === TOKEN_CA.toLowerCase();
  if (!deepest) {
    return (
      <div className="pg-stack">
        <Head title={isOurToken && TOKEN_LAUNCH ? `$${TOKEN_LAUNCH.symbol}` : 'Token'} />
        {isOurToken && <TokenCard />}
        {!isOurToken && (
          <section className="card pg-card">
            <div className="pg-rows">
              <CopyAddress label="Token contract" address={address} />
            </div>
            <p className="pg-note">
              This token is not on the boards. {BRAND} lists a token once one of its Uniswap pools has traded in the
              last day of what the indexer has read; a token still on a launchpad curve has no pool yet. Check the
              address on <a href={`${EXPLORER}/token/${address}`} target="_blank" rel="noopener noreferrer">the explorer</a>.
            </p>
          </section>
        )}
      </div>
    );
  }

  const token = deepest.token;
  const totalDepth = mine.reduce((s, p) => s + p.tvlUsd, 0);
  const totalVolume = mine.reduce((s, p) => s + p.volume24hUsd, 0);
  const totalFees = mine.reduce((s, p) => s + p.fees24hUsd, 0);
  const pts = chart?.points ?? [];
  const move = pts.length > 1 ? (pts[pts.length - 1].p / pts[0].p - 1) * 100 : null;
  const url = `${SITE_URL}/token/${token.address}`;
  const shareText = `$${token.symbol} on ${BRAND}: price, depth, fees and every pool, read from the chain.`;

  return (
    <div className="pg-stack">
      <Head title={token.symbol} />
      <section className="card pg-card tk-head" aria-labelledby="tk-h">
        <div className="tk-id">
          <TokenBadge token={token} />
          <div>
            <h2 id="tk-h" className="tk-sym">
              {token.symbol}
            </h2>
            <div className="muted tk-name">{token.name}</div>
          </div>
          <div className="tk-acts">
            <a className="btn btn-quiet btn-sm" href={xPostHref(shareText, url)} target="_blank" rel="noopener noreferrer">
              Share on X ↗
            </a>
            <a className="btn btn-quiet btn-sm" href={`${EXPLORER}/token/${token.address}`} target="_blank" rel="noopener noreferrer">
              Explorer ↗
            </a>
          </div>
        </div>
        <div className="pg-rows">
          <CopyAddress label={`${token.symbol} contract`} address={token.address} />
        </div>
        <dl className="pg-dl tk-stats">
          <div>
            <dt>Price</dt>
            <dd className="num">{deepest.priceUsd > 0 ? price(deepest.priceUsd) : '—'}</dd>
            <span className="pg-sub">
              <Change pct={deepest.change24hPct} refHours={deepest.change24hRefHours} /> 24h
            </span>
          </div>
          <div>
            <dt>{deepest.marketCapIsFdv ? 'FDV' : 'Market cap'}</dt>
            <dd className="num">{deepest.marketCapUsd > 0 ? usd(deepest.marketCapUsd) : '—'}</dd>
            <span className="pg-sub">{deepest.marketCapIsFdv ? 'price × total supply, locked tokens included' : ''}</span>
          </div>
          <div>
            <dt>Depth</dt>
            <dd className="num">{usd(totalDepth)}</dd>
            <span className="pg-sub">
              across {mine.length} {mine.length === 1 ? 'pool' : 'pools'}
            </span>
          </div>
          <div>
            <dt>Volume 24h</dt>
            <dd className="num">{usd(totalVolume)}</dd>
            <span className="pg-sub">fees paid to LPs {usd(totalFees)}</span>
          </div>
        </dl>
        <p className="pg-note">
          Price, move and valuation are from {token.symbol}&rsquo;s deepest pool, {pairLabel(deepest)} ·{' '}
          {feeTierLabel(deepest)} — the pool its row on the boards shows. Every figure is as of the last block the
          indexer read; the top bar shows how far behind that is.
        </p>
      </section>

      <section className="card pg-card" aria-labelledby="tk-chart">
        <div className="tk-chart-h">
          <h2 id="tk-chart" className="sect-h">
            Price
          </h2>
          {move !== null && (
            <span>
              <span className={`num ${tone(move, 1)}`}>{signedPct(move)}</span>{' '}
              <span className="muted">over {hours === 24 ? 'the day' : 'the week'}</span>
            </span>
          )}
          <div className="seg" role="group" aria-label="Chart window">
            {([24, 168] as const).map((h) => (
              <button key={h} className={hours === h ? 'on' : ''} aria-pressed={hours === h} onClick={() => setHours(h)}>
                {h === 24 ? '24h' : '7d'}
              </button>
            ))}
          </div>
        </div>
        {DATA_SOURCE !== 'live' ? (
          <p className="pg-note">
            The price chart shows on the live site: one close an hour from the indexer&rsquo;s own swaps, never a
            third-party feed.
          </p>
        ) : pts.length > 1 ? (
          <>
            <PriceChart
              points={pts}
              formatValue={price}
              caption={`${token.symbol} price, hourly closes, ${pairLabel(deepest)}`}
            />
            <p className="pg-note">
              Each point is the last trade of an hour in {pairLabel(deepest)} · {feeTierLabel(deepest)}, in dollars
              through ETH or USDG. An hour with no trade has no point.
            </p>
          </>
        ) : (
          <p className="pg-note">
            {failed
              ? 'The chart could not be read just now; this retries on its own.'
              : chart
                ? `Fewer than two hours with a trade in this window: nothing to draw yet.`
                : 'Reading the chart…'}
          </p>
        )}
      </section>

      <section className="card pg-card" aria-labelledby="tk-pools">
        <h2 id="tk-pools" className="sect-h">
          {token.symbol} trades in {mine.length} {mine.length === 1 ? 'pool' : 'pools'}
        </h2>
        <p className="pg-note">
          Anyone can open a pool for a token with its own fee and pair. Each is a separate market with its own
          liquidity, so its own trading, fees and yield. Deepest first.
        </p>
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}>
          <table className="tbl tk-pools stack-sm">
            <thead>
              <tr>
                <th scope="col">Pool</th>
                <th scope="col" className="r">
                  Depth
                </th>
                <th scope="col" className="r tk-hide">
                  Volume 24h
                </th>
                <th scope="col" className="r">
                  Fee yield 7d
                </th>
                <th scope="col" className="r">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(allPools ? mine : mine.slice(0, POOLS_SHOWN)).map((p) => {
                const hasVault = vaultPools.has(p.id);
                const mint = mintAvailability(p);
                const canMint = p.stakeable && (DATA_SOURCE !== 'live' || mint.ok);
                const why = !p.stakeable
                  ? 'on its launchpad'
                  : !mint.ok && mint.reason === 'no-eth-side'
                    ? 'no ETH side'
                    : !mint.ok && mint.reason === 'no-key'
                      ? 'Uniswap v3'
                      : 'not mintable here';
                const q = feeYieldQualifier(p.feeYield, ageLabel(p.feeYield.basis === 'estimate' ? p.feeYield.windowHours : p.ageHours));
                return (
                  <tr key={p.id} className="static">
                    <td data-label="Pool">
                      <div className="n">
                        {pairLabel(p)} <span className="pill">{feeTierLabel(p)}</span>
                        {hasVault && <span className="pill brand">Vault</span>}
                      </div>
                    </td>
                    <td className="r num" data-label="Depth">
                      {usd(p.tvlUsd)}
                    </td>
                    <td className="r num tk-hide" data-label="Volume 24h">
                      {usd(p.volume24hUsd)}
                    </td>
                    <td className="r num" data-label="Fee yield 7d">
                      {feeYieldValue(p.feeYield)}
                      {q && <span className="est"> {q}</span>}
                    </td>
                    <td className="r">
                      {hasVault ? (
                        <button className="btn btn-brand btn-sm" onClick={() => openStake(p.id)}>
                          Stake
                        </button>
                      ) : canMint ? (
                        <Link className="btn btn-quiet btn-sm" href={`/positions?pool=${encodeURIComponent(p.id)}`}>
                          Add liquidity
                        </Link>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {why}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {mine.length > POOLS_SHOWN && (
          <button className="btn btn-quiet btn-sm tk-more" aria-expanded={allPools} onClick={() => setAllPools((v) => !v)}>
            {allPools ? `Show the ${POOLS_SHOWN} deepest` : `Show all ${mine.length} pools`}
          </button>
        )}
      </section>
    </div>
  );
}
