/**
 * LockFi's introduction banners for X, drawn in the site's own design.
 *
 *   node scripts/build-lockfi-social.mjs          (npm run brand:social)
 *   node scripts/build-lockfi-social.mjs 03 05    (only those)
 *
 * Writes brand/lockfi/social/*.png at 2×: six 1600 × 900 posts and the
 * 1500 × 500 profile header. Every colour is a token from app/globals.css,
 * the face is Instrument Sans (fetched by `npm run brand:lockfi` into
 * brand/lockfi/.fonts), and the logo is the pin arch on the black tile.
 *
 * The site's rules apply to a banner as much as to a row (§7, §19): no figure
 * a reader could take as a yield, never "APY", no handle written on an image,
 * and no contract address until it is announced ("CA · coming soon"). The visuals are the site's components with
 * their numbers left out: a board, a bin chart, a position row.
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'brand', 'lockfi', 'social');
const FONT_FILE = join(ROOT, 'brand', 'lockfi', '.fonts', 'InstrumentSans.ttf');
if (!existsSync(FONT_FILE)) {
  throw new Error('Instrument Sans is missing: run `npm run brand:lockfi` once first, it fetches the face.');
}
mkdirSync(join(OUT, 'router'), { recursive: true });
const only = process.argv.slice(2);

// ── Tokens, from app/globals.css ─────────────────────────────────────────────
const T = {
  bg: '#0A0B0D',
  panel: '#111215',
  panel2: '#16171B',
  raise: '#1B1D22',
  fg: '#EDEEF1',
  fg2: '#9A9EA8',
  fg3: '#6B6F7A',
  ac: '#3B82F6',
  acFill: '#2563EB',
  ac3: '#93C5FD',
  pos: '#1FCB7A',
  red: '#F2495C',
};

// ── The mark: components/shell/Logo.tsx, on its 64 grid ──────────────────────
const SHACKLE = 'M23 53.5V22.5a9 9 0 0 1 18 0v31';
const PINS = [
  [9.75, 41.5, 12],
  [28.75, 32.5, 21],
  [47.75, 41.5, 12],
];
const mark = (color) =>
  `<svg viewBox="0 0 64 64"><path d="${SHACKLE}" fill="none" stroke="${color}" stroke-width="6.5"/>` +
  PINS.map(([x, y, h]) => `<rect x="${x}" y="${y}" width="6.5" height="${h}" rx="1.5" fill="${color}"/>`).join('') +
  `</svg>`;

// ── Pieces ───────────────────────────────────────────────────────────────────
const tile = (px) => `<span class="tile" style="width:${px}px;height:${px}px;border-radius:${px * 0.24}px">${mark(T.fg)}</span>`;
const brand = (px = 44) => `<span class="brand">${tile(px)}<b style="font-size:${px * 0.72}px">LockFi</b></span>`;

/** The shapes the builder draws (lib/shapes.ts), normalised to a peak of 1. */
function weights(shape, n) {
  const w = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    if (shape === 'spot') w.push(1);
    else if (shape === 'curve') w.push(Math.exp(-4 * x * x));
    else w.push(0.15 + x * x);
  }
  const max = Math.max(...w);
  return w.map((v) => v / max);
}

/**
 * A bin chart: the quote side left of the price in the soft tint, the token
 * side right of it in the accent, the price as an ink line — the builder's
 * legend (§12), without an axis or a figure.
 */
function binChart(shape, { n = 25, height = 300, gap = 6, price = true, fade = false } = {}) {
  const mid = Math.floor(n / 2);
  const bars = weights(shape, n)
    .map((v, i) => {
      const cls = i < mid ? 'q' : i === mid ? 'm' : 't';
      return `<i class="${cls}" style="height:${Math.max(6, v * height * 0.86)}px"></i>`;
    })
    .join('');
  return `<div class="bins${fade ? ' fade' : ''}" style="height:${height}px;gap:${gap}px">${bars}${
    price ? `<span class="price"><em>price</em></span>` : ''
  }</div>`;
}

const spark = (up, w = 150, h = 40) => {
  const pts = [];
  let y = up ? 0.7 : 0.3;
  for (let i = 0; i <= 14; i++) {
    const wobble = Math.sin(i * 1.7 + (up ? 0 : 2)) * 0.12;
    const trend = (up ? -0.045 : 0.04) * i;
    pts.push(`${(i / 14) * w},${Math.min(0.95, Math.max(0.05, y + trend + wobble)) * h}`);
  }
  const c = up ? T.pos : T.red;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
};

/** A coin in the site's token-mark style (lib/token-mark.ts): dark disc, lit. */
const coin = (hue, px = 34) =>
  `<span class="coin" style="width:${px}px;height:${px}px;background-color:hsl(${hue} 40% 20%);--ink:hsl(${hue} 70% 80%)"></span>`;

