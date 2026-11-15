/**
 * Rasterise the brand SVGs to PNG.
 *
 *   node scripts/build-brand-png.mjs
 *
 * Uses the Chromium Playwright already has, so there is no ImageMagick or
 * Inkscape dependency.
 *
 * Every PNG is written with omitBackground, so anything the SVG does not paint
 * stays transparent. That matters for the squircle icons: with a page
 * background behind them, Chromium fills the area outside the rounded corner
 * with white and the icon ships with four white notches.
 */

import { chromium } from 'playwright';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand');

/** Some sandboxes ship Chromium already; use it rather than downloading one. */
const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
].find((p) => existsSync(p) && statSync(p).isFile());

/** [source svg, output png, width] */
const JOBS = [
  // The mark alone, transparent.
  ['tidewell-mark.svg', 'tidewell-mark-512.png', 512],
  ['tidewell-mark.svg', 'tidewell-mark-1024.png', 1024],
  ['tidewell-mark-white.svg', 'tidewell-mark-white-512.png', 512],
  ['tidewell-mark-ink.svg', 'tidewell-mark-ink-512.png', 512],

  // Brand ground, full bleed — no corners, so nothing shows through. The cut
  // for an X avatar, Telegram, a wallet's dapp list and the app stores, all
  // of which apply their own mask.
  ['icon-brand.svg', 'icon-brand-1024.png', 1024],
  ['icon-brand.svg', 'icon-brand-512.png', 512],
  ['icon-brand.svg', 'icon-brand-192.png', 192],

  // Squircle, for surfaces that do not mask for you.
  ['icon-brand-rounded.svg', 'icon-brand-rounded-1024.png', 1024],
  ['icon-light-rounded.svg', 'icon-light-rounded-1024.png', 1024],

  // iOS composites a touch icon onto white, so it takes the full-bleed cut.
  ['icon-brand.svg', 'apple-touch-icon-180.png', 180],

  ['favicon.svg', 'favicon-16.png', 16],
  ['favicon.svg', 'favicon-32.png', 32],
  ['favicon.svg', 'favicon-48.png', 48],

  // Open Graph: 1200 × 630 is what X, Telegram, Discord and Slack crop from.
  ['og-card.svg', 'og-card.png', 1200],

  ['tidewell-lockup.svg', 'tidewell-lockup-1200.png', 1200],
  ['tidewell-lockup-white.svg', 'tidewell-lockup-white-1200.png', 1200],

  // Premium: hero use — app icons, the brand page, decks. High resolution,
  // because these are the files people put on a slide or a billboard.
  ['tidewell-mark-premium.svg', 'tidewell-mark-premium-2048.png', 2048],
  ['tidewell-mark-premium-dark.svg', 'tidewell-mark-premium-dark-2048.png', 2048],
  ['icon-premium.svg', 'icon-premium-1024.png', 1024],
  ['icon-premium.svg', 'icon-premium-2048.png', 2048],
  ['icon-premium-fullbleed.svg', 'icon-premium-fullbleed-1024.png', 1024],
  ['tidewell-lockup-premium.svg', 'tidewell-lockup-premium-2400.png', 2400],
  ['tidewell-lockup-premium-dark.svg', 'tidewell-lockup-premium-dark-2400.png', 2400],
  ['tidewell-premium-showcase.svg', 'tidewell-premium-showcase.png', 2400],

  // Social profiles: X recommends a 400 × 400 avatar and a 1500 × 500
  // header; the larger cuts stay sharp on high-density screens.
  ['x-avatar-premium.svg', 'x-avatar-premium-400.png', 400],
  ['x-avatar-premium.svg', 'x-avatar-premium-1000.png', 1000],
  ['x-avatar-teal.svg', 'x-avatar-teal-400.png', 400],
  ['x-avatar-teal.svg', 'x-avatar-teal-1000.png', 1000],
  ['x-header.svg', 'x-header-1500.png', 1500],
  ['x-header.svg', 'x-header-3000.png', 3000],

  // Signature edition: glass and gold.
  ['tidewell-mark-signature-glass.svg', 'tidewell-mark-signature-glass-2048.png', 2048],
  ['x-avatar-signature-glass.svg', 'x-avatar-signature-glass-400.png', 400],
  ['x-avatar-signature-glass.svg', 'x-avatar-signature-glass-1000.png', 1000],
  ['icon-signature-glass.svg', 'icon-signature-glass-1024.png', 1024],
  ['x-header-signature-glass.svg', 'x-header-signature-glass-1500.png', 1500],
  ['x-header-signature-glass.svg', 'x-header-signature-glass-3000.png', 3000],
  ['tidewell-signature-glass-showcase.svg', 'tidewell-signature-glass-showcase.png', 2400],
  ['tidewell-mark-signature-gold.svg', 'tidewell-mark-signature-gold-2048.png', 2048],
  ['x-avatar-signature-gold.svg', 'x-avatar-signature-gold-400.png', 400],
  ['x-avatar-signature-gold.svg', 'x-avatar-signature-gold-1000.png', 1000],
  ['icon-signature-gold.svg', 'icon-signature-gold-1024.png', 1024],
  ['x-header-signature-gold.svg', 'x-header-signature-gold-1500.png', 1500],
  ['x-header-signature-gold.svg', 'x-header-signature-gold-3000.png', 3000],
  ['tidewell-signature-gold-showcase.svg', 'tidewell-signature-gold-showcase.png', 2400],
  // The Tide header: premium, for the X profile.
  ['x-header-tide-glass.svg', 'x-header-tide-glass-1500.png', 1500],
  ['x-header-tide-glass.svg', 'x-header-tide-glass-3000.png', 3000],
  ['x-header-tide-gold.svg', 'x-header-tide-gold-1500.png', 1500],
  ['x-header-tide-gold.svg', 'x-header-tide-gold-3000.png', 3000],
];

// `node scripts/build-brand-png.mjs x-header-tide` renders only the outputs
// whose names contain one of the arguments: one asset, without re-rendering
// sixty unchanged ones.
const only = process.argv.slice(2);
const selected = only.length ? JOBS.filter(([, out]) => only.some((s) => out.includes(s))) : JOBS;

const browser = await chromium.launch(
  PREINSTALLED ? { executablePath: PREINSTALLED } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const [src, out, width] of selected) {
  const svg = readFileSync(join(BRAND, src), 'utf8');
  // Read the intrinsic ratio off the viewBox so the height follows the art.
  const [, , vbW, vbH] = svg.match(/viewBox="([^"]+)"/)[1].trim().split(/\s+/).map(Number);
  const height = Math.round((width * vbH) / vbW);

  // Chromium refuses a viewport smaller than roughly 50px, and a favicon is
  // 16. Render into a larger page and clip back to the art.
  await page.setViewportSize({
    width: Math.max(width, 320),
    height: Math.max(height, 320),
  });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${width}px;height:${height}px}</style>${svg}`,
  );
  await page.screenshot({
    path: join(BRAND, out),
    omitBackground: true,
    clip: { x: 0, y: 0, width, height },
  });
  console.log(`  ${out.padEnd(36)} ${width}×${height}`);
}

await browser.close();

// The card the site actually serves is the one in public/.
if (selected.some(([, out]) => out === 'og-card.png')) {
  copyFileSync(join(BRAND, 'og-card.png'), join(BRAND, '..', 'public', 'og-card.png'));
  console.log('  public/og-card.png                    copied');
}
