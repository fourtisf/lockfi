#!/usr/bin/env python3
"""
The cover for Tidewell's launch article ("Introducing Tidewell"): a premium
5:2 banner, the shape X gives an Article's cover, in the Signature glass and
gold finishes. Every word is outlined from the site's own fonts, so it
renders identically everywhere.

    python3 scripts/build-article-cover.py && node scripts/build-brand-png.mjs article-cover

Writes brand/article-cover-{glass,gold}.svg; the PNG step renders each at
1500×600 and 3000×1200.

The article it heads is docs/articles/introducing-tidewell.md. Like the
"How it works" image, the cover carries no yield figure: §1 forbids a
forward one, and a trailing one would be out of date the day after posting.
Its two claims — the fees are real swap fees, and there are no emissions —
are properties of the contracts (CLAUDE.md §1, §20).
"""
from __future__ import annotations

import importlib.util
import os

from fontTools.ttLib import TTFont

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location('brand', os.path.join(HERE, 'build-brand.py'))
brand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand)

W, H = 1500, 600
INK0 = brand.INK0

# The two lines of the headline, the line under it, and the eyebrow.
HEAD_1 = 'Liquidity that earns'
HEAD_2 = 'from real trading.'
SUB_1 = 'Stake or shape liquidity on Robinhood Chain.'
SUB_2 = 'Every fee is a real swap fee. No emissions, ever.'
EYEBROW = 'INTRODUCING TIDEWELL'

# Per finish: the accent the second headline line and the eyebrow wear.
ACCENT = {
    'glass': ('#FFFFFF', '#7FDCEC'),
    'gold': ('#FFF6DA', '#E8B85A'),
}

sora = brand.load('Sora', 700, HEAD_1 + HEAD_2)
manrope = brand.load('Manrope', 500, SUB_1 + SUB_2)
manrope_b = brand.load('Manrope', 600, EYEBROW + 'tidewell.live')
word = brand.load('Sora', 600, 'Tidewel')


def width(font: TTFont, s: str, size: float, tracking: float = 0.0) -> float:
    return brand.outline(font, s, size, 0, 0, tracking)[1]


def text(font: TTFont, s: str, size: float, y: float, x: float, tracking: float = 0.0) -> str:
    return brand.outline(font, s, size, y, x, tracking)[0]


def wave(x0: float, x1: float, base: float, amp: float, period: float, slope: float) -> str:
    """The mark's tide line at banner scale: alternating half-period arcs,
    the sea tilted so it rises left to right (as on the Tide header)."""
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


