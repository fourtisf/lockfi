#!/usr/bin/env python3
"""Cut the recorded full-page shots into the UI pieces the video shows.

    python3 cut.py <rec dir> <comp dir>

Each piece is a real crop of a real screenshot (2x), padded with the page's
own ground colour so every piece reads as a slice of the app. Writes
<comp>/frags/<name>.png and <comp>/frags.json: per piece its size in CSS px
and the boxes of the things the cursor and highlights point at, relative to
the piece.
"""
import json
import os
import sys

from PIL import Image

REC, COMP = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(REC, 'manifest.json')))
SC = m['scale']
shots = {s['name'].split('-')[0] if s['name'][:3] != 's07' else s['name']: s for s in m['shots']}
os.makedirs(os.path.join(COMP, 'frags'), exist_ok=True)
GROUND = (236, 242, 242)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def prepare():
    """The site's own fonts (from its build output) and the Signature mark."""
    import glob
    import shutil
    from fontTools.ttLib import TTFont
    fonts = os.path.join(COMP, 'fonts')
    os.makedirs(fonts, exist_ok=True)
    os.makedirs(os.path.join(COMP, 'img'), exist_ok=True)
    shutil.copy(os.path.join(ROOT, 'brand', 'tidewell-mark-signature-glass-2048.png'), os.path.join(COMP, 'img'))
    found = {}
    for f in sorted(glob.glob(os.path.join(ROOT, '.next', 'static', 'media', '*.woff2'))):
        t = TTFont(f)
        fam = next((r.toUnicode() for r in t['name'].names if r.nameID == 1), '')
        if not all(ord(c) in t.getBestCmap() for c in 'AZaz09$%·—'):
            continue
        italic = bool(t['OS/2'].fsSelection & 1)
        if 'Sora' in fam and 'fvar' in t:
            found['Sora.woff2'] = f
        elif 'Manrope' in fam and 'fvar' in t:
            found['Manrope.woff2'] = f
        elif 'IBM Plex Mono' in fam and not italic:
            found[f"Plex-{t['OS/2'].usWeightClass}.woff2"] = f
    need = ['Sora.woff2', 'Manrope.woff2', 'Plex-400.woff2', 'Plex-500.woff2', 'Plex-600.woff2']
    missing = [n for n in need if n not in found]
    if missing:
        raise SystemExit(f'fonts not in .next/static/media: {missing} — run `npm run build` first')
    for n in need:
        shutil.copy(found[n], os.path.join(fonts, n))


prepare()


def shot(key):
    for s in m['shots']:
        if s['name'].startswith(key):
            return s
    raise SystemExit(f'no shot {key}')


def box(key, name):
    b = shot(key)['boxes'].get(name)
    if not b:
        raise SystemExit(f'{key} has no box {name}')
    return dict(b)


out = {}


def cut(name, key, rect, pad=16, targets=None, kind='card'):
    """rect in page CSS px; pad adds the page ground around it."""
    s = shot(key)
    im = Image.open(os.path.join(REC, s['file'])).convert('RGB')
    x, y, w, h = rect['x'] - pad, rect['y'] - pad, rect['w'] + 2 * pad, rect['h'] + 2 * pad
    canvas = Image.new('RGB', (w * SC, h * SC), GROUND)
    src = im.crop((max(0, x) * SC, max(0, y) * SC, min(im.width, (x + w) * SC), min(im.height, (y + h) * SC)))
    canvas.paste(src, ((max(0, x) - x) * SC, (max(0, y) - y) * SC))
    canvas.save(os.path.join(COMP, 'frags', f'{name}.png'), optimize=True)
    rel = {}
    for k, t in (targets or {}).items():
        b = s['boxes'].get(t) if isinstance(t, str) else t
        if b:
            rel[k] = {'x': b['x'] - x, 'y': b['y'] - y, 'w': b['w'], 'h': b['h']}
    out[name] = {'src': f'frags/{name}.png', 'w': w, 'h': h, 'targets': rel, 'kind': kind, 'shot': s['name']}


