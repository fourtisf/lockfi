#!/usr/bin/env python3
"""
Generate the Tidewell brand assets from the mark's geometry and the real fonts.

The wordmark is converted to outlines from Sora at weight 600, and the card
copy from Manrope — the same variable fonts the app ships, instanced — so no
logo file depends on a font being installed anywhere.

    pip install fonttools brotli
    python3 scripts/build-brand.py

Writes to brand/ and app/icon.svg. PNGs are rasterised by
scripts/build-brand-png.mjs.
"""

from __future__ import annotations

import glob
import os
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'brand')

# ---------------------------------------------------------------- geometry --
# The mark, on a 32 × 32 grid: a well seen from above, filled to the tide line.
# See components/shell/Logo.tsx — the numbers there and here are the same.
RING_C, RING_R, RING_W = 16, 12.2, 2.4
CLIP_R = 11
WATER = 'M3 17.5c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0 4.4 2.4 6.6 0V30H3z'
# Premium only: the tide line alone (for a highlight), and a swell behind it —
# the same wave, half a period out of phase and 1.9 units higher.
CREST = 'M3 17.5c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0 4.4 2.4 6.6 0'
SWELL = 'M3 15.6c2.2 2.4 4.4 2.4 6.6 0s4.4-2.4 6.6 0 4.4 2.4 6.6 0 4.4-2.4 6.6 0V30H3z'

# Ink box, including the ring's stroke: 26.8 × 26.8, centred on (16, 16).
INK0 = RING_C - RING_R - RING_W / 2
INK1 = RING_C + RING_R + RING_W / 2

# Logo files are cropped to the artwork: no ground, no built-in margin. A
# hairline of slack keeps the ring's anti-aliased edge from being shaved off.
# Clear space is a usage rule (the /brand page states it), not padding baked
# into every file someone then has to trim.
TRIM = 0.06
MARK_VIEW = f'{INK0 - TRIM:g} {INK0 - TRIM:g} {INK1 - INK0 + 2 * TRIM:g} {INK1 - INK0 + 2 * TRIM:g}'

# ------------------------------------------------------------------ colour --
BRAND = '#0B6E86'       # --ac
BRAND_DEEP = '#0A5568'  # the lower edge of the brand ground
GROUND = '#ECF2F2'      # --bg
INK = '#0C1E24'         # --fg
WHITE = '#FFFFFF'
MIST = '#CFE7EC'        # secondary copy on the brand ground (8.1:1 on BRAND_DEEP)

# The wordmark's relationship to the mark, measured rather than guessed.
WORD_SIZE_RATIO = 0.76  # font size as a multiple of the mark's grid
TRACKING_EM = -0.02
GAP_CAPS = 0.62         # optical gap, ink to ink, in cap heights

# rx 7 of 32 is the squircle proportion iOS and Android expect. The full-bleed
# cut uses 0, because every avatar surface applies its own mask.
TILE_R = 7


def mark(color: str, clip_id: str = 'tw') -> str:
    return (
        f'<defs><clipPath id="{clip_id}"><circle cx="{RING_C}" cy="{RING_C}" r="{CLIP_R}"/>'
        f'</clipPath></defs>\n  '
        f'<circle cx="{RING_C}" cy="{RING_C}" r="{RING_R}" fill="none" stroke="{color}" '
        f'stroke-width="{RING_W}"/>\n  '
        f'<path d="{WATER}" fill="{color}" clip-path="url(#{clip_id})"/>'
    )


# The premium cut: depth instead of flat colour. A gradient ring, a swell behind
# the tide, water that darkens with depth and a highlight on the crest. Same
# silhouette as the flat mark, so it reads as the same logo at any size; it is
# for hero use — app icons, the brand page, decks — and the flat mark stays the
# one for UI, favicons and anything printed in one colour.
PREMIUM = {
    # Every fill is opaque: the files have no ground, so a translucent swell
    # would take on whatever it is placed over and the logo would not look the
    # same twice. These are the old tints pre-mixed onto white and deep sea.
    'light': dict(ring=('#2FA6BE', '#0A4F60'), swell=('#B4E4EC', 1),
                  water=('#1590AB', '#084556'), crest=('#BDEAF2', 1)),
    'dark': dict(ring=('#FFFFFF', '#8FDCEA'), swell=('#2F7B8A', 1),
                 water=('#7AD8E8', '#1C93AD'), crest=('#FFFFFF', 1)),
}


