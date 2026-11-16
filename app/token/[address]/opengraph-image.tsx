import { ImageResponse } from 'next/og';
import { initialSnapshot } from '@/lib/data/initial-snapshot';
import { price, usd } from '@/lib/format';
import { OG, OG_SIZE, OgFrame, ogFonts } from '@/lib/og/brand';
import { pairLabel } from '@/lib/pair';
import { DOMAIN } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'A token on Tidewell';

/** A token page's link card (§32): the token, its price and move, and the depth behind them, from its deepest pool. */
export default async function Image({ params }: { params: { address: string } }) {
  const a = params.address.toLowerCase();
  const snap = await initialSnapshot();
  const mine = (snap?.pools ?? []).filter((p) => p.token.address.toLowerCase() === a).sort((x, y) => y.tvlUsd - x.tvlUsd);
  const top = mine[0] ?? null;
  const depth = mine.reduce((s, p) => s + p.tvlUsd, 0);
  const ch = top?.change24hPct ?? null;
  // §7: a figure from an indexer that is behind says when it is from. The
  // page carries the lag in its top bar; an image travels without one.
  const lag = snap?.indexerLagSeconds ?? 0;
  const asOf =
    lag > 6 * 3600
      ? new Date(Date.now() - lag * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
      : null;

  return new ImageResponse(
    (
      <OgFrame footer={DOMAIN}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
          <div style={{ display: 'flex', fontFamily: 'Sora', fontWeight: 700, fontSize: 96, letterSpacing: -2 }}>
            {top ? top.token.symbol : 'Token'}
          </div>
          {top && <div style={{ display: 'flex', fontSize: 32, color: OG.soft }}>{top.token.name.slice(0, 40)}</div>}
        </div>
        {top ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 28, marginTop: 8 }}>
            <div style={{ display: 'flex', fontFamily: 'Plex', fontWeight: 600, fontSize: 84 }}>
              {top.priceUsd > 0 ? price(top.priceUsd) : '—'}
            </div>
            {ch !== null && Math.abs(ch) >= 0.05 && (
              <div style={{ display: 'flex', fontFamily: 'Plex', fontWeight: 600, fontSize: 44, color: ch > 0 ? OG.pos : OG.neg }}>
                {`${ch > 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}% 24h`}
              </div>
            )}
            {asOf && <div style={{ display: 'flex', fontSize: 26, color: OG.soft }}>{`as of ${asOf}`}</div>}
          </div>
        ) : null}
        <div style={{ display: 'flex', fontSize: 30, color: OG.soft, marginTop: 10 }}>
          {top
            ? `${usd(depth)} of depth across ${mine.length} ${mine.length === 1 ? 'pool' : 'pools'} · deepest ${pairLabel(top)}${top.marketCapUsd > 0 ? ` · FDV ${usd(top.marketCapUsd)}` : ''}`
            : 'Price, depth, fees and every pool, read from the chain.'}
        </div>
      </OgFrame>
    ),
    { ...OG_SIZE, fonts: await ogFonts(), headers: { 'cache-control': 'public, max-age=300' } },
  );
}
