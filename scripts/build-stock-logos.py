#!/usr/bin/env python3
"""
Company logos for Robinhood's stock tokens, served from our own origin.

    python3 scripts/build-stock-logos.py [--sheet path/to/review.png]

Why this exists. Robinhood brands every one of its stock tokens with the same
feather — its own CDN serves one identical file for AAPL, NVDA and SPCX — and
CoinGecko, GeckoTerminal and the explorer all copy it. So no logo source has
Apple's logo for the Apple token, and the boards showed a wall of feathers.

What it does:

1. Reads the OFFICIAL list from the chain: Robinhood's stock-token factory
   emits `Deployed(bytes32 indexed uid, address stock, string name,
   string symbol)` for every token it creates. That event is the registry. A
   token that is not in it is not Robinhood's, whatever it calls itself — this
   chain has an "SPCX … Robinhood Token" that the factory never made.
2. Fetches each company's logo by ticker from Financial Modeling Prep's public
   image endpoint (chosen over Parqet after comparing both: Parqet maps SPCX to
   an ETF issuer, FMP to SpaceX).
3. Lays each one out for a round badge — trimmed, fitted inside the circle
   whatever its aspect, on white (or on dark ink when the logo itself is
   white) — and writes `public/tokens/<SYMBOL>.png`. Served from our origin:
   no third-party host at runtime, and no visitor's address sent to one.
4. Writes those tokens into `config/tokens.json` by ADDRESS, keeping every
   hand-written entry. A curated logo always wins (logos.ts), so the feather
   from GeckoTerminal is replaced on the indexer's next pass.

A ticker FMP does not know keeps the feather: it is Robinhood's own logo for
the token, which is honest, and better than a guess.

Rerun it when Robinhood lists new stocks. Review the sheet before committing:
a ticker can name a different company on an exchange than on this chain.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont, ImageStat

ROOT = os.path.join(os.path.dirname(__file__), '..')
RPC_URL = os.environ.get('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com')
FACTORY = '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046'
# keccak256("Deployed(bytes32,address,string,string)")
DEPLOYED = '0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6'
CHUNK = 10_000_000  # the public RPC refuses a wider eth_getLogs range
LOGO_URL = 'https://financialmodelingprep.com/image-stock/{symbol}.png'
OUT_DIR = os.path.join(ROOT, 'public', 'tokens')
LIST = os.path.join(ROOT, 'config', 'tokens.json')
# Every token the factory made, logo or not: the indexer reads it to tell a
# Robinhood stock token from a copy wearing its name (logo-sources.ts).
REGISTRY = os.path.join(ROOT, 'config', 'robinhood-stocks.json')
SIZE = 128
UA = 'Mozilla/5.0 (compatible; tidewell-build)'

# Logos that failed review against the token's own name, 2026-11-14. Each
# keeps Robinhood's feather, which is at least the issuer's real mark.
EXCLUDE = {
    'FLY': 'FMP serves Fly Leasing, an earlier holder of the ticker; the token is Firefly Aerospace',
    'OKLO': "FMP serves AltC Acquisition's logo, the SPAC Oklo merged with",
    'RVI': 'FMP serves an unrelated image; the token is Robinhood Ventures Fund I',
    'TSEM': 'FMP serves a photograph of a building, not a logo',
}


def http(url: str, body: dict | None = None) -> bytes:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'user-agent': UA, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def rpc(method: str, params: list) -> object:
    reply = json.loads(http(RPC_URL, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}))
    if 'error' in reply:
        raise RuntimeError(f'{method}: {reply["error"]}')
    return reply['result']


def abi_string(data: bytes, offset: int) -> str:
    length = int.from_bytes(data[offset:offset + 32], 'big')
    return data[offset + 32:offset + 32 + length].decode('utf-8', 'replace')


def deployed_stocks() -> list[dict]:
    """Every Deployed event the factory emitted, oldest first."""
    head = int(rpc('eth_blockNumber', []), 16)
    found: dict[str, dict] = {}
    for start in range(0, head + 1, CHUNK):
        end = min(start + CHUNK - 1, head)
        logs = rpc('eth_getLogs', [{
            'address': FACTORY, 'topics': [DEPLOYED],
            'fromBlock': hex(start), 'toBlock': hex(end),
        }])
        for log in logs:
            data = bytes.fromhex(log['data'][2:])
            stock = '0x' + data[12:32].hex()
            name = abi_string(data, int.from_bytes(data[32:64], 'big'))
            symbol = abi_string(data, int.from_bytes(data[64:96], 'big'))
            found[stock] = {'address': stock, 'name': name, 'symbol': symbol, 'block': int(log['blockNumber'], 16)}
    return sorted(found.values(), key=lambda s: s['block'])


def safe_symbol(symbol: str) -> str | None:
    return symbol if re.fullmatch(r'[A-Za-z0-9_.-]{1,24}', symbol) else None


def badge(raw: bytes) -> Image.Image:
    """The logo trimmed and fitted inside a circle, on a ground it reads on."""
    im = Image.open(io.BytesIO(raw)).convert('RGBA')
    # Flatten onto white to find the ink, whether the source was transparent
    # or came on its own white square.
    flat = Image.new('RGBA', im.size, (255, 255, 255, 255))
    flat.alpha_composite(im)
    gray = flat.convert('L')
    ink = gray.point(lambda v: 255 if v < 245 else 0)
    alpha = im.getchannel('A').point(lambda v: 255 if v > 16 else 0)
    box = ink.getbbox() or alpha.getbbox() or (0, 0, im.width, im.height)
    # A logo drawn in white disappears on white: give it dark ground instead.
    solid = im.getchannel('A').point(lambda v: 255 if v > 200 else 0)
    light = solid.getbbox() is not None and ImageStat.Stat(im.convert('L'), mask=solid).mean[0] > 235
    if light:
        box = alpha.getbbox() or box
    logo = im.crop(box)
    # Fit the rectangle inside the circle: w² + h² ≤ (0.76·S)².
    w, h = logo.size
    scale = (0.76 * SIZE) / ((w * w + h * h) ** 0.5)
    logo = logo.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    ground = (18, 24, 28, 255) if light else (255, 255, 255, 255)
    out = Image.new('RGBA', (SIZE, SIZE), ground)
    out.alpha_composite(logo, ((SIZE - logo.width) // 2, (SIZE - logo.height) // 2))
    return out.convert('RGB')


def contact_sheet(rows: list[dict], path: str) -> None:
    cols, cell, label = 10, 96, 34
    lines = (len(rows) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell, lines * (cell + label)), (236, 242, 242))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for i, row in enumerate(rows):
        x, y = (i % cols) * cell, (i // cols) * (cell + label)
        mask = Image.new('L', (72, 72), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, 71, 71), fill=255)
        if row.get('file'):
            img = Image.open(row['file']).resize((72, 72), Image.LANCZOS)
            sheet.paste(img, (x + 12, y + 6), mask)
        else:
            draw.ellipse((x + 12, y + 6, x + 84, y + 78), outline=(200, 60, 50), width=2)
        draw.text((x + 4, y + 82), row['symbol'][:14], fill=(12, 30, 36), font=font)
        draw.text((x + 4, y + 96), row['name'].split(' • ')[0][:16], fill=(86, 108, 116), font=font)
    sheet.save(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--sheet', help='write a contact sheet of every logo here, for review')
    args = ap.parse_args()

    stocks = deployed_stocks()
    print(f'{len(stocks)} stock tokens in the factory\'s Deployed events')
    os.makedirs(OUT_DIR, exist_ok=True)

    made, missing = [], []
    for s in stocks:
        symbol = safe_symbol(s['symbol'])
        if not symbol:
            missing.append(s['symbol'])
            continue
        path = os.path.join(OUT_DIR, f'{symbol}.png')
        if symbol in EXCLUDE:
            if os.path.exists(path):
                os.remove(path)
            missing.append(f'{symbol} (excluded: {EXCLUDE[symbol]})')
            continue
        try:
            raw = http(LOGO_URL.format(symbol=symbol))
            badge(raw).save(path, optimize=True)
            made.append({**s, 'file': path, 'logoURI': f'/tokens/{symbol}.png'})
        except Exception:
            missing.append(symbol)
        time.sleep(0.15)

    # Keep every hand-written entry; replace the stock entries wholesale.
    with open(LIST) as fh:
        doc = json.load(fh)
    stock_addresses = {s['address'] for s in stocks}
    kept = [t for t in doc.get('tokens', []) if str(t.get('address', '')).lower() not in stock_addresses]
    doc['tokens'] = kept + [
        {'chainId': 4663, 'address': m['address'], 'symbol': m['symbol'], 'name': m['name'], 'logoURI': m['logoURI']}
        for m in made
    ]
    doc['timestamp'] = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    with open(LIST, 'w') as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    with open(REGISTRY, 'w') as fh:
        json.dump({
            'comment': 'Robinhood stock tokens, from the Deployed events of the factory below. '
                       'Generated by scripts/build-stock-logos.py; do not edit by hand.',
            'factory': FACTORY,
            'event': 'Deployed(bytes32 indexed uid, address stock, string name, string symbol)',
            'stocks': [{'address': s['address'], 'symbol': s['symbol'], 'name': s['name']} for s in stocks],
        }, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    print(f'{len(made)} logos written to public/tokens/, {len(kept)} hand-written entries kept')
    print(f'{len(stocks)} tokens in config/robinhood-stocks.json')
    if missing:
        print(f'{len(missing)} without a logo (they keep Robinhood\'s feather): {" ".join(missing)}')
    if args.sheet:
        contact_sheet(made + [{'symbol': m, 'name': '(no logo)'} for m in missing], args.sheet)
        print(f'review sheet: {args.sheet}')


if __name__ == '__main__':
    sys.exit(main())