/** A figure the banner deliberately does not state: a bar where the digits go. */
const ghost = (w, strong = false) => `<span class="ghost${strong ? ' s' : ''}" style="width:${w}px"></span>`;

const CHECK = `<svg viewBox="0 0 20 20" width="22" height="22"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="${T.ac3}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ── The frame every post shares ──────────────────────────────────────────────
function post({ n, of, eyebrow, title, lede, visual, layout = 'split' }) {
  return `<div class="art post ${layout}" data-w="1600" data-h="900">
  <div class="grid"></div><div class="glow"></div>
  <header>${brand()}<span class="count">${String(n).padStart(2, '0')} <i>/</i> ${String(of).padStart(2, '0')}</span></header>
  <main>
    <section class="copy">
      <span class="eyebrow"><i></i>${eyebrow}</span>
      <h1>${title}</h1>
      <p>${lede}</p>
    </section>
    <section class="visual">${visual}</section>
  </main>
  <footer><b>lockfi.org</b><span>Built on Uniswap <i>·</i> Robinhood Chain</span></footer>
</div>`;
}

// ── The posts ────────────────────────────────────────────────────────────────
const OF = 6;
const POSTS = {
  '01-introduction': post({
    n: 1,
    of: OF,
    eyebrow: 'Introducing LockFi',
    title: `Earn real swap fees<br>on <span class="ac">Robinhood Chain.</span>`,
    lede: 'Provide liquidity to the markets that trade, and collect a share of every swap. Positions are minted by Uniswap straight to your wallet.',
    visual: `<div class="panel chart">
      <div class="ph"><span class="lbl">Your position</span><span class="chips"><span class="chip on">Curve</span><span class="chip">Spot</span><span class="chip">Bid-ask</span></span></div>
      ${binChart('curve', { n: 27, height: 360 })}
      <div class="legend"><span><i class="q"></i>ETH side</span><span><i class="t"></i>Token side</span><span><i class="p"></i>Current price</span></div>
    </div>`,
  }),

  '02-pools': post({
    n: 2,
    of: OF,
    eyebrow: 'Pools',
    layout: 'split wide',
    title: `Every market,<br><span class="ac">read from the chain.</span>`,
    lede: 'A live board of Robinhood Chain’s pools: price, volume, buys and sells, liquidity. Numbers come from on-chain swaps, labelled with where they came from.',
    visual: `<div class="panel board">
      <div class="ph"><span class="lbl">Pools</span><span class="chips"><span class="chip on">Market cap</span><span class="chip">Volume</span><span class="chip">Fee yield</span></span></div>
      <div class="cols"><span>#</span><span>Token</span><span>Price</span><span>Vol 24h</span><span>24h</span><span>Liquidity</span><span>7d</span></div>
      ${[
        [212, true, 1],
        [28, true, 0],
        [150, false, 0],
        [265, true, 0],
        [95, false, 0],
        [330, true, 0],
      ]
        .map(
          ([hue, up, lead], i) => `<div class="row${lead ? ' lead' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="tok">${coin(hue)}<span class="nm">${ghost(64 + ((i * 23) % 40), true)}${ghost(46)}</span></span>
        <span>${ghost(58 + ((i * 17) % 30))}</span>
        <span>${ghost(64 + ((i * 29) % 34))}</span>
        <span class="pill ${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${ghost(30)}</span>
        <span>${ghost(60 + ((i * 11) % 30))}</span>
        <span>${spark(up, 110, 30)}</span>
      </div>`,
        )
        .join('')}
      <div class="float">
        <b>Stake full range</b>
        <span><em>Custody</em>your wallet, as an NFT</span>
        <span><em>LockFi fee</em>none</span>
        <span><em>Lockup</em>none</span>
        <span class="btn">Stake</span>
      </div>
    </div>`,
  }),

  '03-shapes': post({
    n: 3,
    of: OF,
    eyebrow: 'Positions',
    title: `Shape where your<br>liquidity <span class="ac">sits.</span>`,
    lede: 'Only liquidity at the current price earns a fee. Curve piles it there, spot spreads it evenly, bid-ask ladders it at the edges. Pick a range, pick a shape, mint.',
    layout: 'stack',
    visual: `<div class="shapes">
      ${[
        ['spot', 'Spot', 'Even across the range'],
        ['curve', 'Curve', 'Most at the price, where fees are paid'],
        ['bidask', 'Bid-ask', 'Most at the edges, like a ladder of orders'],
      ]
        .map(
          ([s, name, hint]) => `<div class="panel shape${s === 'curve' ? ' on' : ''}">
        <div class="ph"><span class="lbl">${name}</span>${s === 'curve' ? '<span class="chip on">Selected</span>' : ''}</div>
        ${binChart(s, { n: 17, height: 190, gap: 5 })}
        <p>${hint}</p>
      </div>`,
        )
        .join('')}
    </div>`,
  }),

  '04-one-token': post({
    n: 4,
    of: OF,
    eyebrow: 'One token in',
    title: `Deposit what you hold.<br><span class="ac">Uniswap does the rest.</span>`,
    lede: 'Hold only ETH? LockFi swaps the right part of it through Uniswap, then mints the position. Every transaction is simulated before your wallet asks you to sign.',
    visual: `<div class="flow">
      <div class="panel step"><span class="no">You</span><b>Deposit ETH</b><span>From your wallet, in one field</span></div>
      <i class="link"></i>
      <div class="panel step"><span class="no">1</span><b>Swap through Uniswap</b><span>Part of it, for the token side, in the same pool</span></div>
      <i class="link"></i>
      <div class="panel step"><span class="no">2</span><b>Mint the position</b><span>Uniswap’s PositionManager, sized to what you now hold</span></div>
      <i class="link"></i>
      <div class="panel step on"><span class="no">${CHECK}</span><b>Position NFT in your wallet</b><span>Nothing held by LockFi, at any step</span></div>
    </div>`,
  }),

  '05-custody': post({
    n: 5,
    of: OF,
    eyebrow: 'Your wallet',
    title: `Your position.<br>Your wallet.<br><span class="ac">Withdraw any time.</span>`,
    lede: 'Each position is a Uniswap NFT minted straight to you. No vault, no lockup, no admin key. Collect fees or close it whenever you like, from LockFi or from Uniswap.',
    visual: `<div class="custody">
      <div class="panel nft">
        <div class="nft-art">${binChart('curve', { n: 11, height: 150, gap: 5, price: false })}</div>
        <b>Uniswap position</b>
        <span>ERC-721 · held by your wallet</span>
      </div>
      <div class="panel pos">
        <div class="ph">${coin(212, 40)}<span class="nm">${ghost(90, true)}${ghost(60)}</span><span class="status">In range</span></div>
        <div class="range"><span class="band"></span><span class="now"></span></div>
        <div class="kv"><span>Range</span><b>Full range</b></div>
        <div class="kv"><span>Held by</span><b>Your wallet</b></div>
        <div class="kv"><span>Lockup</span><b>None</b></div>
        <div class="btns"><span class="btn ghostbtn">Collect fees</span><span class="btn">Withdraw</span></div>
      </div>
    </div>`,
  }),

  '06-honest': post({
    n: 6,
    of: OF,
    eyebrow: 'Honest numbers',
    title: `Real fees.<br><span class="ac">Nothing printed.</span>`,
    lede: 'What a position earns is what traders paid the pool. When volume slows, so do fees, and LockFi shows it.',
    visual: `<div class="facts">
      ${[
        ['No emissions', 'Rewards are swap fees, never a token printed to pay them.'],
        ['No custody', 'Your position is an NFT in your wallet. LockFi holds nothing.'],
        ['No LockFi fee', 'Every fee your position earns is yours.'],
        ['CA · coming soon', 'Our contract address appears on lockfi.org first. Any address before that is not ours.'],
      ]
        .map(([h, p]) => `<div class="panel fact"><span class="tick">${CHECK}</span><b>${h}</b><p>${p}</p></div>`)
        .join('')}
    </div>`,
  }),
};


// ── The Router article (§51): four inline images and a cover ────────────────
// Same frame, same rules: no figure a reader could take as a return. The
// numbers that do appear are the contract's own parameters (the fee, its cap,
// the keeper's guards), which are facts about the code, not promises.
const LOCK = `<svg viewBox="0 0 24 24" width="20" height="20"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const ROUTER_OF = 4;

