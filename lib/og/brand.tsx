/**
 * What the link cards (the opengraph-image.tsx files under app/, §32) are drawn with: the
 * site's own fonts, cut to TTF by scripts/build-og-fonts.py, the mark, and
 * the brand's colours. Server-only: the fonts are read from disk.
 *
 * The colours are written out here because an image has no stylesheet to
 * read custom properties from; each names the token in app/globals.css it
 * copies, and this is the one place they are written.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OG_SIZE = { width: 1200, height: 630 };

export const OG = {
  deep: '#0A3D4A', // --deep
  brand: '#0B6E86', // --ac
  tint: '#9CCFDA', // --ac-3
  ink: '#FFFFFF', // --on-ac
  soft: 'rgba(255,255,255,0.72)',
  faint: 'rgba(255,255,255,0.18)',
  pos: '#5FD39A', // --pos, lifted for a dark ground
  neg: '#FF8A7E', // --red, lifted for a dark ground
};

type Font = { name: string; data: ArrayBuffer; weight: 500 | 600 | 700; style: 'normal' };
let fonts: Promise<Font[]> | null = null;

/** The fonts, read once per process. */
export function ogFonts(): Promise<Font[]> {
  fonts ??= (async () => {
    const dir = join(process.cwd(), 'assets/og-fonts');
    const read = async (file: string) => {
      const b = await readFile(join(dir, file));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    return [
      { name: 'Sora', data: await read('sora-700.ttf'), weight: 700, style: 'normal' },
      { name: 'Manrope', data: await read('manrope-500.ttf'), weight: 500, style: 'normal' },
      { name: 'Manrope', data: await read('manrope-700.ttf'), weight: 700, style: 'normal' },
      { name: 'Plex', data: await read('plexmono-600.ttf'), weight: 600, style: 'normal' },
    ];
  })();
  return fonts;
}

/** The flat mark (app/icon.svg's geometry) in white, as an inline image. */
export function MarkImg({ size }: { size: number }) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><clipPath id="w"><circle cx="16" cy="16" r="11"/></clipPath></defs>` +
    `<circle cx="16" cy="16" r="12.2" fill="none" stroke="#fff" stroke-width="2.4"/>` +
    `<path d="M3 17.5c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0 4.4 2.4 6.6 0V30H3z" fill="#fff" clip-path="url(#w)"/></svg>`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt="" width={size} height={size} src={`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`} />;
}

/** The frame every card shares: deep water, the lockup top left, the address bottom right. */
export function OgFrame({ children, footer }: { children: React.ReactNode; footer: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '56px 64px',
        color: OG.ink,
        fontFamily: 'Manrope',
        background: `linear-gradient(135deg, ${OG.deep} 0%, #0B5466 55%, ${OG.brand} 100%)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <MarkImg size={52} />
        <div style={{ fontFamily: 'Sora', fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Tidewell</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }}>{children}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 24, color: OG.soft }}>
        <div style={{ display: 'flex' }}>Real swap fees. No emissions.</div>
        <div style={{ display: 'flex', fontFamily: 'Plex', fontWeight: 600, color: OG.ink }}>{footer}</div>
      </div>
    </div>
  );
}
