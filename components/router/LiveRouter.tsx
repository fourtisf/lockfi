'use client';

/**
 * The router, live (§48): create one for a token, see what every router holds
 * and has routed, and manage your own.
 *
 * Everything here is read from the contracts (lib/router/client.ts) and sent
 * through the person's own wallet. The keeper routes on the schedule; the
 * team can also route at any time, pause, and withdraw what is not routed.
 *
 * A token and its pools come from the API's lookups (§49), proved on chain,
 * not from the board: the indexer is weeks behind, and a token launched
 * since would otherwise have no pool to route into. A connected wallet's own
 * tokens are found for it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { EXPLORER_URL, ROUTER_FACTORY, ROUTER_FEE_BPS, deadlineFromNow, isEther } from '@/lib/chain';
import { duration, feeTierLabel, shortWallet, usd } from '@/lib/format';
import {
  ZERO_HOOK,
  allRouters,
  creatorsOf,
  describeRouterError,
  lookupToken,
  readRouters,
  teamMinRate,
  tokensCreatedBy,
  type Creator,
  type RouterPool,
  type RouterView,
  type TokenLookup,
  type TokenMetaLite,
} from '@/lib/router/client';
import { FACTORY_ABI, ROUTER_ABI } from '@/lib/router/plan';
import { publicClient, walletClient } from '@/lib/v4/client';
import { describeWalletError, ensureChain } from '@/lib/wallet';
import type { Pool } from '@/lib/data/types';

const CADENCES = [
  { hours: 6, label: 'Every 6h' },
  { hours: 12, label: 'Every 12h' },
  { hours: 24, label: 'Every 24h' },
  { hours: 168, label: 'Weekly' },
];

/** A board token that trades against ETH: a starting point for the token picker. */
function againstEth(p: Pool): boolean {
  if (!p.key) return false;
  const other = p.key.currency0.toLowerCase() === p.token.address.toLowerCase() ? p.key.currency1 : p.key.currency0;
  return isEther(other);
}

function poolLabel(symbol: string, p: RouterPool): string {
  const fee = (p.key.fee & 0x800000) !== 0 ? 'dynamic fee' : feeTierLabel(p.key.fee / 100);
  const depth = p.liquidityUsd !== null ? usd(p.liquidityUsd) : BigInt(p.liquidity) > 0n ? 'liquidity on chain' : 'no liquidity yet';
  const hook = p.key.hooks !== ZERO_HOOK ? ' · hook' : '';
  return `${symbol} / ETH · Uniswap ${p.protocol} · ${fee}${hook} · ${depth}`;
}

function amount(wei: bigint, decimals = 18, digits = 4): string {
  const n = Number(formatUnits(wei, decimals));
  if (n === 0) return '0';
  if (n < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : digits });
}

