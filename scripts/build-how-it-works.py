#!/usr/bin/env python3
"""
The "How Tidewell works" post image for X: one premium 16:9 banner in the
Signature glass finish, every word outlined from the site's own fonts so it
renders identically everywhere.

    python3 scripts/build-how-it-works.py && node scripts/build-brand-png.mjs x-post-how-it-works

Writes brand/x-post-how-it-works.svg; the PNG step renders it at 1600×900
(X's in-feed size) and 3200×1800.

Every claim on it is a property of the contracts as built (CLAUDE.md §20):
one token in from $10, full-range liquidity in a Uniswap v4 pool, fees
credited per share the moment they are collected, claimable any time in the
pool's own tokens, 90% to stakers and 10% to the protocol, no lockup and no
exit fee. No yield figure: §1 forbids a forward one, and a trailing one would
be stale the day after posting.
"""
from __future__ import annotations

import glob
import importlib.util
import os

from fontTools.ttLib import TTFont

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location('brand', os.path.join(HERE, 'build-brand.py'))
brand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand)

W, H = 1600, 900
FIN = 'glass'
F = brand.SIGNATURE[FIN]
CREST = F['crest']
GLOW = F['glow']
BODY = F['tag']          # #BFE6EE: secondary copy on the deep ground
CYAN = '#7FDCEC'
INK0 = brand.INK0


def static_font(family: str, sample: str) -> TTFont:
    """A static face from the app's build output (IBM Plex Mono ships static)."""
    for candidate in sorted(glob.glob(os.path.join(brand.ROOT, '.next/static/media/*.woff2'))):
        font = TTFont(candidate)
        name = next((r.toUnicode() for r in font['name'].names if r.nameID == 1), '')
        if name == family and all(ord(c) in font.getBestCmap() for c in sample):
            return font
    raise SystemExit(f'No {family} covering {sample!r} in .next/static/media — run `npm run build`.')


