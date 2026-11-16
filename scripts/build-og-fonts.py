#!/usr/bin/env python3
"""
Static TTF cuts of the site's own fonts, for the share and token link cards
(app/**/opengraph-image.tsx, §32). The image renderer (next/og) reads TTF,
OTF or WOFF, not the variable WOFF2 the site ships, so the same fonts are
instanced at the weights the cards use and subset to the characters they
print. Run after `npm run build`; the output is committed.

All three are under the SIL Open Font License, which allows this.
"""
import glob
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'assets/og-fonts')
TEXT = ''.join(chr(c) for c in range(0x20, 0x7F)) + '·—–’‘“”…×↗→▲▼−•€'

CUTS = [
    ('Sora', 700, 'sora-700.ttf'),
    ('Manrope', 500, 'manrope-500.ttf'),
    ('Manrope', 700, 'manrope-700.ttf'),
    ('IBM Plex Mono', 600, 'plexmono-600.ttf'),
]


def find(family: str, weight: int) -> TTFont:
    for path in sorted(glob.glob(os.path.join(ROOT, '.next/static/media/*.woff2'))):
        font = TTFont(path)
        name = next((r.toUnicode() for r in font['name'].names if r.nameID == 1), '')
        if family not in name:
            continue
        cmap = font.getBestCmap()
        if not all(ord(c) in cmap for c in 'AZaz09$.,'):
            continue
        if 'fvar' in font:
            return instancer.instantiateVariableFont(font, {'wght': weight}, inplace=False)
        # A static cut: take it only at the weight asked for.
        if font['OS/2'].usWeightClass == weight:
            return font
    raise SystemExit(f'No {family} {weight} in .next/static/media — run `npm run build` first.')


os.makedirs(OUT, exist_ok=True)
for family, weight, name in CUTS:
    font = find(family, weight)
    font.flavor = None
    opts = subset.Options()
    opts.layout_features = ['kern', 'liga', 'tnum', 'lnum']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(text=''.join(c for c in TEXT if ord(c) in font.getBestCmap()))
    sub.subset(font)
    path = os.path.join(OUT, name)
    font.save(path)
    print(f'  {os.path.relpath(path, ROOT):32s} {os.path.getsize(path):7d} B')
