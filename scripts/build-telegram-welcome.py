#!/usr/bin/env python3
"""
The Telegram channel's welcome banner: the image for the pinned first post,
with every official link in one place. 16:9, in the Signature glass and gold
finishes; every word outlined from the site's own fonts.

    python3 scripts/build-telegram-welcome.py && node scripts/build-brand-png.mjs tg-welcome

Writes brand/tg-welcome-{glass,gold}.svg; the PNG step renders each at
1600×900 and 2560×1440 (Telegram re-compresses anything larger than 2560).
The domain, the X handle, the Telegram channel and the CA are read from lib/site.ts, so the banner
cannot list a link the site does not.
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


def const(name: str, pattern: str = r"'([^']+)'") -> str:
    m = re.search(rf'{name}[^=]*=\s*{pattern}', site)
    if not m:
        raise SystemExit(f'{name} in lib/site.ts is not set.')
    return m.group(1)


DOMAIN = const('DOMAIN')
X_HANDLE = const('X_HANDLE')
TELEGRAM = const('TELEGRAM_LABEL')
CA = const('TOKEN_CA', r"'(0x[0-9a-fA-F]{40})'")

EYEBROW = 'OFFICIAL TELEGRAM'
HEAD_1 = 'Welcome to the'
HEAD_2 = 'Tidewell community.'
ROWS = [('WEBSITE', DOMAIN), ('X', X_HANDLE), ('TELEGRAM', TELEGRAM), ('CA', CA)]
FOOT = f'Never share your seed phrase. Only trust links posted here and on {DOMAIN}.'

ACCENT = {
    'glass': ('#FFFFFF', '#7FDCEC'),
    'gold': ('#FFF6DA', '#E8B85A'),
}

sora = brand.load('Sora', 700, HEAD_1 + HEAD_2)
manrope = brand.load('Manrope', 500, FOOT)
manrope_b = brand.load('Manrope', 600, EYEBROW + ''.join(r[0] for r in ROWS))
manrope_x = brand.load('Manrope', 700, DOMAIN + X_HANDLE + TELEGRAM)
word = brand.load('Sora', 600, 'Tidewel')


def mono(weight: int, sample: str) -> TTFont:
    """IBM Plex Mono from the site's build: static files, one per weight."""
    for f in sorted(glob.glob(os.path.join(brand.ROOT, '.next/static/media/*.woff2'))):
        font = TTFont(f)
        fam = next((r.toUnicode() for r in font['name'].names if r.nameID == 1), '')
        if 'IBM Plex Mono' not in fam or font['OS/2'].fsSelection & 1 or font['OS/2'].usWeightClass != weight:
            continue
        if all(ord(c) in font.getBestCmap() for c in sample):
            return font
    raise SystemExit(f'No IBM Plex Mono {weight} covering {sample!r} — run `npm run build` first.')


plex = mono(500, CA)


def width(font, s: str, size: float, tracking: float = 0.0) -> float:
    return brand.outline(font, s, size, 0, 0, tracking)[1]


def text(font, s: str, size: float, y: float, x: float, tracking: float = 0.0) -> str:
    return brand.outline(font, s, size, y, x, tracking)[0]


def wave(x0: float, x1: float, base: float, amp: float, period: float, slope: float) -> str:
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


def banner(fin: str) -> str:
    f = brand.SIGNATURE[fin]
    glow, crest, body = f['glow'], f['crest'], f['tag']
    a0, a1 = ACCENT[fin]
    parts: list[str] = []

    mx, my, ms = 1368.0, 360.0, 9.2
    parts.append(brand.signature_ground('g', W, H, mx, my, glow, grain=.03))

    base, slope, amp, period = 852.0, 0.026, 11.0, 320.0
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
    parts.append(f'<g transform="translate({mx - 16 * ms:.2f} {my - 16 * ms:.2f}) scale({ms})">'
                 f'{brand.mark_signature(fin, "cm")}</g>')

    left = 92.0
    ls, ly = 1.7, 64.0
    mark_w = (brand.INK1 - INK0) * ls
    parts.append(f'<g transform="translate({left - INK0 * ls:.2f} {ly - INK0 * ls:.2f}) scale({ls})">'
                 f'{brand.mark_signature(fin, "lm")}</g>')
    parts.append(f'<path d="{text(word, "Tidewell", 30, ly + mark_w / 2 + 10.5, left + mark_w + 14, -0.02)}" fill="#FFFFFF"/>')

    parts.append(f'<path d="{text(manrope_b, EYEBROW, 16, 196, left, 0.24)}" fill="{a1}"/>')
    parts.append(
        f'<defs><linearGradient id="h2" x1="{left:g}" y1="0" x2="{left + width(sora, HEAD_2, 74, -0.02):g}" y2="0" '
        f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{a0}"/><stop offset="1" stop-color="{a1}"/>'
        f'</linearGradient></defs>'
    )
    parts.append(f'<path d="{text(sora, HEAD_1, 74, 274, left - 3, -0.02)}" fill="#FFFFFF"/>')
    parts.append(f'<path d="{text(sora, HEAD_2, 74, 352, left - 3, -0.02)}" fill="url(#h2)"/>')

    # The official links, one per row, on a glass panel sized to the longest.
    label_w = 132.0
    pad = 30.0
    row_h = 62.0
    vals = [(lab, val, plex if lab == 'CA' else manrope_x, 25.0 if lab == 'CA' else 30.0) for lab, val in ROWS]
    vw = max(width(font, val, size) for _, val, font, size in vals)
    px, py = left, 392.0
    pw, ph = pad + label_w + vw + pad, pad * 2 + row_h * len(vals) - 8
    parts.append(
        f'<rect x="{px:g}" y="{py:g}" width="{pw:.1f}" height="{ph:g}" rx="22" fill="#FFFFFF" fill-opacity=".07" '
        f'stroke="{a1}" stroke-opacity=".5" stroke-width="1.5"/>'
    )
    for i, (lab, val, font, size) in enumerate(vals):
        y = py + pad + i * row_h + 38
        if i > 0:
            parts.append(f'<line x1="{px + pad:g}" x2="{px + pw - pad:.1f}" y1="{y - 46:.1f}" y2="{y - 46:.1f}" '
                         f'stroke="#FFFFFF" stroke-opacity=".10"/>')
        parts.append(f'<path d="{text(manrope_b, lab, 15, y - 4, px + pad, 0.16)}" fill="{a1}"/>')
        parts.append(f'<path d="{text(font, val, size, y, px + pad + label_w)}" fill="#FFFFFF"/>')

    parts.append(f'<path d="{text(manrope, FOOT, 23, py + ph + 56, left)}" fill="{body}"/>')

    body_svg = '\n  '.join(parts)
    return brand.svg(body_svg, f'0 0 {W} {H}', W, H).replace(
        'aria-label="Tidewell"', f'aria-label="Welcome to the Tidewell community. Website {DOMAIN}, X {X_HANDLE}, Telegram {TELEGRAM}, CA {CA}"')


def main() -> None:
    for fin in ('glass', 'gold'):
        brand.write(os.path.join(brand.OUT, f'tg-welcome-{fin}.svg'), banner(fin))
    print('links', DOMAIN, X_HANDLE, TELEGRAM, CA)


if __name__ == '__main__':
    main()
