import type { Metadata } from 'next';
import Image from 'next/image';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '@/lib/site';

export const metadata: Metadata = { title: `Brand — ${BRAND}` };

/** Where each preview sits: on the ground it was drawn for. */
type Ground = 'light' | 'deep' | 'brand';

interface Asset {
  title: string;
  use: string;
  preview: string;
  ground: Ground;
  /** Wide art (a lockup) gets a wide preview. */
  wide?: boolean;
  files: { label: string; file: string }[];
}

const ASSETS: Asset[] = [
  {
    title: 'Premium mark',
    use: 'Hero use on light grounds: decks, partner pages, the press.',
    preview: 'tidewell-mark-premium.svg',
    ground: 'light',
    files: [
      { label: 'SVG', file: 'tidewell-mark-premium.svg' },
      { label: 'PNG 2048', file: 'tidewell-mark-premium-2048.png' },
    ],
  },
  {
    title: 'Premium mark, dark',
    use: 'The same mark for dark and brand grounds.',
    preview: 'tidewell-mark-premium-dark.svg',
    ground: 'deep',
    files: [
      { label: 'SVG', file: 'tidewell-mark-premium-dark.svg' },
      { label: 'PNG 2048', file: 'tidewell-mark-premium-dark-2048.png' },
    ],
  },
  {
    title: 'App icon',
    use: 'Avatars, wallet dapp lists, app stores. Corners are transparent.',
    preview: 'icon-premium-1024.png',
    ground: 'light',
    files: [
      { label: 'PNG 1024', file: 'icon-premium-1024.png' },
      { label: 'PNG 2048', file: 'icon-premium-2048.png' },
    ],
  },
  {
    title: 'Premium logo',
    use: 'Mark and wordmark together, on light grounds.',
    preview: 'tidewell-lockup-premium.svg',
    ground: 'light',
    wide: true,
    files: [
      { label: 'SVG', file: 'tidewell-lockup-premium.svg' },
      { label: 'PNG 2400', file: 'tidewell-lockup-premium-2400.png' },
    ],
  },
  {
    title: 'Premium logo, dark',
    use: 'Mark and wordmark together, on dark and brand grounds.',
    preview: 'tidewell-lockup-premium-dark.svg',
    ground: 'deep',
    wide: true,
    files: [
      { label: 'SVG', file: 'tidewell-lockup-premium-dark.svg' },
      { label: 'PNG 2400', file: 'tidewell-lockup-premium-dark-2400.png' },
    ],
  },
  {
    title: 'Flat logo',
    use: 'One-colour logo for light grounds, or white for dark ones.',
    preview: 'tidewell-lockup.svg',
    ground: 'light',
    wide: true,
    files: [
      { label: 'SVG', file: 'tidewell-lockup.svg' },
      { label: 'PNG', file: 'tidewell-lockup-1200.png' },
      { label: 'White SVG', file: 'tidewell-lockup-white.svg' },
      { label: 'White PNG', file: 'tidewell-lockup-white-1200.png' },
    ],
  },
  {
    title: 'Showcase',
    use: 'A ready-made hero image for announcements and decks.',
    preview: 'tidewell-premium-showcase.png',
    ground: 'light',
    wide: true,
    files: [{ label: 'PNG 2400', file: 'tidewell-premium-showcase.png' }],
  },
  {
    title: 'Flat mark',
    use: 'Interfaces, favicons and anything printed in one colour.',
    preview: 'tidewell-mark.svg',
    ground: 'light',
    files: [
      { label: 'SVG', file: 'tidewell-mark.svg' },
      { label: 'PNG 1024', file: 'tidewell-mark-1024.png' },
    ],
  },
  {
    title: 'Flat icon',
    use: 'The one-colour icon, white on the brand teal.',
    preview: 'icon-brand-1024.png',
    ground: 'light',
    files: [{ label: 'PNG 1024', file: 'icon-brand-1024.png' }],
  },
  {
    title: 'X profile picture',
    use: 'Square, cropped to a circle by X, Telegram and Discord.',
    preview: 'x-avatar-premium-1000.png',
    ground: 'light',
    files: [
      { label: 'Premium', file: 'x-avatar-premium-1000.png' },
      { label: 'Teal', file: 'x-avatar-teal-1000.png' },
    ],
  },
  {
    title: 'X header',
    use: '1500 × 500. The lockup is centred, clear of the avatar in the lower left.',
    preview: 'x-header-1500.png',
    ground: 'light',
    wide: true,
    files: [
      { label: 'PNG 1500', file: 'x-header-1500.png' },
      { label: 'PNG 3000', file: 'x-header-3000.png' },
    ],
  },
  {
    title: 'Social card',
    use: 'What a link to the site shows on X, Telegram and Discord.',
    preview: 'og-card.png',
    ground: 'light',
    wide: true,
    files: [{ label: 'PNG 1200', file: 'og-card.png' }],
  },
];

