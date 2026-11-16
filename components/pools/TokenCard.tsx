'use client';

import { CopyAddress } from '@/components/ui/CopyAddress';
import { Mark } from '@/components/shell/Logo';
import { Spark } from '@/components/ui/Sparkline';
import { useTokenLive } from '@/hooks/useTokenLive';
import { EXPLORER } from '@/lib/chain';
import { DATA_SOURCE } from '@/lib/data';
import { ageLabel, count, priceTiny, signedPct, tone, usd } from '@/lib/format';
import { BRAND, TOKEN_CA, TOKEN_LAUNCH } from '@/lib/site';

function eth(n: number, digits = 3): string {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: digits })} ETH`;
}

/** "24h", or the token's age while it is younger than a day: "since launch · 3h", "· 26m". */
function windowLabel(hours: number): string {
  if (hours >= 23.99) return '24h';
  return `since launch · ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : ageLabel(hours)}`;
}

/**
 * $TIDEWELL, on the page people land on (§30). While it trades on its
 * launchpad's bonding curve it has no Uniswap pool, so it is not on the
 * boards and cannot be staked; this card reads the curve instead
 * (/api/token): price, FDV, the move and the volume since launch or over
 * 24h, the ETH the curve holds, the CA to copy and where to buy.
 */
export function TokenCard() {
  const { token, failed } = useTokenLive();
  if (!TOKEN_CA || !TOKEN_LAUNCH) return null;
  const cfg = TOKEN_LAUNCH;
  const live = DATA_SOURCE === 'live';
  const graduated = token?.graduated === true;

  return (
    <section className="card tok-card" aria-labelledby="tok-card-h">
      <div className="tok-head">
        <span className="tok-mark">
          <Mark size={30} />
        </span>
        <div className="tok-id">
          <h2 id="tok-card-h">${cfg.symbol}</h2>
          <span className="pill brand">{graduated ? 'Graduated from ' : 'Live on '}{cfg.launchpad}</span>
        </div>
        <div className="tok-acts">
          <a className="btn btn-brand" href={cfg.url} target="_blank" rel="noopener noreferrer">
            {graduated ? `View on ${cfg.launchpad}` : `Buy on ${cfg.launchpad}`} ↗
          </a>
          <a className="btn btn-quiet" href={`${EXPLORER}/token/${TOKEN_CA}`} target="_blank" rel="noopener noreferrer">
            Explorer ↗
          </a>
        </div>
      </div>

      {token && !graduated ? (
        <div className="tok-body">
          <dl className="tok-stats">
            <div>
              <dt>Price</dt>
              <dd className="num">{token.priceUsd !== null ? priceTiny(token.priceUsd) : '—'}</dd>
              <span className="num tok-sub">{token.priceEth !== null ? `${token.priceEth.toExponential(3)} ETH` : ''}</span>
            </div>
            <div>
              <dt>FDV</dt>
              <dd className="num">{token.fdvUsd !== null ? usd(token.fdvUsd) : '—'}</dd>
              <span className="tok-sub">{count(token.supply)} supply</span>
            </div>
            <div>
              <dt>Change</dt>
              <dd className={`num ${token.changePct !== null ? tone(token.changePct, 1) : 'muted'}`}>
                {token.changePct !== null ? signedPct(token.changePct) : '—'}
              </dd>
              <span className="tok-sub">{token.changeHours !== null ? windowLabel(token.changeHours) : 'not read yet'}</span>
            </div>
            <div>
              <dt>Volume</dt>
              <dd className="num">{token.volumeUsd !== null ? usd(token.volumeUsd) : eth(token.volumeEth)}</dd>
              <span className="tok-sub">
                {windowLabel(token.volumeHours)} · {count(token.trades)} {token.trades === 1 ? 'trade' : 'trades'}
              </span>
            </div>
            <div>
              <dt>In the curve</dt>
              <dd className="num">{eth(token.ethInCurve)}</dd>
              <span className="tok-sub">real ETH held</span>
            </div>
          </dl>
          {token.history.length > 1 && (
            <div className="tok-chart" title={`Price after each trade, ${windowLabel(token.volumeHours)}`}>
              <Spark values={token.history.map((h) => h.p)} w={220} h={64} className="tok-spark" />
            </div>
          )}
        </div>
      ) : (
        <p className="tok-note">
          {graduated
            ? token?.uniswapPool
              ? `$${cfg.symbol} has graduated from the ${cfg.launchpad} curve to a Uniswap v4 pool (${
                  token.uniswapPool.fee & 0x800000 ? 'dynamic fee' : `${token.uniswapPool.fee / 10_000}% fee`
                }). Its figures join the boards as the indexer reads that pool. ${
                  token.uniswapPool.vaultEligible
                    ? `The pool has no hook, so a ${BRAND} vault can hold it: staking opens when one is deployed.`
                    : `The pool runs a hook, so a ${BRAND} vault cannot hold it.`
                }`
              : `$${cfg.symbol} has graduated from the ${cfg.launchpad} curve. Looking up its Uniswap pool…`
            : !live
              ? `Live price, FDV and volume show on the live site, read from the ${cfg.launchpad} curve on chain.`
              : failed
                ? `The ${cfg.launchpad} curve could not be read just now. This retries on its own.`
                : `Reading the ${cfg.launchpad} curve…`}
        </p>
      )}

      <div className="tok-foot">
        <CopyAddress label={`$${cfg.symbol} contract`} address={TOKEN_CA} />
        <p className="tok-note">
          Read from the {cfg.launchpad} curve contract on chain. Staking opens once ${cfg.symbol} graduates to a Uniswap
          pool: {`Tidewell's`} vaults hold Uniswap v4 liquidity. FDV is price × total supply. Not financial advice.
        </p>
      </div>
    </section>
  );
}
