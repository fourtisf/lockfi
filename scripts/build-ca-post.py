#!/usr/bin/env python3
"""
"CA updated on tidewell.live": the X post image for the token's contract
address going up on the site, 16:9 like X's in-feed images, in the Signature
glass and gold finishes. Every word is outlined from the site's own fonts.

    python3 scripts/build-ca-post.py && node scripts/build-brand-png.mjs x-post-ca-updated

Writes brand/x-post-ca-updated-{glass,gold}.svg; the PNG step renders each at
1600×900 and 3200×1800.

The address is read from lib/site.ts's TOKEN_CA, the one place it is written,
so the image cannot show a different CA from the site. It is printed whole,
in IBM Plex Mono, because a CA people may type or compare must not be
abbreviated.
"""
from __future__ import annotations

import glob
import importlib.util
import os
import re

from fontTools.ttLib import TTFont

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location('brand', os.path.join(HERE, 'build-brand.py'))
brand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand)

W, H = 1600, 900
INK0 = brand.INK0

site = open(os.path.join(brand.ROOT, 'lib', 'site.ts')).read()
m = re.search(r"TOKEN_CA[^=]*=\s*'(0x[0-9a-fA-F]{40})'", site)
if not m:
    raise SystemExit('TOKEN_CA in lib/site.ts is not set; there is no CA to announce.')
CA = m.group(1)

EYEBROW = 'OFFICIAL CONTRACT ADDRESS'
HEAD_1 = 'CA updated'
HEAD_2 = 'on tidewell.live'
LABEL = '$TIDEWELL  ·  ROBINHOOD CHAIN'
FOOT = 'Only trust the CA shown on tidewell.live and posted by @usetidewell.'

ACCENT = {
    'glass': ('#FFFFFF', '#7FDCEC'),
    'gold': ('#FFF6DA', '#E8B85A'),
}

sora = brand.load('Sora', 700, HEAD_1 + HEAD_2)
manrope = brand.load('Manrope', 500, FOOT)
manrope_b = brand.load('Manrope', 600, EYEBROW + LABEL)
word = brand.load('Sora', 600, 'Tidewel')


def mono(weight: int, sample: str) -> TTFont:
    """IBM Plex Mono from the site's build: static files, one per weight."""
    for f in sorted(glob.glob(os.path.join(brand.ROOT, '.next/static/media/*.woff2'))):
        font = TTFont(f)
        fam = next((r.toUnicode() for r in font['name'].names if r.nameID == 1), '')
        if 'IBM Plex Mono' not in fam or font['OS/2'].fsSelection & 1:
            continue
        if font['OS/2'].usWeightClass != weight:
            continue
        if all(ord(c) in font.getBestCmap() for c in sample):
            return font
    raise SystemExit(f'No IBM Plex Mono {weight} covering {sample!r} in .next/static/media — run `npm run build` first.')


plex = mono(500, CA)


def width(font: TTFont, s: str, size: float, tracking: float = 0.0) -> float:
    return brand.outline(font, s, size, 0, 0, tracking)[1]


def text(font: TTFont, s: str, size: float, y: float, x: float, tracking: float = 0.0) -> str:
    return brand.outline(font, s, size, y, x, tracking)[0]


def wave(x0: float, x1: float, base: float, amp: float, period: float, slope: float) -> str:
    """The mark's tide line at banner scale, the sea rising left to right."""
    half = period / 2
    d = [f'M{x0:.1f} {base - slope * x0:.1f}']
    x, k = x0, 0
    while x < x1:
        nx = x + half
        sgn = -1 if k % 2 == 0 else 1
        y0, y1 = base - slope * x, base - slope * nx
        d.append(f'C{x + half / 3:.1f} {y0 + sgn * amp:.1f} {nx - half / 3:.1f} {y1 + sgn * amp:.1f} {nx:.1f} {y1:.1f}')
        x, k = nx, k + 1
    return ' '.join(d)


