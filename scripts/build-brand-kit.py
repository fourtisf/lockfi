#!/usr/bin/env python3
"""
Put the generated brand assets where the website serves them.

    python3 scripts/build-brand-kit.py      # after build-brand.py and the PNGs

- app/apple-icon.png          the iOS home-screen icon (Next.js links it itself)
- public/icons/icon-*.png     the web app manifest's icons (app/manifest.ts)
- public/brand/*              the files the /brand page offers for download
- public/brand/tidewell-brand-kit.zip   every file in brand/, in one download

Run by `npm run brand`. Everything here is a copy of something in brand/, so
brand/ stays the single source and this step can be rerun at any time.
"""

from __future__ import annotations

import os
import shutil
import zipfile

ROOT = os.path.join(os.path.dirname(__file__), '..')
BRAND = os.path.join(ROOT, 'brand')
PUBLIC = os.path.join(ROOT, 'public')

# What the /brand page links to. Keep in step with app/brand/page.tsx.
DOWNLOADS = [
    'tidewell-mark.svg',
    'tidewell-mark-1024.png',
    'tidewell-mark-premium.svg',
    'tidewell-mark-premium-2048.png',
    'tidewell-mark-premium-dark.svg',
    'tidewell-mark-premium-dark-2048.png',
    'tidewell-lockup.svg',
    'tidewell-lockup-1200.png',
    'tidewell-lockup-white.svg',
    'tidewell-lockup-white-1200.png',
    'tidewell-lockup-premium.svg',
    'tidewell-lockup-premium-2400.png',
    'tidewell-lockup-premium-dark.svg',
    'tidewell-lockup-premium-dark-2400.png',
    'icon-premium-1024.png',
    'icon-premium-2048.png',
    'icon-brand-1024.png',
    'tidewell-premium-showcase.png',
    'og-card.png',
    'x-avatar-premium-1000.png',
    'x-avatar-teal-1000.png',
    'x-header-1500.png',
    'x-header-3000.png',
    'tidewell-mark-signature-glass-2048.png',
    'x-avatar-signature-glass-1000.png',
    'icon-signature-glass-1024.png',
    'x-header-signature-glass-1500.png',
    'x-header-signature-glass-3000.png',
    'tidewell-signature-glass-showcase.png',
    'tidewell-mark-signature-gold-2048.png',
    'x-avatar-signature-gold-1000.png',
    'icon-signature-gold-1024.png',
    'x-header-signature-gold-1500.png',
    'x-header-signature-gold-3000.png',
    'tidewell-signature-gold-showcase.png',
    'x-header-tide-glass-1500.png',
    'x-header-tide-glass-3000.png',
    'x-header-tide-gold-1500.png',
    'x-header-tide-gold-3000.png',
]


def copy(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    print(f'  {os.path.relpath(dst, ROOT)}')


def main() -> None:
    copy(os.path.join(BRAND, 'apple-touch-icon-180.png'), os.path.join(ROOT, 'app', 'apple-icon.png'))
    copy(os.path.join(BRAND, 'icon-brand-192.png'), os.path.join(PUBLIC, 'icons', 'icon-192.png'))
    copy(os.path.join(BRAND, 'icon-brand-512.png'), os.path.join(PUBLIC, 'icons', 'icon-512.png'))
    copy(os.path.join(BRAND, 'icon-premium-1024.png'), os.path.join(PUBLIC, 'icons', 'icon-1024.png'))

    for name in DOWNLOADS:
        copy(os.path.join(BRAND, name), os.path.join(PUBLIC, 'brand', name))

    kit = os.path.join(PUBLIC, 'brand', 'tidewell-brand-kit.zip')
    with zipfile.ZipFile(kit, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(BRAND)):
            # The 3000px headers and the showcases are several MB each of fine
            # grain that does not compress; they are one click away on /brand.
            if name.endswith('-3000.png') or name.endswith('showcase.png'):
                continue
            # Fixed timestamps, so rerunning produces the same bytes.
            info = zipfile.ZipInfo(f'tidewell-brand-kit/{name}', date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(os.path.join(BRAND, name), 'rb') as fh:
                z.writestr(info, fh.read())
    print(f'  {os.path.relpath(kit, ROOT)}  {os.path.getsize(kit) // 1024} KB')


if __name__ == '__main__':
    main()