/** Pool depth drawn as stacked layers that only ever rise: each route adds one. */
function depthStack(layers = 5, { h = 300 } = {}) {
  const cols = weights('curve', 21)
    .map((v) => {
      const segs = [];
      for (let k = 0; k < layers; k++) {
        const share = (v * 0.82 + 0.18) / layers;
        segs.push(`<i style="height:${share * h * 0.9}px;opacity:${0.35 + (0.65 * (k + 1)) / layers}"></i>`);
      }
      return `<span class="dcol">${segs.reverse().join('')}</span>`;
    })
    .join('');
  return `<div class="depth" style="height:${h}px">${cols}</div>`;
}

const ROUTER = {
  'router/r1-introducing': post({
    n: 1,
    of: ROUTER_OF,
    eyebrow: 'LockFi Router',
    title: `Creator fees into<br><span class="ac">permanent liquidity.</span>`,
    lede: 'For token teams. Point your creator fees at a router and it adds them to your own pool on the schedule you choose, as liquidity no one can pull.',
    visual: `<div class="rflow">
      <div class="panel rnode"><span class="lbl">Creator fees</span><b>ETH</b><span>From your launchpad, or sent from your wallet</span></div>
      <i class="rlink"></i>
      <div class="panel rnode on"><span class="rtile">${tile(46)}</span><b>Your router</b><span>Swaps the right share, adds both sides</span></div>
      <i class="rlink"></i>
      <div class="panel rpool"><div class="ph"><span class="lbl">Your pool</span><span class="perm">${LOCK}Permanent</span></div>${depthStack(5, { h: 200 })}</div>
    </div>`,
  }),

  'router/r2-route': post({
    n: 2,
    of: ROUTER_OF,
    eyebrow: 'What one route does',
    title: `One transaction.<br><span class="ac">Four steps.</span>`,
    lede: 'The keeper sends a route on your schedule, or you send one yourself. Every step runs inside Uniswap’s own pool, and none of it can be undone.',
    visual: `<div class="flow">
      <div class="panel step"><span class="no">1</span><b>Take the LockFi fee</b><span>1% of the new ETH only, never of the pool’s earned fees</span></div>
      <i class="link"></i>
      <div class="panel step"><span class="no">2</span><b>Collect what it earned</b><span>Fees from liquidity already routed go back in</span></div>
      <i class="link"></i>
      <div class="panel step"><span class="no">3</span><b>Swap the right share</b><span>ETH for your token, in the same pool, above a minimum price</span></div>
      <i class="link"></i>
      <div class="panel step on"><span class="no">${LOCK}</span><b>Add both sides, for good</b><span>Owned by the router, which has no way to remove it</span></div>
    </div>`,
  }),

  'router/r3-guards': post({
    n: 3,
    of: ROUTER_OF,
    eyebrow: 'The guards',
    title: `Built so a route<br><span class="ac">can’t be gamed.</span>`,
    lede: 'A keeper call is a trade at a moment someone can see coming. So the router refuses a bad price rather than accept one.',
    visual: `<div class="facts">
      ${[
        ['30-minute average', 'The keeper routes only when the price is within 3% of its own 30-minute average. A pushed price waits.'],
        ['Minimum price', 'Every swap carries a floor 1% under Uniswap’s own quote. Below it the route reverts and nothing moves.'],
        ['Fee fixed at deploy', '1%, capped at 2% in the factory, with no setter. Nobody can raise it later.'],
        ['Keeper only triggers', 'The keeper never holds funds. It sends the route; the ETH goes into your pool and nowhere else.'],
      ]
        .map(([h, p]) => `<div class="panel fact"><span class="tick">${CHECK}</span><b>${h}</b><p>${p}</p></div>`)
        .join('')}
    </div>`,
  }),

  'router/r4-your-token': post({
    n: 4,
    of: ROUTER_OF,
    eyebrow: 'Set up in a minute',
    title: `Connect the wallet<br>you launched from.<br><span class="ac">Your token is there.</span>`,
    lede: 'LockFi finds the tokens your wallet created, launches on Pons included, and checks each one on chain. Pick one, pick a schedule, create.',
    visual: `<div class="panel rsetup">
      <div class="ph"><span class="lbl">Tokens you created</span></div>
      ${[
        [212, true],
        [28, false],
      ]
        .map(
          ([hue, on]) =>
            `<div class="rtok${on ? ' on' : ''}">${coin(hue, 40)}<span class="nm">${ghost(80, true)}${ghost(120)}</span><span class="mine">You created this</span></div>`,
        )
        .join('')}
      <div class="rfield"><span class="lbl">Schedule</span><span class="chips"><span class="chip">6h</span><span class="chip">12h</span><span class="chip on">24h</span><span class="chip">Weekly</span></span></div>
      <div class="rfield"><span class="lbl">Range</span><span class="chips"><span class="chip on">Full range</span><span class="chip">±20%</span></span></div>
      <span class="btn">Create router</span>
    </div>`,
  }),
};