/** The Signature edition: avatars, headers and hero images, in glass and gold. */
const SIGNATURE: Asset[] = [
  {
    title: 'Signature mark',
    use: 'The porthole: polished ring, lit water, a crescent of reflected light.',
    preview: 'tidewell-mark-signature-glass-2048.png',
    ground: 'light',
    files: [
      { label: 'Glass', file: 'tidewell-mark-signature-glass-2048.png' },
      { label: 'Gold', file: 'tidewell-mark-signature-gold-2048.png' },
    ],
  },
  {
    title: 'Signature profile picture',
    use: 'For X, Telegram and Discord. Under X\u2019s 2 MB limit.',
    preview: 'x-avatar-signature-glass-1000.png',
    ground: 'light',
    files: [
      { label: 'Glass', file: 'x-avatar-signature-glass-1000.png' },
      { label: 'Gold', file: 'x-avatar-signature-gold-1000.png' },
    ],
  },
  {
    title: 'Signature app icon',
    use: 'The squircle, for surfaces that do not mask the corners.',
    preview: 'icon-signature-gold-1024.png',
    ground: 'light',
    files: [
      { label: 'Glass', file: 'icon-signature-glass-1024.png' },
      { label: 'Gold', file: 'icon-signature-gold-1024.png' },
    ],
  },
  {
    title: 'Signature X header',
    use: '1500 \u00d7 500, and 3000 \u00d7 1000 for sharp screens. Under X\u2019s 5 MB limit.',
    preview: 'x-header-signature-glass-1500.png',
    ground: 'light',
    wide: true,
    files: [
      { label: 'Glass 1500', file: 'x-header-signature-glass-1500.png' },
      { label: 'Glass 3000', file: 'x-header-signature-glass-3000.png' },
      { label: 'Gold 1500', file: 'x-header-signature-gold-1500.png' },
      { label: 'Gold 3000', file: 'x-header-signature-gold-3000.png' },
    ],
  },
  {
    title: 'Signature showcase',
    use: 'A hero image for launches and partner announcements.',
    preview: 'tidewell-signature-gold-showcase.png',
    ground: 'light',
    wide: true,
    files: [
      { label: 'Glass', file: 'tidewell-signature-glass-showcase.png' },
      { label: 'Gold', file: 'tidewell-signature-gold-showcase.png' },
    ],
  },
];

/** Preview sizes: SVGs carry a tiny intrinsic size, so each kind gets its own. */
function previewStyle(a: Asset): React.CSSProperties {
  if (a.preview.startsWith('tidewell-mark')) return { width: 128, height: 128 };
  if (a.preview.endsWith('showcase.png') && a.preview.includes('signature'))
    return { width: 'auto', height: 152, maxWidth: '100%' };
  if (a.preview.startsWith('icon-')) return { width: 132, height: 132 };
  // Shown the way it will be seen: cut to a circle.
  if (a.preview.startsWith('x-avatar')) return { width: 132, height: 132, borderRadius: '50%' };
  if (a.preview.startsWith('x-header')) return { width: '100%', height: 'auto', maxWidth: 456 };
  if (a.preview === 'og-card.png') return { width: 'auto', height: 152, maxWidth: '100%' };
  if (a.preview.endsWith('showcase.png')) return { width: 'auto', height: 152, maxWidth: '100%' };
  return { width: 'auto', height: 104, maxWidth: '100%' };
}