export function LiveRouter() {
  const snap = useMarket();
  const { wallet, openWallet, showToast } = useUi();
  // the board's tokens against ETH, alphabetical: the picker's starting list
  const boardTokens = useMemo(() => {
    const by = new Map<string, TokenMetaLite>();
    for (const p of [...snap.pools, ...(snap.otherPools ?? [])]) {
      if (!againstEth(p)) continue;
      by.set(p.token.address.toLowerCase(), { address: p.token.address, symbol: p.token.symbol, name: p.token.name, decimals: p.token.decimals });
    }
    return [...by.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [snap.pools, snap.otherPools]);

  const [tokenAddr, setTokenAddr] = useState<string>('');
  const [pasted, setPasted] = useState('');
  const [lookup, setLookup] = useState<TokenLookup | null>(null);
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'missing'>('idle');
  const [myTokens, setMyTokens] = useState<(TokenMetaLite & { creator: Creator })[] | null>(null);
  const [poolId, setPoolId] = useState<string>('');
  const [hours, setHours] = useState(24);
  const [narrow, setNarrow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Address | null>(null);
  const [routers, setRouters] = useState<RouterView[] | null>(null);
  const [readError, setReadError] = useState(false);
  const [creators, setCreators] = useState<Record<string, Creator | null>>({});

  // the connected wallet's own tokens, once per wallet
  useEffect(() => {
    setMyTokens(null);
    if (!wallet) return;
    let live = true;
    void tokensCreatedBy(wallet.address).then((t) => {
      if (!live) return;
      setMyTokens(t ?? []);
      // open on the first of them, unless a token is already chosen
      if (t && t.length > 0) setTokenAddr((cur) => cur || t[0].address);
    });
    return () => {
      live = false;
    };
  }, [wallet]);

  // the chosen token: its creator and its pools, from the chain
  const chosen = tokenAddr || boardTokens[0]?.address || '';
  useEffect(() => {
    setLookup(null);
    setPoolId('');
    if (!chosen) return;
    let live = true;
    setLookupState('loading');
    void lookupToken(chosen).then((l) => {
      if (!live) return;
      setLookup(l);
      setLookupState(l ? 'idle' : 'missing');
    });
    return () => {
      live = false;
    };
  }, [chosen]);

  const pool = lookup?.pools.find((p) => p.id === poolId) ?? lookup?.pools[0];
  const iCreatedIt = Boolean(wallet && lookup?.creator && lookup.creator.address === wallet.address.toLowerCase());

  const symbolOf = useCallback(
    (token: string) => {
      const t = token.toLowerCase();
      const known = [...boardTokens, ...(myTokens ?? []), ...(lookup ? [lookup.token] : [])].find((x) => x.address.toLowerCase() === t);
      return known ? { symbol: known.symbol, decimals: known.decimals } : { symbol: shortWallet(token), decimals: 18 };
    },
    [boardTokens, myTokens, lookup],
  );

  const reload = useCallback(async () => {
    try {
      const client = publicClient();
      const views = await readRouters(client, await allRouters(client));
      setRouters(views);
      setReadError(false);
      setCreators(await creatorsOf([...new Set(views.map((v) => v.token))]));
    } catch {
      setReadError(true);
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);

  /** Sends one call through the connected wallet, after the node has run it. */
  const send = useCallback(
    async (label: string, address: Address, abi: typeof FACTORY_ABI, functionName: string, args: unknown[]): Promise<unknown> => {
      if (!wallet) {
        openWallet();
        return undefined;
      }
      setBusy(label);
      setError(null);
      try {
        await ensureChain(wallet.provider);
        const account = wallet.address as Address;
        const client = publicClient();
        const { request, result } = await client.simulateContract({ account, address, abi, functionName, args } as never);
        const hash = await walletClient(wallet.provider, account).writeContract(request as never);
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('The transaction reverted on chain.');
        await reload();
        return result;
      } catch (e) {
        setError(describeRouterError(e) ?? describeWalletError(e));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [wallet, openWallet, reload],
  );

  const create = async () => {
    if (!pool || !lookup || !ROUTER_FACTORY) return;
    const cadence = hours * 3600;
    const r = (await send(
      'Creating the router…',
      ROUTER_FACTORY,
      FACTORY_ABI,
      pool.protocol === 'v4' ? 'createV4' : 'createV3',
      pool.protocol === 'v4' ? [pool.key, lookup.token.address, cadence, narrow] : [pool.id, cadence, narrow],
    )) as Address | undefined;
    if (r) {
      setCreated(r);
      showToast(`Router created for ${lookup.token.symbol}`);
    }
  };

  const mine = (routers ?? []).filter((r) => wallet && r.team.toLowerCase() === wallet.address.toLowerCase());
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Router address copied');
    } catch {
      showToast('Could not copy — select the address instead');
    }
  };

  return (
    <>
      <div className="router">
        <div className="card panel">
          <h2 className="sect-h" style={{ marginBottom: 14 }}>Create a router</h2>
          {myTokens && myTokens.length > 0 && (
            <div className="field" data-testid="my-tokens">
              <span className="lbl">Your tokens</span>
              <div className="rt-mine">
                {myTokens.map((t) => (
                  <button
                    key={t.address}
                    type="button"
                    className={`btn btn-ghost btn-sm${chosen.toLowerCase() === t.address.toLowerCase() ? ' on' : ''}`}
                    onClick={() => {
                      setTokenAddr(t.address);
                      setCreated(null);
                    }}
                  >
                    {t.symbol}
                  </button>
                ))}
              </div>
              <p className="hint">Found from the transactions that created them: this wallet sent each one.</p>
            </div>
          )}

          <div className="field">
            <label htmlFor="r-token">Token</label>
            <div className="inp" style={{ height: 44 }}>
              <select
                id="r-token"
                value={boardTokens.some((t) => t.address.toLowerCase() === chosen.toLowerCase()) ? chosen : ''}
                onChange={(e) => {
                  setTokenAddr(e.target.value);
                  setCreated(null);
                }}
              >
                {!boardTokens.some((t) => t.address.toLowerCase() === chosen.toLowerCase()) && (
                  <option value="">{lookup ? `${lookup.token.symbol} · ${shortWallet(lookup.token.address)}` : 'Choose a token'}</option>
                )}
                {boardTokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol} · {shortWallet(t.address)}
                  </option>
                ))}
              </select>
            </div>
            <form
              className="rt-paste"
              onSubmit={(e) => {
                e.preventDefault();
                const a = pasted.trim();
                if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
                  setTokenAddr(a);
                  setCreated(null);
                  setPasted('');
                }
              }}
            >
              <label className="sr-only" htmlFor="r-paste">
                Or paste a token address
              </label>
              <div className="inp" style={{ height: 38 }}>
                <input id="r-paste" placeholder="Or paste a token address, 0x…" value={pasted} onChange={(e) => setPasted(e.target.value)} />
              </div>
              <button className="btn btn-ghost btn-sm" type="submit" disabled={!/^0x[0-9a-fA-F]{40}$/.test(pasted.trim())}>
                Look up
              </button>
            </form>
            {lookup && (
              <p className="hint" data-testid="token-creator">
                {iCreatedIt ? (
                  <span className="pill up">You created this token</span>
                ) : lookup.creator ? (
                  <>
                    Created by <code className="num">{shortWallet(lookup.creator.address)}</code>
                    {lookup.creator.via ? ' through a launchpad' : ''}. You can still create a router; it will show as not
                    the creator&apos;s.
                  </>
                ) : (
                  'Its creator could not be read just now.'
                )}
              </p>
            )}
            {lookupState === 'missing' && <p className="hint down">That address does not answer as a token on this chain, or the lookup failed. Try again.</p>}
          </div>

          <div className="field">
            <label htmlFor="r-pool">Destination pool</label>
            <div className="inp" style={{ height: 44 }}>
              <select id="r-pool" value={pool?.id ?? ''} onChange={(e) => setPoolId(e.target.value)} disabled={!lookup || lookup.pools.length === 0}>
                {lookupState === 'loading' && <option value="">Looking for pools on the chain…</option>}
                {lookup?.pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {poolLabel(lookup.token.symbol, p)}
                  </option>
                ))}
              </select>
            </div>
            {lookup && lookup.pools.length === 0 && (
              <p className="hint down">No pool with ETH on the other side was found for this token on Uniswap v3 or v4.</p>
            )}
            {pool && pool.key.hooks !== ZERO_HOOK && (
              <p className="hint" data-testid="hook-warning">
                This pool has a hook (<code className="num">{shortWallet(pool.key.hooks)}</code>): its code runs on every route.
                The router never pays more than it planned, but a hook can refuse a route.
              </p>
            )}
            <p className="hint">Fees become liquidity in this pool, and it cannot be changed later.</p>
          </div>

          <div className="field">
            <span className="lbl" id="r-trigger-label">
              Schedule
            </span>
            <div className="toggle" role="group" aria-labelledby="r-trigger-label">
              {CADENCES.map((c) => (
                <button key={c.hours} className={hours === c.hours ? 'on' : undefined} aria-pressed={hours === c.hours} onClick={() => setHours(c.hours)}>
                  {c.label}
                </button>
              ))}
            </div>
            <p className="hint">Market-cap milestones come in a later version.</p>
          </div>

          <div className="field">
            <span className="lbl" id="r-dest-label">
              Where it goes
            </span>
            <div className="toggle" role="group" aria-labelledby="r-dest-label">
              <button className={!narrow ? 'on' : undefined} aria-pressed={!narrow} onClick={() => setNarrow(false)}>
                Full range
              </button>
              <button className={narrow ? 'on' : undefined} aria-pressed={narrow} onClick={() => setNarrow(true)}>
                ±20% around price
              </button>
            </div>
            <p className="hint">Full range never goes out of position. Narrow adds more liquidity where traders actually are.</p>
          </div>

          <button
            className="btn btn-brand"
            style={{ width: '100%', justifyContent: 'center', height: 46 }}
            disabled={!pool || busy !== null}
            onClick={() => void create()}
          >
            {busy ?? (wallet ? 'Create router' : 'Connect wallet to create')}
          </button>
          {error && (
            <p className="hint down" role="alert" style={{ marginTop: 8 }}>
              {error}
            </p>
          )}

          {created && (
            <div className="note" style={{ marginTop: 12 }} data-testid="router-created">
              <b>Your router is live.</b>
              <div className="ca" style={{ marginTop: 8 }}>
                <code className="num">{created}</code>
                <div className="ca-actions">
                  <button type="button" className="btn btn-ghost sm" onClick={() => void copy(created)}>
                    Copy
                  </button>
                  <a className="btn btn-ghost sm" href={`${EXPLORER_URL}/address/${created}`} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </div>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Send your creator fees to this address. If your launchpad lets you choose where creator fees go, set it
                there; otherwise send ETH to it yourself. Whatever arrives is routed on your schedule.
              </p>
            </div>
          )}
        </div>

        <div className="card panel">
          <h2 className="sect-h">What happens next</h2>
          <div className="timeline">
            <div className="tl">
              <div className="w">
                Today<small>you create it</small>
              </div>
              <div>
                The router belongs to your wallet. Only you can pause it or withdraw what has not been routed yet.
              </div>
            </div>
            <div className="tl">
              <div className="w">
                {CADENCES.find((c) => c.hours === hours)?.label ?? 'Every 24h'}
                <small>keeper</small>
              </div>
              <div>
                What arrived is routed: {ROUTER_FEE_BPS / 100}% to LockFi, the rest part-swapped to the token in your pool and
                added to it, both sides.
                <div className="st">
                  The keeper routes only while the price is within 3% of its 30-minute average, and never below 1% of the
                  quote. It can trigger a route; it never receives funds.
                </div>
              </div>
            </div>
            <div className="tl">
              <div className="w">Ongoing</div>
              <div>The liquidity earns swap fees. Each route collects them and adds them back, with no LockFi fee on them.</div>
            </div>
            <div className="tl">
              <div className="w">Always</div>
              <div>Every route is a public transaction. Holders can verify on the explorer that fees became liquidity.</div>
            </div>
          </div>

          <div className="note" style={{ marginTop: 8 }}>
            <b>Routed liquidity is permanent.</b>
            <p className="hint">
              The router has no function that removes liquidity. Once fees become pool liquidity they cannot be withdrawn: not
              by you, not by LockFi, not by anyone. Pausing stops future routes and releases only fees not yet routed. The
              destination pool cannot be changed.
            </p>
          </div>
          <div className="note" style={{ marginTop: 12 }}>
            <b>Not audited.</b>
            <p className="hint">
              The router contract has been tested against Uniswap&apos;s own contracts but has not had an external audit.
              LockFi takes {ROUTER_FEE_BPS / 100}% of the ETH routed; the rate is fixed in the contract and can never be
              raised.
            </p>
          </div>
        </div>
      </div>

      {mine.length > 0 && (
        <div className="card panel" style={{ marginTop: 14 }}>
          <h2 className="sect-h">Your routers</h2>
          <div className="rt-list">
            {mine.map((r) => (
              <RouterRow key={r.address} r={r} meta={symbolOf(r.token)} creator={creators[r.token.toLowerCase()]} busy={busy} onCopy={copy}>
                {!r.paused && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy !== null || r.quoteBalance === 0n}
                    onClick={async () => {
                      try {
                        const minRate = await teamMinRate(publicClient(), r.address);
                        await send('Routing…', r.address, ROUTER_ABI, 'route', [minRate, BigInt(deadlineFromNow(300))]);
                      } catch (e) {
                        setError(describeRouterError(e) ?? describeWalletError(e));
                      }
                    }}
                  >
                    Route now
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== null}
                  onClick={() => void send(r.paused ? 'Resuming…' : 'Pausing…', r.address, ROUTER_ABI, 'setPaused', [!r.paused])}
                >
                  {r.paused ? 'Resume' : 'Pause'}
                </button>
                {r.paused && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy !== null || (r.quoteBalance === 0n && r.tokenBalance === 0n)}
                    onClick={() => void send('Withdrawing…', r.address, ROUTER_ABI, 'withdrawUnrouted', [wallet!.address])}
                  >
                    Withdraw unrouted
                  </button>
                )}
              </RouterRow>
            ))}
          </div>
        </div>
      )}

      <div className="card panel" style={{ marginTop: 14 }}>
        <h2 className="sect-h">All routers</h2>
        {routers === null ? (
          <p className="hint">{readError ? 'Could not read the routers from the chain just now.' : 'Reading the routers from the chain…'}</p>
        ) : routers.length === 0 ? (
          <p className="hint">No router yet. The first one is yours to create.</p>
        ) : (
          <div className="rt-list">
            {routers.map((r) => (
              <RouterRow key={r.address} r={r} meta={symbolOf(r.token)} creator={creators[r.token.toLowerCase()]} busy={busy} onCopy={copy} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RouterRow({
  r,
  meta,
  creator,
  onCopy,
  children,
}: {
  r: RouterView;
  meta: { symbol: string; decimals: number };
  /** The token's creator, per the chain; undefined while it is being read, null when it could not be. */
  creator?: Creator | null;
  busy: string | null;
  onCopy: (a: string) => void;
  children?: React.ReactNode;
}) {
  const now = Math.floor(Date.now() / 1000);
  const next = r.paused
    ? 'paused'
    : r.lastRouteAt === 0
      ? 'first route at the next keeper pass'
      : r.nextRouteAt <= now
        ? 'due now'
        : `next in ${duration(r.nextRouteAt - now)}`;
  return (
    <div className="rt-row" data-testid="router-row">
      <div className="rt-id">
        <b>
          {meta.symbol}{' '}
          {creator && creator.address === r.team.toLowerCase() ? (
            <span className="pill up" title="The wallet that created this router is the wallet that created the token.">
              token creator
            </span>
          ) : creator ? (
            <span className="pill grey" title={`The token was created by ${creator.address}; this router by ${r.team}.`}>
              not the creator
            </span>
          ) : null}
        </b>
        <span className="muted">
          Uniswap {r.isV4 ? 'v4' : 'v3'} · {r.narrow ? '±20%' : 'full range'} · every {duration(r.cadence)}
        </span>
        <button type="button" className="rt-addr num" title={r.address} onClick={() => onCopy(r.address)}>
          {shortWallet(r.address)}
        </button>
      </div>
      <div>
        <span className="lbl">Waiting</span>
        <span className="num">{amount(r.quoteBalance)} ETH</span>
      </div>
      <div>
        <span className="lbl">Routed</span>
        <span className="num">
          {amount(r.totalQuoteAdded)} ETH + {amount(r.totalTokenAdded, meta.decimals, 2)} {meta.symbol}
        </span>
      </div>
      <div>
        <span className="lbl">Routes</span>
        <span className="num">{r.routes}</span>
      </div>
      <div>
        <span className="lbl">Status</span>
        <span className={r.paused ? 'pill grey' : 'pill brand'}>{next}</span>
      </div>
      {children && <div className="rt-actions">{children}</div>}
      <a className="rt-exp" href={`${EXPLORER_URL}/address/${r.address}`} target="_blank" rel="noreferrer">
        Explorer ↗
      </a>
    </div>
  );
}