def mark_premium(tone: str, uid: str = 'p') -> str:
    t = PREMIUM[tone]
    return (
        f'<defs>'
        f'<linearGradient id="{uid}r" x1="16" y1="{INK0}" x2="16" y2="{INK1}" '
        f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{t["ring"][0]}"/>'
        f'<stop offset="1" stop-color="{t["ring"][1]}"/></linearGradient>'
        f'<linearGradient id="{uid}w" x1="16" y1="14" x2="16" y2="28" '
        f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{t["water"][0]}"/>'
        f'<stop offset="1" stop-color="{t["water"][1]}"/></linearGradient>'
        f'<clipPath id="{uid}c"><circle cx="{RING_C}" cy="{RING_C}" r="{CLIP_R}"/></clipPath>'
        f'</defs>\n  '
        f'<circle cx="{RING_C}" cy="{RING_C}" r="{RING_R}" fill="none" stroke="url(#{uid}r)" '
        f'stroke-width="{RING_W}"/>\n  '
        f'<g clip-path="url(#{uid}c)">'
        f'<path d="{SWELL}" fill="{t["swell"][0]}" opacity="{t["swell"][1]}"/>'
        f'<path d="{WATER}" fill="url(#{uid}w)"/>'
        f'<path d="{CREST}" fill="none" stroke="{t["crest"][0]}" stroke-width="0.6" '
        f'stroke-linecap="round" opacity="{t["crest"][1]}"/></g>'
    )


def premium_ground(uid: str, w: float, h: float, rx: float = 0) -> str:
    """Deep sea: a lit centre falling off to near-black teal, with a hairline edge."""
    edge = f' rx="{rx:g}"' if rx else ''
    return (
        f'<defs><radialGradient id="{uid}g" cx="50%" cy="30%" r="80%">'
        f'<stop offset="0" stop-color="#11657A"/><stop offset=".55" stop-color="#0A3D4A"/>'
        f'<stop offset="1" stop-color="#05222A"/></radialGradient></defs>\n  '
        f'<rect width="{w:g}" height="{h:g}"{edge} fill="url(#{uid}g)"/>\n  '
        f'<rect x=".25" y=".25" width="{w - 0.5:g}" height="{h - 0.5:g}"{edge} fill="none" '
        f'stroke="#FFFFFF" stroke-opacity=".10" stroke-width=".5"/>'
    )


# The Signature edition: the mark as a polished porthole. A metal ring with a
# specular sweep and a soft halo, water lit from above and shadowed at depth, a
# glowing crest, and a crescent reflection across the glass. Two finishes:
# glass (the brand teal) and gold (an edition, for launches and partners). For
# avatars, headers and hero images only — the flat and premium cuts remain the
# logo everywhere else.
SIGNATURE = {
    'glass': dict(ring=[(0, '#FFFFFF'), (.16, '#C9F6FC'), (.42, '#3DB9D1'), (.58, '#F2FEFF'),
                        (.78, '#2AA2BB'), (1, '#0D5E72')],
                  glow='#2EC4E0', glow_o=.55, crest='#FFFFFF', rim='#FFFFFF',
                  word=('#FFFFFF', '#D3EEF4'), tag='#BFE6EE'),
    'gold': dict(ring=[(0, '#FFF6DA'), (.2, '#F1D27E'), (.45, '#B98A2F'), (.6, '#FFEBAE'),
                       (.8, '#C49536'), (1, '#7E5A1C')],
                 glow='#E8B85A', glow_o=.38, crest='#FFF3CF', rim='#FFF8E6',
                 word=('#FFFFFF', '#F4E6C2'), tag='#E6CF96'),
}
# The crescent of reflected light: the band between the glass's edge and a
# larger circle shifted down and right.
SHINE = 'M5.6 15.2A10.4 10.4 0 0 1 21.6 6.9A11.4 11.4 0 0 0 6.9 15.6Z'


