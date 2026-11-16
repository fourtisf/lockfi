import { ImageResponse } from 'next/og';
import { fetchShareCard, shortWallet, sinceLabel } from '@/lib/data/share';
import { usd, usdFee } from '@/lib/format';
import { OG, OG_SIZE, OgFrame, ogFonts } from '@/lib/og/brand';
import { DOMAIN } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Fees earned staking on Tidewell';

/**
 * A wallet's share card (§32): what it has earned staking, worked out on
 * the server from the chain (server/api/share.ts) — the card cannot show a
 * figure the chain does not. No yield and no projection: fees earned, what
 * is staked, and since when.
 */
export default async function Image({ params }: { params: { address: string } }) {
  const card = await fetchShareCard(params.address);
  const fees = card?.feesEarnedUsd ?? null;
  const pairs = card?.vaults.map((v) => v.label.split(' · ')[0]) ?? [];
  const since = sinceLabel(card?.since ?? null);
  const nothing = card !== null && fees !== null && fees === 0 && (card.stakedUsd ?? 0) === 0;

  return new ImageResponse(
    (
      <OgFrame footer={DOMAIN}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 28, color: OG.tint, fontWeight: 700 }}>
          <div style={{ display: 'flex' }}>Fees earned staking</div>
          {card && (
            <div
              style={{
                display: 'flex',
                fontFamily: 'Plex',
                fontSize: 22,
                color: OG.ink,
                border: `1px solid ${OG.faint}`,
                borderRadius: 99,
                padding: '4px 14px',
              }}
            >
              {shortWallet(card.wallet)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', fontFamily: 'Plex', fontWeight: 600, fontSize: 132, letterSpacing: -4, marginTop: 6 }}>
          {card === null ? '—' : nothing ? '$0.00' : fees === null ? '—' : usdFee(fees)}
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: OG.soft, marginTop: 4 }}>
          {card === null
            ? 'Share cards are worked out from the chain on tidewell.live.'
            : nothing
              ? 'Nothing staked yet.'
              : `${card.stakedUsd !== null && card.stakedUsd > 0 ? `${usd(card.stakedUsd)} staked in ${pairs.join(', ')}` : 'Withdrawn, fees kept'}${since ? ` · since ${since}` : ''}`}
        </div>
      </OgFrame>
    ),
    { ...OG_SIZE, fonts: await ogFonts(), headers: { 'cache-control': 'public, max-age=300' } },
  );
}