# Step 1: the nav, without the search box and status chip, and the wallet picker.
cut('navLeft', 's01', {'x': 0, 'y': 0, 'w': 600, 'h': 64}, pad=0, kind='nav')
cut('btnConnect', 's01', box('s01', 'connect'), pad=0, kind='nav')
cut('btnConnected', 's03', box('s03', 'connect'), pad=0, kind='nav')
pop = box('s02', 'pop')
cut('walletPop', 's02', pop, pad=0, targets={'item': 'item'}, kind='pop')
out['walletPop']['offset'] = {'x': pop['x'] - box('s01', 'connect')['x'], 'y': pop['y'] - box('s01', 'connect')['y']}

# Step 2: the vault list card and the stake panel.
v = box('s03', 'vault1')  # the list's header row: the list starts here
vh = box('s01', 'vaults')['h']
vcard = {'x': v['x'] - 1, 'y': v['y'] - 67, 'w': v['w'] + 2, 'h': vh + 68}
row1 = {'x': v['x'], 'y': v['y'] + 44, 'w': v['w'], 'h': 76}
cut('vaults', 's03', vcard, targets={'row1': row1})
pa, pb = box('s03', 'panel'), box('s04', 'panel')
prect = {'x': pa['x'], 'y': pa['y'], 'w': pa['w'], 'h': max(pa['h'], pb['h'])}
ptargets = {k: k for k in ('routeEth', 'amount', 'stake', 'fee', 'lockup', 'share', 'weekly', 'yield', 'steps', 'audit')}
cut('panelA', 's03', prect, targets=ptargets)
cut('panelB', 's04', prect, targets=ptargets)
cut('toastStake', 's05', box('s05', 'toast'), pad=0, kind='toast')

# Step 3: the earnings cards and the stake row as fees arrive.
for i, key in enumerate(['s06', 's07-earning-1', 's07-earning-2', 's07-earning-3']):
    cut(f'earn{i}', key, box(key, 'earn'), targets={'claimable': 'claimable', 'earned': 'earned', 'staked': 'staked'})
    cut(f'mine{i}', key, box(key, 'mine'), targets={'row': 'mineRow'})

# Step 4: the portfolio, claim, withdraw.
for i, key in enumerate(['s08', 's10', 's11', 's12', 's14']):
    cut(f'pstats{i}', key, box(key, 'stats'), targets={'net': 'net', 'fees': 'fees'})
    t = {'claim': 'claim', 'withdraw': 'withdraw', 'compound': 'compound', 'row': 'mineRow'}
    if key in ('s11', 's12'):
        t.update({'all': 'all', 'go': 'go', 'wd': 'wd'})
    cut(f'pmine{i}', key, box(key, 'mine'), targets=t)
cut('toastClaim', 's09', box('s09', 'toast'), pad=0, kind='toast')
cut('toastWithdraw', 's13', box('s13', 'toast'), pad=0, kind='toast')
a = box('s14', 'activity')
cut('activity', 's14', {'x': a['x'] - 24, 'y': a['y'] - 62, 'w': a['w'] + 48, 'h': a['h'] + 86})

out['_chain'] = m['chain']
# Fees earned as the page printed them at each checkpoint, and the volume
# traded up to each one.
import re
earned = ['$0.00']
for key in ('s07-earning-1', 's07-earning-2', 's07-earning-3'):
    mm = re.search(r'Fees earned (\$[\d.,]+)', shot(key)['note'])
    if not mm:
        raise SystemExit(f'no Fees earned figure in {key}: {shot(key)["note"]}')
    earned.append(mm.group(1))
out['_earned'] = earned
vols, total = [], 0
for tr in m['chain']['trading']:
    total += tr['volumeUsd']
    vols.append(total)
out['_volumes'] = vols
wd = re.search(r'Withdraw ETH / USDG ([\d.,]+) ETH \+ ([\d.,]+) USDG', shot('s14')['note'])
if not wd:
    raise SystemExit(f'no withdrawal in the activity list: {shot("s14")["note"]}')
out['_withdrawn'] = [wd.group(1), wd.group(2)]
print('withdrawn', out['_withdrawn'])
print('earned', earned, 'volumes', vols)
json.dump(out, open(os.path.join(COMP, 'frags.json'), 'w'), indent=1)
for k, f in out.items():
    if not k.startswith('_'):
        print(f"{k:14s} {f['w']}x{f['h']}  {f['shot']:22s} {' '.join(f['targets'])}")