def cover(fin: str) -> str:
    f = brand.SIGNATURE[fin]
    glow, crest, body = f['glow'], f['crest'], f['tag']
    a0, a1 = ACCENT[fin]
    parts: list[str] = []

    # The mark, large, on the right: the well, lit, above the tide.
    mx, my, ms = 1128.0, 262.0, 11.0          # centre, and the mark's scale
    parts.append(brand.signature_ground('g', W, H, mx, my, glow, grain=.03))

    # The sea along the bottom, rising left to right; the light under the
    # mark lies on it as broken glints.
    base, slope, amp, period = 548.0, 0.028, 12.0, 330.0
    front = wave(-period, W + period, base, amp, period, slope)
    back = wave(-period * 1.5, W + period, base - 16, amp * .9, period, slope)
    crest_x = lambda x: base - slope * x  # noqa: E731 — mid-height of the tide at x
    parts.append(
        f'<defs><linearGradient id="sea" x1="0" y1="{base - 70:g}" x2="0" y2="{H:g}" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#58C9DE"/><stop offset=".22" stop-color="#1E93AD"/>'
        f'<stop offset="1" stop-color="#04303B"/></linearGradient>'
        f'<linearGradient id="gl"><stop offset="0" stop-color="{crest}" stop-opacity="0"/>'
        f'<stop offset=".5" stop-color="{crest}"/><stop offset="1" stop-color="{crest}" stop-opacity="0"/></linearGradient>'
        f'<radialGradient id="col"><stop offset="0" stop-color="{glow}" stop-opacity=".5"/>'
        f'<stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient>'
        f'<clipPath id="seaclip"><path d="{front} V{H + 40} H{-period} Z"/></clipPath>'
        f'<filter id="sg" x="-5%" y="-300%" width="110%" height="700%"><feGaussianBlur stdDeviation="5"/></filter>'
        f'<filter id="gb" x="-10%" y="-400%" width="120%" height="900%"><feGaussianBlur stdDeviation=".7"/></filter>'
        f'</defs>'
        f'<path d="{back} V{H + 40} H{-period * 1.5} Z" fill="#0F5262" opacity=".85"/>'
        f'<path d="{back}" fill="none" stroke="{crest}" stroke-width="1" opacity=".16"/>'
        f'<path d="{front} V{H + 40} H{-period} Z" fill="url(#sea)"/>'
        f'<path d="{front}" fill="none" stroke="{glow}" stroke-width="7" opacity=".5" filter="url(#sg)"/>'
        f'<path d="{front}" fill="none" stroke="{crest}" stroke-width="1.3" opacity=".9"/>'
    )
    # Glints: fixed, not random, so the file is reproducible.
    rows = [(10, [(30, -2)], .85), (9, [(20, -24), (36, 12)], .7), (11, [(58, 0)], .55),
            (12, [(28, -40), (46, 16)], .45), (14, [(86, 4)], .34)]
    glints, y = [], crest_x(mx) + 4
    for k, (gap, streaks, op) in enumerate(rows):
        y += gap
        for w, off in streaks:
            glints.append(f'<ellipse cx="{mx + off:.1f}" cy="{y:.1f}" rx="{w / 2:g}" ry="{1.1 + k * .2:.2f}" '
                          f'fill="url(#gl)" opacity="{op}"/>')
    parts.append(f'<g clip-path="url(#seaclip)"><ellipse cx="{mx:g}" cy="{crest_x(mx) + 30:.1f}" rx="130" ry="70" '
                 f'fill="url(#col)"/><g filter="url(#gb)">{"".join(glints)}</g></g>')

    parts.append(f'<g transform="translate({mx - 16 * ms:.2f} {my - 16 * ms:.2f}) scale({ms})">'
                 f'{brand.mark_signature(fin, "cm")}</g>')

    # Lockup, top left.
    left = 92.0
    ls, ly = 1.7, 58.0
    mark_w = (brand.INK1 - INK0) * ls
    parts.append(f'<g transform="translate({left - INK0 * ls:.2f} {ly - INK0 * ls:.2f}) scale({ls})">'
                 f'{brand.mark_signature(fin, "lm")}</g>')
    parts.append(f'<path d="{text(word, "Tidewell", 30, ly + mark_w / 2 + 10.5, left + mark_w + 14, -0.02)}" fill="#FFFFFF"/>')

    # Eyebrow, headline, and the two lines under it.
    parts.append(f'<path d="{text(manrope_b, EYEBROW, 16, 196, left, 0.24)}" fill="{a1}"/>')
    parts.append(
        f'<defs><linearGradient id="h2" x1="{left:g}" y1="0" x2="{left + width(sora, HEAD_2, 66, -0.02):g}" y2="0" '
        f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{a0}"/><stop offset="1" stop-color="{a1}"/>'
        f'</linearGradient></defs>'
    )
    parts.append(f'<path d="{text(sora, HEAD_1, 66, 270, left - 3, -0.02)}" fill="#FFFFFF"/>')
    parts.append(f'<path d="{text(sora, HEAD_2, 66, 346, left - 3, -0.02)}" fill="url(#h2)"/>')
    parts.append(f'<path d="{text(manrope, SUB_1, 23, 408, left)}" fill="{body}"/>')
    parts.append(f'<path d="{text(manrope, SUB_2, 23, 442, left)}" fill="{body}"/>')

    # The address, on the water, bottom right.
    url = 'tidewell.live'
    parts.append(f'<path d="{text(manrope_b, url, 20, H - 26, W - 92 - width(manrope_b, url, 20, 0.04), 0.04)}" '
                 f'fill="#FFFFFF" opacity=".95"/>')

    body_svg = '\n  '.join(parts)
    return brand.svg(body_svg, f'0 0 {W} {H}', W, H).replace(
        'aria-label="Tidewell"', 'aria-label="Introducing Tidewell: liquidity that earns from real trading"')


def main() -> None:
    for fin in ('glass', 'gold'):
        brand.write(os.path.join(brand.OUT, f'article-cover-{fin}.svg'), cover(fin))


if __name__ == '__main__':
    main()