def post(fin: str) -> str:
    f = brand.SIGNATURE[fin]
    glow, crest, body = f['glow'], f['crest'], f['tag']
    a0, a1 = ACCENT[fin]
    parts: list[str] = []

    mx, my, ms = 1352.0, 352.0, 9.6
    parts.append(brand.signature_ground('g', W, H, mx, my, glow, grain=.03))

    # The sea along the bottom.
    base, slope, amp, period = 850.0, 0.026, 11.0, 320.0
    front = wave(-period, W + period, base, amp, period, slope)
    back = wave(-period * 1.5, W + period, base - 15, amp * .9, period, slope)
    parts.append(
        f'<defs><linearGradient id="sea" x1="0" y1="{base - 70:g}" x2="0" y2="{H:g}" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#58C9DE"/><stop offset=".25" stop-color="#1E93AD"/>'
        f'<stop offset="1" stop-color="#04303B"/></linearGradient>'
        f'<filter id="sg" x="-5%" y="-300%" width="110%" height="700%"><feGaussianBlur stdDeviation="5"/></filter></defs>'
        f'<path d="{back} V{H + 40} H{-period * 1.5} Z" fill="#0F5262" opacity=".85"/>'
        f'<path d="{front} V{H + 40} H{-period} Z" fill="url(#sea)"/>'
        f'<path d="{front}" fill="none" stroke="{glow}" stroke-width="7" opacity=".45" filter="url(#sg)"/>'
        f'<path d="{front}" fill="none" stroke="{crest}" stroke-width="1.3" opacity=".9"/>'
    )

    # The mark, large, on the right.
    parts.append(f'<g transform="translate({mx - 16 * ms:.2f} {my - 16 * ms:.2f}) scale({ms})">'
                 f'{brand.mark_signature(fin, "cm")}</g>')

    # Lockup, top left.
    left = 92.0
    ls, ly = 1.7, 64.0
    mark_w = (brand.INK1 - INK0) * ls
    parts.append(f'<g transform="translate({left - INK0 * ls:.2f} {ly - INK0 * ls:.2f}) scale({ls})">'
                 f'{brand.mark_signature(fin, "lm")}</g>')
    parts.append(f'<path d="{text(word, "Tidewell", 30, ly + mark_w / 2 + 10.5, left + mark_w + 14, -0.02)}" fill="#FFFFFF"/>')

    # Eyebrow and headline.
    parts.append(f'<path d="{text(manrope_b, EYEBROW, 16, 240, left, 0.24)}" fill="{a1}"/>')
    parts.append(
        f'<defs><linearGradient id="h2" x1="{left:g}" y1="0" x2="{left + width(sora, HEAD_2, 82, -0.02):g}" y2="0" '
        f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{a0}"/><stop offset="1" stop-color="{a1}"/>'
        f'</linearGradient></defs>'
    )
    parts.append(f'<path d="{text(sora, HEAD_1, 82, 328, left - 3, -0.02)}" fill="#FFFFFF"/>')
    parts.append(f'<path d="{text(sora, HEAD_2, 82, 416, left - 3, -0.02)}" fill="url(#h2)"/>')

    # The address, whole, on a glass panel sized to it.
    size = 36.0
    aw = width(plex, CA, size)
    pad = 34.0
    px, py, pw, ph = left, 476.0, aw + 2 * pad, 148.0
    parts.append(
        f'<rect x="{px:g}" y="{py:g}" width="{pw:.1f}" height="{ph:g}" rx="22" fill="#FFFFFF" fill-opacity=".07" '
        f'stroke="{a1}" stroke-opacity=".5" stroke-width="1.5"/>'
    )
    parts.append(f'<path d="{text(manrope_b, LABEL, 16, py + 50, px + pad, 0.14)}" fill="{a1}"/>')
    parts.append(f'<path d="{text(plex, CA, size, py + 108, px + pad)}" fill="#FFFFFF"/>')

    # The warning, under it.
    parts.append(f'<path d="{text(manrope, FOOT, 24, 696, left)}" fill="{body}"/>')

    body_svg = '\n  '.join(parts)
    return brand.svg(body_svg, f'0 0 {W} {H}', W, H).replace(
        'aria-label="Tidewell"', f'aria-label="Tidewell CA updated on tidewell.live: {CA}"')


def main() -> None:
    for fin in ('glass', 'gold'):
        brand.write(os.path.join(brand.OUT, f'x-post-ca-updated-{fin}.svg'), post(fin))
    print('CA', CA)


if __name__ == '__main__':
    main()