def mark_signature(fin: str, u: str, halo: bool = True) -> str:
    f = SIGNATURE[fin]
    stops = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in f['ring'])
    glow = (
        f'<circle cx="16" cy="16" r="{RING_R}" fill="none" stroke="{f["glow"]}" '
        f'stroke-width="{RING_W + 1.2}" opacity="{f["glow_o"]}" filter="url(#{u}g)"/>' if halo else ''
    )
    return (
        f'<defs>'
        f'<linearGradient id="{u}r" x1="6" y1="3" x2="26" y2="29" gradientUnits="userSpaceOnUse">{stops}</linearGradient>'
        f'<linearGradient id="{u}w" x1="16" y1="13" x2="16" y2="28" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#9BEAF5"/><stop offset=".3" stop-color="#2DB4CD"/>'
        f'<stop offset=".7" stop-color="#0E7590"/><stop offset="1" stop-color="#07404F"/></linearGradient>'
        f'<radialGradient id="{u}d" cx="16" cy="16" r="{CLIP_R}" gradientUnits="userSpaceOnUse">'
        f'<stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".38"/></radialGradient>'
        f'<linearGradient id="{u}s" x1="7" y1="7" x2="17" y2="12" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#FFF" stop-opacity=".62"/><stop offset=".6" stop-color="#FFF" stop-opacity=".12"/>'
        f'<stop offset="1" stop-color="#FFF" stop-opacity="0"/></linearGradient>'
        f'<clipPath id="{u}c"><circle cx="16" cy="16" r="{CLIP_R}"/></clipPath>'
        f'<filter id="{u}g" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.3"/></filter>'
        f'<filter id="{u}cg" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation=".45"/></filter>'
        f'</defs>\n  {glow}'
        f'<g clip-path="url(#{u}c)">'
        f'<rect x="3" y="3" width="26" height="26" fill="#0A3A46"/>'
        f'<path d="{SWELL}" fill="#17606F"/>'
        f'<path d="{WATER}" fill="url(#{u}w)"/>'
        f'<path d="{CREST}" fill="none" stroke="{f["crest"]}" stroke-width="1.1" opacity=".7" filter="url(#{u}cg)"/>'
        f'<path d="{CREST}" fill="none" stroke="{f["crest"]}" stroke-width=".45" stroke-linecap="round"/>'
        f'<circle cx="16" cy="16" r="{CLIP_R}" fill="url(#{u}d)"/>'
        f'<path d="{SHINE}" fill="url(#{u}s)"/></g>'
        f'<circle cx="16" cy="16" r="{RING_R}" fill="none" stroke="url(#{u}r)" stroke-width="{RING_W}"/>'
        f'<circle cx="16" cy="16" r="{RING_R - RING_W / 2 + .18:g}" fill="none" stroke="{f["rim"]}" stroke-width=".22" opacity=".55"/>'
        f'<circle cx="16" cy="16" r="{RING_R + RING_W / 2 - .12:g}" fill="none" stroke="#000" stroke-width=".18" opacity=".25"/>'
    )


def signature_ground(u: str, w: float, h: float, cx: float, cy: float, glow: str,
                     rx: float = 0, grain: float = .05) -> str:
    """Deep water lit from one point, a bloom of the finish's colour, fine grain."""
    edge = f' rx="{rx:g}"' if rx else ''
    noise = (
        f'<filter id="{u}n" x="0" y="0" width="100%" height="100%">'
        f'<feTurbulence type="fractalNoise" baseFrequency="{620 / max(w, h):.4f}" numOctaves="2" seed="7"/>'
        f'<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 {grain} 0"/>'
        f'</filter>' if grain else ''
    )
    return (
        f'<defs><radialGradient id="{u}bg" cx="{cx:g}" cy="{cy:g}" r="{max(w, h) * .75:g}" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#0F6377"/><stop offset=".38" stop-color="#073845"/>'
        f'<stop offset="1" stop-color="#021116"/></radialGradient>'
        f'<radialGradient id="{u}bl" cx="{cx:g}" cy="{cy:g}" r="{min(w, h) * .42:g}" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="{glow}" stop-opacity=".30"/><stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient>'
        f'{noise}</defs>\n  '
        f'<rect width="{w:g}" height="{h:g}"{edge} fill="url(#{u}bg)"/>'
        f'<rect width="{w:g}" height="{h:g}"{edge} fill="url(#{u}bl)"/>'
        + (f'<rect width="{w:g}" height="{h:g}"{edge} filter="url(#{u}n)"/>' if grain else '')
    )