const ROUTER_COVER = `<div class="art cover" data-w="1500" data-h="600">
  <div class="grid"></div><div class="glow"></div>
  <div class="cv-copy">
    ${brand(52)}
    <span class="eyebrow"><i></i>Introducing LockFi Router</span>
    <h1>Creator fees into<br><span class="ac">permanent liquidity.</span></h1>
    <p>For token teams <i>·</i> on your schedule <i>·</i> no one can pull it</p>
  </div>
  <div class="panel cv-chart"><div class="ph"><span class="lbl">Your pool</span><span class="perm">${LOCK}Permanent</span></div>${depthStack(5, { h: 250 })}</div>
  <span class="cv-url">lockfi.org/router</span>
</div>`;

const HEADER = `<div class="art header" data-w="1500" data-h="500">
  <div class="grid"></div><div class="glow"></div>
  <div class="hd-chart">${binChart('curve', { n: 27, height: 330, gap: 7, price: true, fade: true })}</div>
  <div class="hd-copy">
    ${brand(84)}
    <h1>Real swap fees on<br><span class="ac">Robinhood Chain.</span></h1>
    <p>Liquidity through Uniswap <i>·</i> minted to your wallet <i>·</i> lockfi.org</p>
  </div>
</div>`;

/**
 * The cover for an X Article: 5:2, the ratio X recommends (1500 × 600).
 * X shows it cropped slightly in the feed, so everything that matters sits
 * inside a centred safe area.
 */
