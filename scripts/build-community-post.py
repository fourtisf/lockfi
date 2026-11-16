#!/usr/bin/env python3
"""
"The Tidewell community is now open": the X post image for the Telegram
channel opening, 16:9 like X's in-feed images, in the Signature glass and gold
finishes. Every word is outlined from the site's own fonts.

    python3 scripts/build-community-post.py && node scripts/build-brand-png.mjs x-post-community

Writes brand/x-post-community-{glass,gold}.svg; the PNG step renders each at
1600×900 and 3200×1800. The channel's address is read from lib/site.ts's
TELEGRAM_LABEL, the one place it is written.
"""
from __future__ import annotations

import importlib.util
import os
import re

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location('brand', os.path.join(HERE, 'build-brand.py'))
brand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand)

W, H = 1600, 900
INK0 = brand.INK0

site = open(os.path.join(brand.ROOT, 'lib', 'site.ts')).read()
m = re.search(r"TELEGRAM_LABEL\s*=\s*'([^']+)'", site)
if not m:
    raise SystemExit('TELEGRAM_LABEL in lib/site.ts is not set.')
TG = m.group(1)
xm = re.search(r"X_HANDLE\s*=\s*'([^']+)'", site)
XH = xm.group(1) if xm else '@usetidewell'

EYEBROW = 'TIDEWELL COMMUNITY'
HEAD_1 = 'The community'
HEAD_2 = 'is now open.'
LABEL = 'JOIN ON TELEGRAM'
SUB = f'Launch news, product updates and the only official links. Also on X: {XH}'

ACCENT = {
    'glass': ('#FFFFFF', '#7FDCEC'),
    'gold': ('#FFF6DA', '#E8B85A'),
}

sora = brand.load('Sora', 700, HEAD_1 + HEAD_2)
manrope = brand.load('Manrope', 500, SUB)
manrope_b = brand.load('Manrope', 600, EYEBROW + LABEL)
manrope_x = brand.load('Manrope', 700, TG)
word = brand.load('Sora', 600, 'Tidewel')

# Telegram's plane, in a 24-unit box.
PLANE = ('M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3'
         'l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93'
         'c-.23.23-.42.42-.83.42z')


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


def post(fin: str) -> str:
    f = brand.SIGNATURE[fin]
    glow, crest, body = f['glow'], f['crest'], f['tag']
    a0, a1 = ACCENT[fin]
    parts: list[str] = []

    mx, my, ms = 1352.0, 352.0, 9.6
    parts.append(brand.signature_ground('g', W, H, mx, my, glow, grain=.03))

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
    parts.append(f'<g transform="translate({mx - 16 * ms:.2f} {my - 16 * ms:.2f}) scale({ms})">'
                 f'{brand.mark_signature(fin, "cm")}</g>')

    left = 92.0
    ls, ly = 1.7, 64.0
    mark_w = (brand.INK1 - INK0) * ls
    parts.append(f'<g transform="translate({left - INK0 * ls:.2f} {ly - INK0 * ls:.2f}) scale({ls})">'
                 f'{brand.mark_signature(fin, "lm")}</g>')
    parts.append(f'<path d="{text(word, "Tidewell", 30, ly + mark_w / 2 + 10.5, left + mark_w + 14, -0.02)}" fill="#FFFFFF"/>')

    parts.append(f'<path d="{text(manrope_b, EYEBROW, 16, 240, left, 0.24)}" fill="{a1}"/>')
    parts.append(
        f'<defs><linearGradient id="h2" x1="{left:g}" y1="0" x2="{left + width(sora, HEAD_2, 82, -0.02):g}" y2="0" '
        f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{a0}"/><stop offset="1" stop-color="{a1}"/>'
        f'</linearGradient></defs>'
    )
    parts.append(f'<path d="{text(sora, HEAD_1, 82, 328, left - 3, -0.02)}" fill="#FFFFFF"/>')
    parts.append(f'<path d="{text(sora, HEAD_2, 82, 416, left - 3, -0.02)}" fill="url(#h2)"/>')

    # The channel, on a glass panel sized to it, with Telegram's plane in a disc.
    size = 40.0
    tw = width(manrope_x, TG, size)
    disc = 64.0
    pad = 30.0
    px, py = left, 476.0
    pw, ph = pad + disc + 22 + max(tw, width(manrope_b, LABEL, 16, 0.14)) + pad, 148.0
    cx, cy = px + pad + disc / 2, py + ph / 2
    parts.append(
        f'<rect x="{px:g}" y="{py:g}" width="{pw:.1f}" height="{ph:g}" rx="22" fill="#FFFFFF" fill-opacity=".07" '
        f'stroke="{a1}" stroke-opacity=".5" stroke-width="1.5"/>'
        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{disc / 2:g}" fill="{a1}"/>'
        f'<g transform="translate({cx - 18:.1f} {cy - 17:.1f}) scale(1.5)"><path d="{PLANE}" fill="#05303B"/></g>'
    )
    tx = px + pad + disc + 22
    parts.append(f'<path d="{text(manrope_b, LABEL, 16, py + 56, tx, 0.14)}" fill="{a1}"/>')
    parts.append(f'<path d="{text(manrope_x, TG, size, py + 108, tx)}" fill="#FFFFFF"/>')

    parts.append(f'<path d="{text(manrope, SUB, 24, 696, left)}" fill="{body}"/>')

    body_svg = '\n  '.join(parts)
    return brand.svg(body_svg, f'0 0 {W} {H}', W, H).replace(
        'aria-label="Tidewell"', f'aria-label="The Tidewell community is now open: {TG}"')


def main() -> None:
    for fin in ('glass', 'gold'):
        brand.write(os.path.join(brand.OUT, f'x-post-community-{fin}.svg'), post(fin))
    print('channel', TG)


if __name__ == '__main__':
    main()