const COLOURS = [
  { name: 'Tide teal', token: '--ac', hex: '#0B6E86', note: 'Brand and action' },
  { name: 'Deep sea', token: '--deep', hex: '#0A3D4A', note: 'Dark grounds' },
  { name: 'Ink', token: '--fg', hex: '#0C1E24', note: 'Text' },
  { name: 'Sea glass', token: '--bg', hex: '#ECF2F2', note: 'Page ground' },
  { name: 'Up', token: '--pos', hex: '#0A7D4A', note: 'Positive numbers only' },
  { name: 'Down', token: '--red', hex: '#C23B2E', note: 'Negative numbers only' },
];

/** The kit's size, read at build time so the button never states a stale one. */
function kitSize(): string {
  try {
    const bytes = statSync(join(process.cwd(), 'public', 'brand', 'tidewell-brand-kit.zip')).size;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return 'ZIP';
  }
}

function card(a: Asset) {
  return (
    <article key={a.title} className={`card bk${a.wide ? ' wide' : ''}`}>
      <div className={`bk-art g-${a.ground}`}>
        <Image
          src={`/brand/${a.preview}`}
          alt={`${BRAND} ${a.title.toLowerCase()}`}
          width={a.wide ? 480 : 160}
          height={160}
          unoptimized
          style={previewStyle(a)}
        />
      </div>
      <div className="bk-body">
        <h2 className="sect-h">{a.title}</h2>
        <p className="hint" style={{ marginTop: 4 }}>
          {a.use}
        </p>
        <div className="bk-files">
          {a.files.map((f) => (
            <a key={f.file} className="btn btn-quiet btn-sm" href={`/brand/${f.file}`} download>
              {f.label}
            </a>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function BrandPage() {
  return (
    <section>
      <div className="head">
        <div>
          <h1>Brand</h1>
          <p className="lede">
            The {BRAND} mark and logo, for press, partners and integrations. Take the whole kit or a
            single file. The premium cut is for hero use; the flat mark is for interfaces and
            anything printed in one colour.
          </p>
        </div>
        <div className="acts">
          <a className="btn btn-brand" href="/brand/tidewell-brand-kit.zip" download>
            Download brand kit · {kitSize()}
          </a>
        </div>
      </div>

      <div className="bk-grid">{ASSETS.map(card)}</div>

      <div className="head" style={{ marginTop: 36, marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 24 }}>Signature edition</h2>
          <p className="lede">
            The mark as a polished porthole, in glass and in gold, for profile pictures, headers and
            launch images. The flat and premium cuts stay the logo everywhere else.
          </p>
        </div>
      </div>
      <div className="bk-grid">{SIGNATURE.map(card)}</div>

      <div className="grid g2" style={{ marginTop: 20 }}>
        <div className="card panel">
          <h2 className="sect-h">Colour</h2>
          <div className="bk-swatches">
            {COLOURS.map((c) => (
              <div key={c.token}>
                <i style={{ background: `var(${c.token})` }} />
                <b>{c.name}</b>
                <span className="num">{c.hex}</span>
                <small>{c.note}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="card panel">
          <h2 className="sect-h">Use it well</h2>
          <ul className="bk-rules">
            <li>Keep clear space around the mark of at least a quarter of its height.</li>
            <li>Smallest sizes: 16px for the flat mark, 32px for the premium one.</li>
            <li>Do not recolour, stretch, rotate, outline or add effects to the mark.</li>
            <li>Teal means the brand. Green and red mean up and down, and are never the logo.</li>
            <li>
              The wordmark is set in Sora 600 and supplied as outlines, so it needs no font
              installed.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
