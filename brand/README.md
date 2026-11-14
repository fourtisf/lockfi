# Tidewell — brand assets

Generated, not hand-edited. Change the geometry in `components/shell/Logo.tsx`
and `scripts/build-brand.py`, then rerun:

```bash
npm run brand          # SVGs, then PNGs, then public/og-card.png
```

The wordmark is outlined from Sora at weight 600 and the card copy from
Manrope — the same variable fonts the app ships, instanced — so **no file here
depends on a font being installed**. The generator reads those fonts out of
`.next/`, so `npm run build` has to have run at least once.

## The mark

A well seen from above, filled to the tide line: the yield fills with real
trading volume and drops when it drops. On a 32 × 32 grid, a ring of radius
12.2 (stroke 2.4) around water clipped to radius 11, so a clear gap separates
the two at every size down to a 16px favicon. One colour, always: the brand
teal `#0B6E86`, white on the brand ground, or ink `#0C1E24`.

## Which file

| Use | File |
|---|---|
| X / Telegram avatar, app stores, wallet lists | `icon-brand-1024.png` — full bleed, brand to every edge |
| Where you want the squircle yourself | `icon-brand-rounded-1024.png` — corners transparent |
| On the app's light ground | `icon-light-rounded-1024.png` |
| iOS home screen | `apple-touch-icon-180.png` |
| Browser tab | `favicon.svg`, `favicon-16/32/48.png` (also `app/icon.svg`) |
| The mark alone | `tidewell-mark.svg`, `tidewell-mark-1024.png` |
| One colour, ink / knocked out | `tidewell-mark-ink.svg` · `tidewell-mark-white.svg` |
| Inside a React component | `tidewell-mark-currentcolor.svg`, or `<Mark>` from `components/shell/Logo.tsx` |
| Full logo, light ground | `tidewell-lockup.svg`, `tidewell-lockup-1200.png` |
| Full logo, brand or dark ground | `tidewell-lockup-white.svg`, `tidewell-lockup-white-1200.png` |
| Social card | `og-card.png` (1200 × 630; copied to `public/`) |

The social card carries no URL: no Tidewell domain is registered yet (§19).
Add one to `scripts/build-brand.py` when there is.