def tile(ground: str, art: str, scale: float = 0.72, radius: float = TILE_R) -> str:
    pad = (32 - 32 * scale) / 2
    rect = (
        f'<rect width="32" height="32" fill="{ground}"/>' if radius == 0
        else f'<rect width="32" height="32" rx="{radius:g}" fill="{ground}"/>'
    )
    return f'{rect}\n  <g transform="translate({pad:g} {pad:g}) scale({scale:g})">{art}</g>'


def svg(body: str, view: str, w: float, h: float) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{w:g}" '
        f'height="{h:g}" role="img" aria-label="Tidewell">\n  {body}\n</svg>\n'
    )


def write(path: str, content: str) -> None:
    with open(path, 'w') as fh:
        fh.write(content)
    print(f'  {os.path.relpath(path, ROOT):40s} {len(content):6d} B')


# -------------------------------------------------------------- the fonts --
def load(family: str, weight: int, sample: str) -> TTFont:
    """A variable font from the app's own build output, instanced at a weight."""
    for candidate in sorted(glob.glob(os.path.join(ROOT, '.next/static/media/*.woff2'))):
        font = TTFont(candidate)
        name = next((r.toUnicode() for r in font['name'].names if r.nameID == 1), '')
        if family not in name or 'fvar' not in font:
            continue
        if not all(ord(c) in font.getBestCmap() for c in sample):
            continue
        return instancer.instantiateVariableFont(font, {'wght': weight}, inplace=False)
    raise SystemExit(
        f'No {family} subset covering {sample!r} in .next/static/media — '
        'run `npm run build` first.'
    )


def outline(font: TTFont, text: str, size: float, baseline_y: float, x0: float,
            tracking_em: float = 0.0) -> tuple[str, float]:
    """Any string as outlines, plus the ink's right edge — the last glyph's
    actual ink, not its advance, so a crop to it leaves no side bearing."""
    upm = font['head'].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    scale = size / upm
    tracking = tracking_em * size

    data: list[str] = []
    pen_x, right = x0, x0
    for ch in text:
        if ch == ' ':
            pen_x += hmtx[cmap[ord(' ')]][0] * scale + tracking
            continue
        if ord(ch) not in cmap:
            continue
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}')
        # Font space is y-up from the baseline; SVG is y-down.
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, pen_x, baseline_y)))
        d = pen.getCommands()
        if d:
            data.append(d)
            bounds = BoundsPen(glyphs)
            glyphs[name].draw(bounds)
            if bounds.bounds:
                right = pen_x + bounds.bounds[2] * scale
        pen_x += hmtx[name][0] * scale + tracking
    return ' '.join(data), right


