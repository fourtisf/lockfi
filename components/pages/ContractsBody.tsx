'use client';

import { useReadContracts } from 'wagmi';
import { useMarket } from '@/components/providers/MarketProvider';
import { CopyAddress, shortAddress } from '@/components/ui/CopyAddress';
import { CHAIN, CONTRACTS, EXPLORER } from '@/lib/chain';
import { deploymentFor } from '@/lib/contracts/deployments';
import { tidewellVaultAbi } from '@/lib/contracts/abis';
import { feeTierLabel, pairLabel } from '@/lib/pair';
import { BRAND, TOKEN_CA, TOKEN_LAUNCH } from '@/lib/site';

const deployment = deploymentFor(CHAIN.id);

/**
 * Every contract the site asks people to trust, in one place (§31): the
 * token, Tidewell's own contracts with the vault's controls read live from
 * the chain, and the Uniswap contracts underneath. Each can be copied whole
 * and opened on the explorer.
 */
export function ContractsBody() {
  const { pools, vaults } = useMarket();
  const first = deployment?.vaults[0]?.address;
  const reads = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(first), refetchInterval: 60_000 },
    contracts: first
      ? (['owner', 'treasury', 'protocolFeeBps', 'protocolFeeCapBps', 'depositsOpen'] as const).map((functionName) => ({
          address: first,
          abi: tidewellVaultAbi,
          functionName,
          chainId: CHAIN.id,
        }))
      : [],
  });
  const value = (i: number) => (reads.data?.[i]?.status === 'success' ? reads.data[i].result : undefined);
  const owner = value(0) as string | undefined;
  const treasury = value(1) as string | undefined;
  const feeBps = value(2) as number | bigint | undefined;
  const capBps = value(3) as number | bigint | undefined;
  const open = value(4) as boolean | undefined;
  const pct = (bps: number | bigint | undefined) => (bps === undefined ? '—' : `${Number(bps) / 100}%`);

  const vaultLabel = (poolId: string) => {
    const pool = pools.find((p) => p.id.toLowerCase() === poolId.toLowerCase());
    if (pool) return `Vault · ${pairLabel(pool)} · ${feeTierLabel(pool)}`;
    const live = vaults.find((v) => v.poolId.toLowerCase() === poolId.toLowerCase())?.live;
    return live ? `Vault · ${live.currencies[0].symbol} / ${live.currencies[1].symbol}` : `Vault · pool ${shortAddress(poolId.replace(/^v4:/, ''))}`;
  };

  return (
    <div className="pg-stack">
      {TOKEN_CA && TOKEN_LAUNCH && (
        <section className="card pg-card" aria-labelledby="c-token">
          <h2 id="c-token" className="sect-h">${TOKEN_LAUNCH.symbol}</h2>
          <p className="pg-note">
            The token, and the {TOKEN_LAUNCH.launchpad} bonding curve it trades on until it graduates to a Uniswap pool.
          </p>
          <div className="pg-rows">
            <CopyAddress label={`$${TOKEN_LAUNCH.symbol} token`} address={TOKEN_CA} />
            <CopyAddress label={`${TOKEN_LAUNCH.launchpad} curve`} address={TOKEN_LAUNCH.curve} />
          </div>
        </section>
      )}

      <section className="card pg-card" aria-labelledby="c-tw">
        <h2 id="c-tw" className="sect-h">{BRAND} contracts</h2>
        {deployment ? (
          <>
            <p className="pg-note">
              On {deployment.network} (chain {CHAIN.id}).{' '}
              <b>{deployment.audited ? 'Independently audited.' : 'Not yet independently audited — use at your own risk.'}</b>
            </p>
            <div className="pg-rows">
              {deployment.zap && <CopyAddress label="Zap (stake with one token)" address={deployment.zap} />}
              {deployment.shaper && <CopyAddress label="Shaper (shaped positions)" address={deployment.shaper} />}
              {deployment.vaults.map((v) => (
                <CopyAddress key={v.address} label={vaultLabel(v.poolId)} address={v.address} />
              ))}
              {deployment.routerFactory && <CopyAddress label="Router factory" address={deployment.routerFactory} />}
            </div>
          </>
        ) : (
          <p className="pg-note">Nothing is deployed on this chain yet.</p>
        )}
      </section>

      {deployment && first && (
        <section className="card pg-card" aria-labelledby="c-ctl">
          <h2 id="c-ctl" className="sect-h">Vault controls</h2>
          <p className="pg-note">
            Read live from {vaultLabel(deployment.vaults[0].poolId).replace(/^Vault · /, 'the ')} vault. Vaults added later
            are deployed with the same owner, treasury and fee.
          </p>
          <dl className="pg-dl">
            <div>
              <dt>{BRAND} fee</dt>
              <dd className="num">{pct(feeBps)}</dd>
              <span className="pg-sub">of fees collected, never from deposits</span>
            </div>
            <div>
              <dt>Fee cap</dt>
              <dd className="num">{pct(capBps)}</dd>
              <span className="pg-sub">fixed when the vault was deployed; cannot be raised</span>
            </div>
            <div>
              <dt>New deposits</dt>
              <dd>{open === undefined ? '—' : open ? 'Open' : 'Closed'}</dd>
              <span className="pg-sub">withdrawals and claims cannot be closed by anyone</span>
            </div>
          </dl>
          <div className="pg-rows">
            {owner && <CopyAddress label="Owner" address={owner} />}
            {treasury && <CopyAddress label="Treasury (receives the fee)" address={treasury} />}
            {deployment.keeper && <CopyAddress label="Keeper (triggers routers, holds nothing)" address={deployment.keeper} />}
          </div>
        </section>
      )}

      <section className="card pg-card" aria-labelledby="c-uni">
        <h2 id="c-uni" className="sect-h">Uniswap contracts underneath</h2>
        <p className="pg-note">
          {BRAND} builds on Uniswap v4. Positions are Uniswap position NFTs in your own wallet; vaults hold Uniswap liquidity.
        </p>
        <div className="pg-rows">
          <CopyAddress label="PoolManager (v4)" address={CONTRACTS.poolManager} />
          <CopyAddress label="PositionManager (v4 NFTs)" address={CONTRACTS.positionManager} />
          <CopyAddress label="UniversalRouter" address={CONTRACTS.universalRouter} />
          <CopyAddress label="StateView" address={CONTRACTS.stateView} />
          <CopyAddress label="Permit2" address={CONTRACTS.permit2} />
          <CopyAddress label="WETH" address={CONTRACTS.weth} />
        </div>
        <p className="pg-note">
          Every address links to <a href={EXPLORER} target="_blank" rel="noopener noreferrer">the explorer</a>. Only trust
          addresses shown here and posted by {BRAND}&rsquo;s official accounts.
        </p>
      </section>
    </div>
  );
}