const ARTICLE_COVER = `<div class="art cover" data-w="1500" data-h="600">
  <div class="grid"></div><div class="glow"></div>
  <div class="cv-copy">
    ${brand(52)}
    <span class="eyebrow"><i></i>Introducing LockFi</span>
    <h1>Real swap fees on<br><span class="ac">Robinhood Chain.</span></h1>
    <p>Liquidity through Uniswap <i>·</i> minted to your wallet <i>·</i> no emissions</p>
  </div>
  <div class="panel cv-chart">
    <div class="ph"><span class="lbl">Your position</span><span class="chips"><span class="chip on">Curve</span><span class="chip">Spot</span><span class="chip">Bid-ask</span></span></div>
    ${binChart('curve', { n: 23, height: 250, gap: 6 })}
  </div>
  <span class="cv-url">lockfi.org</span>
</div>`;

// ── Styles ───────────────────────────────────────────────────────────────────
const CSS = `
@font-face{font-family:'Instrument Sans';src:url(data:font/ttf;base64,${readFileSync(FONT_FILE).toString('base64')}) format('truetype');font-weight:400 700;font-stretch:75% 100%}
*{box-sizing:border-box}
html,body{margin:0;background:${T.bg}}
.art{position:relative;overflow:hidden;background:${T.bg};color:${T.fg};font-family:'Instrument Sans',sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.post{width:1600px;height:900px;padding:64px 88px 56px;display:flex;flex-direction:column}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);background-size:64px 64px;
  -webkit-mask-image:radial-gradient(ellipse 75% 70% at 70% 40%,#000 20%,transparent 75%)}
.glow{position:absolute;right:-200px;top:-320px;width:1200px;height:900px;background:radial-gradient(closest-side,rgba(59,130,246,.20),transparent);pointer-events:none}
header,main,footer{position:relative}
header{display:flex;align-items:center;justify-content:space-between}
.brand{display:inline-flex;align-items:center;gap:16px}
.brand b{font-weight:700;letter-spacing:-.04em;line-height:1}
.tile{display:grid;place-items:center;flex:none;background:linear-gradient(160deg,#2A2C33 0%,#0D0E11 55%,#030304 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.12),0 14px 34px -14px rgba(0,0,0,.95)}
.tile svg{width:74%;height:74%;display:block}
.count{font-size:18px;font-weight:600;color:${T.fg3};letter-spacing:.08em}
.count i{font-style:normal;color:${T.fg3};opacity:.6;margin:0 4px}
main{flex:1;display:grid;grid-template-columns:700px minmax(0,1fr);gap:64px;align-items:center}
.wide main{grid-template-columns:540px minmax(0,1fr);gap:56px}
.wide h1{font-size:64px}
.stack main{grid-template-columns:1fr;grid-template-rows:auto 1fr;gap:40px;align-items:start;padding-top:36px}
.stack .copy{display:grid;grid-template-columns:1fr 520px;column-gap:72px;align-items:end}
.stack .copy .eyebrow{grid-column:1/-1;justify-self:start}
.stack .copy p{margin:0 0 10px}
.eyebrow{display:inline-flex;align-items:center;gap:10px;height:36px;padding:0 16px;border-radius:99px;background:rgba(59,130,246,.10);border:1px solid rgba(59,130,246,.28);
  color:${T.ac3};font-size:14px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;margin-bottom:28px}
.eyebrow i{width:7px;height:7px;border-radius:50%;background:${T.ac};box-shadow:0 0 12px ${T.ac}}
h1{margin:0;font-size:70px;line-height:1.02;letter-spacing:-.045em;font-weight:700}
.ac{color:${T.ac3}}
.copy p{text-wrap:pretty;margin:30px 0 0;font-size:25px;line-height:1.42;color:${T.fg2};font-weight:500;max-width:600px}
footer{display:flex;justify-content:space-between;align-items:center;padding-top:26px;border-top:1px solid rgba(255,255,255,.07);font-size:19px;color:${T.fg3};font-weight:500}
footer b{color:${T.fg};font-weight:700;font-size:22px;letter-spacing:-.01em}
footer i{font-style:normal;margin:0 8px;opacity:.6}

.panel{position:relative;background:linear-gradient(180deg,${T.panel2},${T.panel} 40%);border:1px solid rgba(255,255,255,.07);border-radius:16px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 40px 80px -40px rgba(0,0,0,.9)}
.ph{display:flex;align-items:center;justify-content:space-between;gap:14px}
.lbl{font-size:13px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:${T.fg3}}
.chips{display:flex;gap:6px;padding:4px;border-radius:10px;background:${T.raise}}
.chip{font-size:15px;font-weight:600;padding:7px 14px;border-radius:7px;color:${T.fg3}}
.chip.on{background:rgba(59,130,246,.16);color:${T.ac3};box-shadow:inset 0 0 0 1px rgba(59,130,246,.35)}

.bins{position:relative;display:flex;align-items:flex-end;padding:0 4px;border-bottom:1px solid rgba(255,255,255,.08)}
.bins i{flex:1;border-radius:4px 4px 1px 1px}
.bins i.q{background:linear-gradient(180deg,rgba(237,238,241,.30),rgba(237,238,241,.12))}
.bins i.t,.bins i.m{background:linear-gradient(180deg,${T.ac} 0%,rgba(59,130,246,.55) 100%);box-shadow:0 0 24px -6px rgba(59,130,246,.6)}
.bins .price{position:absolute;left:50%;top:-6px;bottom:-1px;width:0;border-left:2px dashed rgba(237,238,241,.8)}
.bins .price em{position:absolute;top:-30px;left:50%;transform:translateX(-50%);font-style:normal;font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
  color:${T.bg};background:${T.fg};padding:3px 8px;border-radius:5px}
.bins.fade{-webkit-mask-image:linear-gradient(90deg,transparent,#000 30%,#000 80%,transparent)}

.chart{padding:30px 32px 26px}
.chart .bins{margin:62px 0 22px}
.legend{display:flex;gap:26px;font-size:16px;color:${T.fg2};font-weight:500}
.legend span{display:inline-flex;align-items:center;gap:9px}
.legend i{width:12px;height:12px;border-radius:3px}
.legend i.q{background:rgba(237,238,241,.28)}
.legend i.t{background:${T.ac}}
.legend i.p{width:2px;height:14px;border-radius:0;border-left:2px dashed ${T.fg}}

.board{padding:24px 0 10px}
.board .ph{padding:0 26px 18px}
.cols,.row{display:grid;grid-template-columns:40px 1.9fr 1fr 1fr 0.9fr 1fr 118px;align-items:center;gap:14px;padding:0 26px}
.cols{height:40px;border-top:1px solid rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.06);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${T.fg3}}
.row{height:62px;border-bottom:1px solid rgba(255,255,255,.045);position:relative}
.row:last-of-type{border-bottom:0}
.row.lead{background:linear-gradient(90deg,rgba(59,130,246,.10),transparent 70%)}
.row.lead::before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:${T.ac}}
.rank{font-size:17px;font-weight:600;color:${T.fg3}}
.tok{display:flex;align-items:center;gap:12px}
.nm{display:flex;flex-direction:column;gap:7px}
.coin{display:inline-block;flex:none;border-radius:50%;position:relative;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 -6px 12px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06)}
.coin::after{content:'';position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 35% 28%,var(--ink) 0,transparent 55%);opacity:.35}
.ghost{display:block;height:9px;border-radius:5px;background:rgba(237,238,241,.10)}
.ghost.s{height:11px;background:rgba(237,238,241,.30)}
.pill{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 10px;border-radius:7px;font-size:12px;width:max-content}
.pill.up{background:rgba(31,203,122,.12);color:${T.pos}}
.pill.up .ghost{background:rgba(31,203,122,.45)}
.pill.down{background:rgba(242,73,92,.12);color:${T.red}}
.pill.down .ghost{background:rgba(242,73,92,.45)}
.float{position:absolute;right:-20px;bottom:-54px;width:318px;padding:22px 24px;border-radius:16px;background:rgba(22,23,27,.92);backdrop-filter:blur(14px);
  border:1px solid rgba(59,130,246,.30);box-shadow:0 30px 70px -20px rgba(0,0,0,.95),0 0 0 6px rgba(59,130,246,.05);display:flex;flex-direction:column;gap:10px}
.float b{font-size:20px;letter-spacing:-.02em;margin-bottom:4px}
.float span{display:flex;justify-content:space-between;font-size:15px;color:${T.fg};font-weight:600}
.float .btn{justify-content:center}
.float em{font-style:normal;color:${T.fg3};font-weight:500}
.btn{display:inline-flex;justify-content:center;align-items:center;height:46px;border-radius:10px;background:${T.acFill};color:#fff !important;font-size:17px;font-weight:700;margin-top:8px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 26px -10px rgba(37,99,235,.9)}

.shapes{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}
.shape{padding:24px 26px 22px}
.shape .bins{margin:54px 0 18px}
.shape p{margin:0;font-size:18px;color:${T.fg2};font-weight:500;line-height:1.35}
.shape .ph .lbl{font-size:20px;letter-spacing:-.01em;text-transform:none;color:${T.fg};font-weight:700}
.shape.on{border-color:rgba(59,130,246,.45);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 0 0 6px rgba(59,130,246,.06),0 40px 80px -40px rgba(0,0,0,.9)}
.shape .chip{font-size:13px;padding:5px 10px}

.flow{display:flex;flex-direction:column;align-items:stretch}
.step{display:grid;grid-template-columns:64px 1fr;grid-template-rows:auto auto;column-gap:18px;row-gap:4px;padding:20px 26px;align-items:center}
.step .no{grid-row:1/3;width:52px;height:52px;border-radius:12px;display:grid;place-items:center;background:${T.raise};border:1px solid rgba(255,255,255,.08);font-size:18px;font-weight:700;color:${T.fg2}}
.step b{font-size:23px;letter-spacing:-.02em}
.step span:last-child{font-size:17px;color:${T.fg2};font-weight:500}
.step.on{border-color:rgba(59,130,246,.45);background:linear-gradient(180deg,rgba(59,130,246,.12),${T.panel} 70%)}
.step.on .no{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.4)}
.link{display:block;width:2px;height:22px;margin-left:51px;background:linear-gradient(${T.ac},rgba(59,130,246,.2))}

.custody{position:relative;height:560px}
.nft{position:absolute;left:6px;top:20px;width:270px;padding:18px 18px 24px;transform:rotate(-4deg);display:flex;flex-direction:column;gap:6px}
.nft-art{height:220px;border-radius:12px;margin-bottom:14px;padding:40px 22px 0;display:flex;align-items:flex-end;
  background:radial-gradient(120% 90% at 50% 0%,rgba(59,130,246,.35),transparent 60%),linear-gradient(160deg,#1A1C22,#07080A);border:1px solid rgba(255,255,255,.08)}
.nft-art .bins{flex:1;border:0}
.nft b{font-size:21px;letter-spacing:-.02em}
.nft span{font-size:15px;color:${T.fg3};font-weight:500}
.pos{position:absolute;right:0;top:140px;width:400px;padding:26px 28px}
.pos .ph{justify-content:flex-start}
.pos .status{margin-left:auto;font-size:14px;font-weight:700;color:${T.pos};background:rgba(31,203,122,.12);padding:6px 12px;border-radius:99px}
.range{position:relative;height:10px;border-radius:5px;background:${T.raise};margin:28px 0 22px}
.range .band{position:absolute;left:0;right:0;top:0;bottom:0;border-radius:5px;background:linear-gradient(90deg,rgba(59,130,246,.25),${T.ac},rgba(59,130,246,.25))}
.range .now{position:absolute;left:58%;top:-7px;width:4px;height:24px;border-radius:2px;background:${T.fg};box-shadow:0 0 0 4px rgba(10,11,13,.8)}
.kv{display:flex;justify-content:space-between;font-size:17px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.kv span{color:${T.fg3};font-weight:500}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.ghostbtn{background:${T.raise};box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);color:${T.fg} !important}

.facts{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.fact{padding:28px 28px 26px;min-height:220px}
.fact .tick{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);margin-bottom:22px}
.fact b{font-size:26px;letter-spacing:-.025em}
.fact p{margin:10px 0 0;font-size:18px;line-height:1.42;color:${T.fg2};font-weight:500}

.header{width:1500px;height:500px}
.cover{width:1500px;height:600px}
.cover .glow{right:-160px;top:-380px;width:1100px;height:900px}
.cover .grid{-webkit-mask-image:radial-gradient(ellipse 60% 80% at 75% 50%,#000 10%,transparent 75%)}
.cv-copy{position:absolute;left:96px;top:50%;transform:translateY(-50%);width:720px}
.cv-copy .brand{gap:16px}
.cv-copy .eyebrow{display:flex;width:max-content;margin:40px 0 22px}
.cv-copy h1{font-size:62px}
.cv-copy p{margin:24px 0 0;font-size:21px;color:${T.fg2};font-weight:500;white-space:nowrap}
.cv-copy p i{font-style:normal;margin:0 8px;opacity:.5}
.cv-chart{position:absolute;right:96px;top:50%;transform:translateY(-54%);width:540px;padding:24px 26px 20px}
.cv-chart .bins{margin-top:56px}
.cv-url{position:absolute;right:96px;bottom:44px;font-size:20px;font-weight:700;letter-spacing:-.01em;color:${T.fg}}
.header .glow{right:-120px;top:-420px;width:1100px;height:800px}
.header .grid{-webkit-mask-image:radial-gradient(ellipse 60% 80% at 75% 50%,#000 10%,transparent 75%)}
.hd-chart{position:absolute;right:60px;bottom:78px;width:500px}
.hd-copy{position:absolute;left:400px;top:84px;width:560px}
.hd-copy .brand{gap:24px}
.hd-copy h1{font-size:46px;margin-top:34px;letter-spacing:-.04em}
.hd-copy p{margin:18px 0 0;font-size:20px;white-space:nowrap;color:${T.fg2};font-weight:500}
.hd-copy p i{font-style:normal;margin:0 8px;opacity:.5}

.rflow{display:flex;flex-direction:column}
.rnode{display:grid;grid-template-columns:1fr;row-gap:4px;padding:20px 26px}
.rnode b{font-size:24px;letter-spacing:-.02em}
.rnode span:last-child{font-size:17px;color:${T.fg2};font-weight:500}
.rnode.on{grid-template-columns:62px 1fr;column-gap:16px;align-items:center;border-color:rgba(59,130,246,.45);background:linear-gradient(180deg,rgba(59,130,246,.12),${T.panel} 70%)}
.rnode.on .rtile{grid-row:1/3}
.rlink{display:block;width:2px;height:24px;margin-left:40px;background:linear-gradient(${T.ac},rgba(59,130,246,.2))}
.rpool{padding:20px 26px 22px}
.rpool .depth{margin-top:22px}
.perm{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:99px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.35);color:${T.ac3};font-size:14px;font-weight:700;letter-spacing:.04em}
.depth{display:flex;align-items:flex-end;gap:6px;border-bottom:1px solid rgba(255,255,255,.08)}
.dcol{flex:1;display:flex;flex-direction:column;gap:2px}
.dcol i{display:block;border-radius:3px;background:${T.ac}}
.cv-chart .depth{margin-top:34px}
.rsetup{padding:26px 28px;display:flex;flex-direction:column;gap:14px}
.rtok{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;background:${T.raise};border:1px solid rgba(255,255,255,.06)}
.rtok.on{border-color:rgba(59,130,246,.45);background:rgba(59,130,246,.08)}
.rtok .mine{margin-left:auto;font-size:14px;font-weight:700;color:${T.pos};background:rgba(31,203,122,.12);padding:6px 12px;border-radius:99px}
.rtok:not(.on) .mine{color:${T.fg3};background:rgba(237,238,241,.06)}
.rfield{display:flex;align-items:center;justify-content:space-between;padding-top:6px}
.rsetup .btn{margin-top:6px}
`;