# ----------------------------------------------------------------- build ----
def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    o = lambda name: os.path.join(OUT, name)  # noqa: E731

    print('marks — transparent')
    for name, color in [
        ('tidewell-mark.svg', BRAND),
        ('tidewell-mark-white.svg', WHITE),
        ('tidewell-mark-ink.svg', INK),
        ('tidewell-mark-currentcolor.svg', 'currentColor'),
    ]:
        write(o(name), svg(mark(color), MARK_VIEW, 512, 512))

    print('icons')
    # Full bleed: brand to every edge. Every avatar surface masks it itself.
    write(o('icon-brand.svg'), svg(tile(BRAND, mark(WHITE), 0.72, 0), '0 0 32 32', 1024, 1024))
    # Squircle, for surfaces that do not mask.
    write(o('icon-brand-rounded.svg'), svg(tile(BRAND, mark(WHITE)), '0 0 32 32', 1024, 1024))
    write(o('icon-light-rounded.svg'), svg(tile(GROUND, mark(BRAND)), '0 0 32 32', 1024, 1024))
    # The favicon keeps its ground: a transparent one vanishes into browser chrome.
    favicon = svg(tile(BRAND, mark(WHITE), 0.78), '0 0 32 32', 32, 32)
    write(o('favicon.svg'), favicon)
    write(os.path.join(ROOT, 'app', 'icon.svg'), favicon)

    print('lockups')
    word = load('Sora', 600, 'Tidewel')
    cap = word['OS/2'].sCapHeight / word['head'].unitsPerEm
    size = WORD_SIZE_RATIO * 32
    cap_h = size * cap
    baseline = 16 + cap_h / 2
    d, ink_right = outline(word, 'Tidewell', size, baseline, INK1 + GAP_CAPS * cap_h, TRACKING_EM)

    pad = TRIM
    vb = (INK0 - pad, INK0 - pad, (ink_right - INK0) + pad * 2, (INK1 - INK0) + pad * 2)
    view = f'{vb[0]:.2f} {vb[1]:.2f} {vb[2]:.2f} {vb[3]:.2f}'
    for name, mcol, wcol in [
        ('tidewell-lockup.svg', BRAND, INK),
        ('tidewell-lockup-white.svg', WHITE, WHITE),
    ]:
        write(o(name), svg(mark(mcol) + f'\n  <path d="{d}" fill="{wcol}"/>', view,
                           round(vb[2] * 4, 2), round(vb[3] * 4, 2)))

    print('premium')
    write(o('tidewell-mark-premium.svg'), svg(mark_premium('light'), MARK_VIEW, 512, 512))
    write(o('tidewell-mark-premium-dark.svg'), svg(mark_premium('dark'), MARK_VIEW, 512, 512))
    sc = 0.70
    pad_p = (32 - 32 * sc) / 2
    write(o('icon-premium.svg'), svg(
        premium_ground('i', 32, 32, TILE_R) +
        f'\n  <g transform="translate({pad_p:g} {pad_p:g}) scale({sc:g})">{mark_premium("dark")}</g>',
        '0 0 32 32', 1024, 1024))
    write(o('icon-premium-fullbleed.svg'), svg(
        premium_ground('f', 32, 32) +
        f'\n  <g transform="translate({pad_p:g} {pad_p:g}) scale({sc:g})">{mark_premium("dark")}</g>',
        '0 0 32 32', 1024, 1024))
    for name, tone, wcol in [
        ('tidewell-lockup-premium.svg', 'light', INK),
        ('tidewell-lockup-premium-dark.svg', 'dark', WHITE),
    ]:
        write(o(name), svg(mark_premium(tone) + f'\n  <path d="{d}" fill="{wcol}"/>', view,
                           round(vb[2] * 4, 2), round(vb[3] * 4, 2)))

    # ------------------------------------------------------- social profile --
    # X (and Telegram, Discord) show the avatar as a circle cut from a square
    # upload, so the ground runs to every edge and the mark sits well inside
    # the inscribed circle: 52% of the width, centred, nothing near a corner.
    print('social profile')

    def avatar_ground(uid: str, kind: str) -> str:
        if kind == 'teal':
            return f'<rect width="32" height="32" fill="{BRAND}"/>'
        return (
            # Lighter than the deep-sea ground: at 32–48px on a dark timeline a
            # near-black edge disappears into the page. This one still reads.
            f'<defs><radialGradient id="{uid}g" cx="50%" cy="38%" r="70%">'
            f'<stop offset="0" stop-color="#1A86A1"/><stop offset=".6" stop-color="#0D5A6C"/>'
            f'<stop offset="1" stop-color="#0B4A59"/></radialGradient></defs>\n  '
            f'<rect width="32" height="32" fill="url(#{uid}g)"/>'
        )

    av = 0.62
    av_pad = (32 - 32 * av) / 2
    write(o('x-avatar-premium.svg'), svg(
        avatar_ground('xa', 'premium') +
        f'\n  <g transform="translate({av_pad:g} {av_pad:g}) scale({av:g})">{mark_premium("dark", "xm")}</g>',
        '0 0 32 32', 1000, 1000))
    write(o('x-avatar-teal.svg'), svg(
        avatar_ground('xt', 'teal') +
        f'\n  <g transform="translate({av_pad:g} {av_pad:g}) scale({av:g})">{mark(WHITE, "xt")}</g>',
        '0 0 32 32', 1000, 1000))

    # Header, 1500 × 500 (3:1). The avatar overlaps its lower-left corner on
    # every client, so the lockup is centred and the left fifth stays empty.
    HW, HH = 1500, 500
    HS = 4.2
    h_mark = (INK1 - INK0) * HS
    h_size = 32 * HS * 0.60
    h_cap = h_size * cap
    h_word_w = (ink_right - (INK1 + GAP_CAPS * cap_h)) * (h_size / size)
    h_total = h_mark + GAP_CAPS * h_cap + h_word_w
    hx = (HW - h_total) / 2 + 60
    h_top = 150.0
    h_word, _ = outline(word, 'Tidewell', h_size, h_top + h_mark / 2 + h_cap / 2,
                        hx + h_mark + GAP_CAPS * h_cap, TRACKING_EM)
    h_tag_font = load('Manrope', 500, 'Fees')
    _, h_tag_r = outline(h_tag_font, 'Fees rise with the tide.', 34, 0, 0)
    h_tag, _ = outline(h_tag_font, 'Fees rise with the tide.', 34, h_top + h_mark + 78,
                       hx + (h_total - h_tag_r) / 2)
    write(o('x-header.svg'), svg(
        premium_ground('xh', HW, HH).split('\n  <rect x=".25"')[0] +
        f'\n  <g transform="translate({hx - INK0 * HS:.2f} {h_top - INK0 * HS:.2f}) scale({HS})">'
        f'{mark_premium("dark", "hm")}</g>\n  '
        f'<path d="{h_word}" fill="{WHITE}"/>\n  '
        f'<path d="{h_tag}" fill="#CFE7EC"/>',
        f'0 0 {HW} {HH}', HW, HH))

    # -------------------------------------------------------- signature ---
    print('signature')
    for fin in ('glass', 'gold'):
        f = SIGNATURE[fin]
        # Transparent mark: no halo, so it crops to the ink like every logo file.
        write(o(f'tidewell-mark-signature-{fin}.svg'),
              svg(mark_signature(fin, 'm', halo=False), MARK_VIEW, 512, 512))
        # Avatar: square, full bleed, the mark inside the circle X cuts.
        write(o(f'x-avatar-signature-{fin}.svg'), svg(
            signature_ground('a', 32, 32, 16, 15, f['glow']) +
            f'\n  <g transform="translate({av_pad:g} {av_pad:g}) scale({av:g})">{mark_signature(fin, "m")}</g>',
            '0 0 32 32', 1000, 1000))
        # App icon: the squircle.
        write(o(f'icon-signature-{fin}.svg'), svg(
            signature_ground('i', 32, 32, 16, 15, f['glow'], TILE_R) +
            f'\n  <g transform="translate({pad_p:g} {pad_p:g}) scale({sc:g})">{mark_signature(fin, "m")}</g>',
            '0 0 32 32', 1024, 1024))
        # Header, 1500 x 500, laid out like the premium one.
        grad = (f'<defs><linearGradient id="hw" x1="0" y1="0" x2="0" y2="1">'
                f'<stop offset="0" stop-color="{f["word"][0]}"/><stop offset="1" stop-color="{f["word"][1]}"/>'
                f'</linearGradient></defs>')
        write(o(f'x-header-signature-{fin}.svg'), svg(
            signature_ground('h', HW, HH, hx + h_mark / 2, h_top + h_mark / 2, f['glow'], grain=.035) +
            f'\n  {grad}<g transform="translate({hx - INK0 * HS:.2f} {h_top - INK0 * HS:.2f}) scale({HS})">'
            f'{mark_signature(fin, "hm")}</g>\n  '
            f'<path d="{h_word}" fill="url(#hw)"/>\n  '
            f'<path d="{h_tag}" fill="{f["tag"]}"/>',
            f'0 0 {HW} {HH}', HW, HH))

    # The hero: the premium lockup on the deep-sea ground, with the tagline.
    SW, SH = 2400, 1350
    PS = 13.0
    p_mark = (INK1 - INK0) * PS
    p_size = 32 * PS * 0.60
    p_cap = p_size * cap
    total_w = p_mark + GAP_CAPS * p_cap + (ink_right - (INK1 + GAP_CAPS * cap_h)) * (p_size / size)
    x0 = (SW - total_w) / 2
    p_top = 430.0
    show_word, _ = outline(word, 'Tidewell', p_size, p_top + p_mark / 2 + p_cap / 2,
                           x0 + p_mark + GAP_CAPS * p_cap, TRACKING_EM)
    tag_font = load('Manrope', 500, 'Fees')
    tag_d, tag_r = outline(tag_font, 'Fees rise with the tide.', 64, 0, 0)
    tag_x = (SW - tag_r) / 2
    tag_d, _ = outline(tag_font, 'Fees rise with the tide.', 64, p_top + p_mark + 190, tag_x)
    write(o('tidewell-premium-showcase.svg'), svg(
        premium_ground('s', SW, SH) +
        f'\n  <g transform="translate({x0 - INK0 * PS:.2f} {p_top - INK0 * PS:.2f}) scale({PS})">'
        f'{mark_premium("dark", "sm")}</g>\n  '
        f'<path d="{show_word}" fill="{WHITE}"/>\n  '
        f'<path d="{tag_d}" fill="#CFE7EC"/>',
        f'0 0 {SW} {SH}', SW, SH))

    for fin in ('glass', 'gold'):
        f = SIGNATURE[fin]
        grad = (f'<defs><linearGradient id="sw" x1="0" y1="0" x2="0" y2="1">'
                f'<stop offset="0" stop-color="{f["word"][0]}"/><stop offset="1" stop-color="{f["word"][1]}"/>'
                f'</linearGradient></defs>')
        write(o(f'tidewell-signature-{fin}-showcase.svg'), svg(
            signature_ground('s', SW, SH, x0 + p_mark / 2, p_top + p_mark / 2, f['glow'], grain=.03) +
            f'\n  {grad}<g transform="translate({x0 - INK0 * PS:.2f} {p_top - INK0 * PS:.2f}) scale({PS})">'
            f'{mark_signature(fin, "sm")}</g>\n  '
            f'<path d="{show_word}" fill="url(#sw)"/>\n  '
            f'<path d="{tag_d}" fill="{f["tag"]}"/>',
            f'0 0 {SW} {SH}', SW, SH))

    # ------------------------------------------------------------- og card --
    # 1200 × 630 is what X, Telegram, Discord and Slack all crop from. No URL
    # on it: no Tidewell domain is registered yet (§19).
    print('open graph')
    W, H, M = 1200, 630, 96.0
    S = 4.6                                   # mark grid units -> card px
    top = 150.0
    text = load('Manrope', 600, 'Liquidity')
    w_size = 32 * S * 0.62
    w_cap = w_size * cap
    mark_h = (INK1 - INK0) * S
    word_d, _ = outline(word, 'Tidewell', w_size, top + mark_h / 2 + w_cap / 2,
                        M + mark_h + GAP_CAPS * w_cap, TRACKING_EM)
    tag_d, _ = outline(word, 'Fees rise with the tide.', 44, top + mark_h + 104, M, -0.01)
    sub_d, _ = outline(text, 'Liquidity layer for Robinhood Chain. Fee yield, trailing 7d. '
                             'Paid in WETH. No emissions.', 22, top + mark_h + 160, M)
    write(
        o('og-card.svg'),
        svg(
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
            f'<stop offset="0" stop-color="{BRAND}"/><stop offset="1" stop-color="{BRAND_DEEP}"/>'
            f'</linearGradient></defs>\n  '
            f'<rect width="{W}" height="{H}" fill="url(#g)"/>\n  '
            f'<g transform="translate({M - INK0 * S:.2f} {top - INK0 * S:.2f}) scale({S})">'
            f'{mark(WHITE, "og")}</g>\n  '
            f'<path d="{word_d}" fill="{WHITE}"/>\n  '
            f'<path d="{tag_d}" fill="{WHITE}"/>\n  '
            f'<path d="{sub_d}" fill="{MIST}"/>',
            f'0 0 {W} {H}', W, H,
        ),
    )

    print(f'\nink box {INK1 - INK0:.1f} × {INK1 - INK0:.1f} centred on (16, 16) · '
          f'cap height {cap_h:.2f}')


if __name__ == '__main__':
    main()