sora = brand.load('Sora', 700, 'HowTidelrksStakEnyCaimAT.')
sora_s = brand.load('Sora', 600, 'StakeETHrnvyClimy')
manrope = brand.load('Manrope', 500, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%.,·—-')
manrope_b = brand.load('Manrope', 600, 'HOWITRKSRBNCabcdefghijklmnopqrstuvwxyz0123456789%·.')
mono = static_font('IBM Plex Mono SemiBold', '0123')
word = brand.load('Sora', 600, 'Tidewel')


def width(font: TTFont, s: str, size: float, tracking: float = 0.0) -> float:
    return brand.outline(font, s, size, 0, 0, tracking)[1]


def text(font: TTFont, s: str, size: float, y: float, x: float | None = None,
         cx: float | None = None, tracking: float = 0.0) -> str:
    if cx is not None:
        x = cx - width(font, s, size, tracking) / 2
    return brand.outline(font, s, size, y, x or 0, tracking)[0]


def glass_rect(x: float, y: float, w: float, h: float, rx: float, uid: str, strong: float = 1) -> str:
    return (
        f'<defs><linearGradient id="{uid}" x1="0" y1="{y:g}" x2="0" y2="{y + h:g}" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#FFFFFF" stop-opacity="{.13 * strong:.3f}"/>'
        f'<stop offset=".45" stop-color="#FFFFFF" stop-opacity="{.05 * strong:.3f}"/>'
        f'<stop offset="1" stop-color="#FFFFFF" stop-opacity="{.025 * strong:.3f}"/></linearGradient></defs>'
        f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}" fill="url(#{uid})"/>'
        f'<rect x="{x + .75:g}" y="{y + .75:g}" width="{w - 1.5:g}" height="{h - 1.5:g}" rx="{rx - .75:g}" fill="none" '
        f'stroke="#FFFFFF" stroke-opacity="{.16 * strong:.3f}" stroke-width="1.5"/>'
        # A hairline of light along the top edge, as glass catches it.
        f'<path d="M{x + rx:g} {y + 1.2:g} H{x + w - rx:g}" stroke="#FFFFFF" stroke-opacity="{.35 * strong:.3f}" '
        f'stroke-width="1.2" stroke-linecap="round"/>'
    )


# ------------------------------------------------------------------ icons --
# Drawn in a 96 × 96 box, centred on (48, 48).
def icon_stake() -> str:
    """ETH, falling into the well."""
    return (
        '<defs><linearGradient id="ie" x1="48" y1="8" x2="48" y2="80" gradientUnits="userSpaceOnUse">'
        '<stop offset="0" stop-color="#E9FCFF"/><stop offset=".5" stop-color="#7FDCEC"/>'
        '<stop offset="1" stop-color="#1C97B1"/></linearGradient></defs>'
        '<circle cx="48" cy="52" r="40" fill="none" stroke="#7FDCEC" stroke-opacity=".28" stroke-width="2"/>'
        '<path d="M48 10 L70 47 L48 60 L26 47 Z" fill="url(#ie)" opacity=".95"/>'
        '<path d="M48 10 L48 60 L26 47 Z" fill="#FFFFFF" opacity=".22"/>'
        '<path d="M48 65 L70 52 L48 84 L26 52 Z" fill="url(#ie)" opacity=".8"/>'
        '<path d="M48 10 L70 47 L48 60 L26 47 Z M48 65 L70 52 L48 84 L26 52 Z" fill="none" stroke="#FFFFFF" '
        'stroke-opacity=".7" stroke-width="1.6" stroke-linejoin="round"/>'
    )


def icon_trade() -> str:
    """Trades both ways, a fee dropping out of each."""
    return (
        '<circle cx="48" cy="48" r="40" fill="none" stroke="#7FDCEC" stroke-opacity=".28" stroke-width="2"/>'
        '<g fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M22 36 H70 M60 26 L70 36 L60 46"/>'
        '<path d="M74 60 H26 M36 50 L26 60 L36 70" stroke="#7FDCEC"/></g>'
        '<circle cx="48" cy="80" r="5" fill="#FFFFFF"/><circle cx="48" cy="80" r="10" fill="#2EC4E0" opacity=".25"/>'
    )


def icon_claim(dollar: str) -> str:
    """Two tokens, both yours."""
    return (
        '<defs><linearGradient id="ic" x1="0" y1="20" x2="0" y2="80" gradientUnits="userSpaceOnUse">'
        '<stop offset="0" stop-color="#E9FCFF"/><stop offset="1" stop-color="#3DB9D1"/></linearGradient></defs>'
        '<circle cx="48" cy="48" r="40" fill="none" stroke="#7FDCEC" stroke-opacity=".28" stroke-width="2"/>'
        '<circle cx="31" cy="57" r="17" fill="#0B4A59" stroke="url(#ic)" stroke-width="3.5"/>'
        '<path d="M31 45.5 L38 57 L31 61 L24 57 Z M31 63 L38 59 L31 69 L24 59 Z" fill="#E9FCFF" opacity=".95"/>'
        '<circle cx="64" cy="39" r="17" fill="#0E6177" stroke="url(#ic)" stroke-width="3.5"/>'
        f'<path d="{dollar}" fill="#FFFFFF"/>'
    )


def chevron(cx: float, cy: float) -> str:
    return (
        f'<circle cx="{cx:g}" cy="{cy:g}" r="19" fill="#0B4A59" stroke="#7FDCEC" stroke-opacity=".45" stroke-width="1.5"/>'
        f'<path d="M{cx - 4:g} {cy - 7:g} L{cx + 4:g} {cy:g} L{cx - 4:g} {cy + 7:g}" fill="none" stroke="#FFFFFF" '
        f'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    )


# -------------------------------------------------------------------- sea --
def wave(x0: float, x1: float, base: float, amp: float, period: float, slope: float) -> str:
    """The mark's tide line at banner scale: alternating half-period arcs."""
    half = period / 2
    d = [f'M{x0:.1f} {base - slope * x0:.1f}']
    x, k = x0, 0
    while x < x1:
        nx = x + half
        sgn = -1 if k % 2 == 0 else 1
        y0, y1 = base - slope * x, base - slope * nx
        c1 = (x + half / 3, y0 + sgn * amp)
        c2 = (nx - half / 3, y1 + sgn * amp)
        d.append(f'C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {nx:.1f} {y1:.1f}')
        x, k = nx, k + 1
    return ' '.join(d)


def main() -> None:
    parts: list[str] = []
    parts.append(brand.signature_ground('g', W, H, W / 2, 300, GLOW, grain=.03))

    # The sea along the bottom: the mark's own tide, rising left to right.
    front = wave(-120, W + 120, 828, 13, 300, 0.012)
    back = wave(-270, W + 120, 812, 11, 300, 0.012)
    parts.append(
        '<defs><linearGradient id="sea" x1="0" y1="780" x2="0" y2="900" gradientUnits="userSpaceOnUse">'
        '<stop offset="0" stop-color="#58C9DE"/><stop offset=".25" stop-color="#1E93AD"/>'
        '<stop offset="1" stop-color="#05333F"/></linearGradient>'
        '<filter id="sg" x="-5%" y="-300%" width="110%" height="700%"><feGaussianBlur stdDeviation="5"/></filter></defs>'
        f'<path d="{back} V{H + 20} H-270 Z" fill="#0F5262" opacity=".85"/>'
        f'<path d="{front} V{H + 20} H-120 Z" fill="url(#sea)"/>'
        f'<path d="{front}" fill="none" stroke="{GLOW}" stroke-width="7" opacity=".5" filter="url(#sg)"/>'
        f'<path d="{front}" fill="none" stroke="{CREST}" stroke-width="1.4" opacity=".9"/>'
    )

    # Lockup, top left.
    scale = 1.95
    lx, ly = 72, 54
    mark_w = (brand.INK1 - INK0) * scale
    parts.append(f'<g transform="translate({lx - INK0 * scale:.2f} {ly - INK0 * scale:.2f}) scale({scale})">'
                 f'{brand.mark_signature(FIN, "lm")}</g>')
    parts.append(f'<path d="{text(word, "Tidewell", 34, ly + mark_w / 2 + 12, lx + mark_w + 16, tracking=-0.02)}" fill="#FFFFFF"/>')

    # The eyebrow pill, top right.
    eye = 'HOW IT WORKS'
    ew = width(manrope_b, eye, 17, 0.22)
    px, py, pw, ph = W - 72 - ew - 44, 58, ew + 44, 42
    parts.append(glass_rect(px, py, pw, ph, ph / 2, 'pill'))
    parts.append(f'<path d="{text(manrope_b, eye, 17, py + 27.5, px + 22, tracking=0.22)}" fill="{CYAN}"/>')

    # Headline and the sentence under it.
    parts.append(f'<path d="{text(sora, "Stake once. Earn from every trade.", 62, 222, cx=W / 2, tracking=-0.015)}" fill="#FFFFFF"/>')
    parts.append(f'<path d="{text(manrope, "Real swap fees from Uniswap v4 pools on Robinhood Chain. No emissions, ever.", 25, 270, cx=W / 2)}" fill="{BODY}"/>')

    # Three steps.
    cw, chh, gap = 440, 330, 60
    x0 = (W - (3 * cw + 2 * gap)) / 2
    top = 318
    dollar = text(manrope_b, '$', 22, 47, cx=64)
    steps = [
        ('01', 'Stake ETH', icon_stake(),
         ['One token in, from $10. It becomes', 'full-range liquidity in a Uniswap v4', 'pool on Robinhood Chain.']),
        ('02', 'Earn every trade', icon_trade(),
         ['Every swap pays the pool a fee. Your', 'share is credited to you the moment', 'it is collected. No lockup.']),
        ('03', 'Claim anytime', icon_claim(dollar),
         ['Your fees, in the pool\'s own tokens', '(ETH + USDG). Withdraw whenever:', 'no exit fee, nothing forfeited.']),
    ]
    for i, (num, title, icon, lines) in enumerate(steps):
        x = x0 + i * (cw + gap)
        cx = x + cw / 2
        parts.append(glass_rect(x, top, cw, chh, 30, f'card{i}', strong=1.15))
        parts.append(f'<path d="{text(mono, num, 20, top + 44, x + 30)}" fill="{CYAN}" opacity=".9"/>')
        parts.append(f'<g transform="translate({cx - 48:g} {top + 34:g})">{icon}</g>')
        parts.append(f'<path d="{text(sora_s, title, 33, top + 186, cx=cx, tracking=-0.01)}" fill="#FFFFFF"/>')
        for j, line in enumerate(lines):
            parts.append(f'<path d="{text(manrope, line, 20, top + 232 + j * 30, cx=cx)}" fill="{BODY}"/>')
        if i < 2:
            parts.append(chevron(x + cw + gap / 2, top + chh / 2))

    # What makes the numbers honest, as three chips.
    chips = ['Real swap fees · zero emissions', '90% to stakers · 10% protocol', 'Only you can withdraw your stake']
    size = 19
    widths = [width(manrope_b, c, size) + 52 for c in chips]
    cgap = 22
    cx0 = (W - (sum(widths) + cgap * (len(chips) - 1))) / 2
    cy = 690
    for i, (c, cwid) in enumerate(zip(chips, widths)):
        parts.append(glass_rect(cx0, cy, cwid, 46, 23, f'chip{i}', strong=.9))
        parts.append(f'<circle cx="{cx0 + 22:g}" cy="{cy + 23:g}" r="4" fill="{GLOW}"/>')
        parts.append(f'<path d="{text(manrope_b, c, size, cy + 30, cx0 + 34)}" fill="#FFFFFF"/>')
        cx0 += cwid + cgap

    # The address, on the water.
    parts.append(f'<path d="{text(manrope_b, "tidewell.live", 22, 874, cx=W / 2, tracking=0.04)}" fill="#FFFFFF" opacity=".95"/>')

    body = '\n  '.join(parts)
    brand.write(os.path.join(brand.OUT, 'x-post-how-it-works.svg'),
                brand.svg(body, f'0 0 {W} {H}', W, H).replace('aria-label="Tidewell"', 'aria-label="How Tidewell works"'))


if __name__ == '__main__':
    main()