// ── Rasterise ────────────────────────────────────────────────────────────────
const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => existsSync(p));
const browser = await chromium.launch(PREINSTALLED ? { executablePath: PREINSTALLED } : {});
const page = await browser.newPage({ deviceScaleFactor: 2 });

const jobs = { ...POSTS, 'x-header': HEADER, 'x-article-cover': ARTICLE_COVER, ...ROUTER, 'router/router-cover': ROUTER_COVER };
for (const [name, html] of Object.entries(jobs)) {
  // The Router article's images render only when asked for (`router`), so a
  // plain run keeps rewriting exactly the introduction set.
  if (only.length ? !only.some((o) => name.includes(o)) : name.startsWith('router/')) continue;
  const w = Number(/data-w="(\d+)"/.exec(html)[1]);
  const h = Number(/data-h="(\d+)"/.exec(html)[1]);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style>${html}`);
  await page.evaluate(() => document.fonts.ready);
  if (!(await page.evaluate(() => document.fonts.check('700 40px "Instrument Sans"')))) {
    throw new Error(`${name}: Instrument Sans did not load`);
  }
  // A banner whose content spills past its artboard is a banner cut off on X.
  const spill = await page.evaluate(() => {
    const art = document.querySelector('.art').getBoundingClientRect();
    return [...document.querySelectorAll('.art main, .art header, .art footer, .hd-copy, .cv-copy')]
      .filter((el) => el.scrollHeight > el.clientHeight + 1 || el.getBoundingClientRect().bottom > art.bottom + 1)
      .map((el) => el.className || el.tagName);
  });
  if (spill.length) console.warn(`  ${name}: overflows in ${spill.join(', ')}`);
  const out = join(OUT, `${name}.png`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
  console.log(`  brand/lockfi/social/${name}.png  ${w}×${h} @2x`);
}
await browser.close();
