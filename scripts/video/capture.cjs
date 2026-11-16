// Records the stake flow through the REAL site on a fork of Robinhood Chain
// mainnet, as 2x full-page screenshots plus the page-space boxes of everything
// the video's camera and cursor point at. Writes <out>/shots/*.png and
// <out>/manifest.json.
//   node capture.cjs <out> <me>
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createPublicClient, http, erc20Abi, parseAbi } = require('viem');
const { open } = require('./harness.cjs');
const OUT = process.argv[2];
const ME = process.argv[3];
const fork = createPublicClient({ transport: http('http://127.0.0.1:8545') });
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const V05 = '0x901deabd094bd204cbe02854b1924e5ab4c41597';
const vaultAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function claimable(address) view returns (uint256,uint256)']);
const chain = async () => ({
  eth: Number(await fork.getBalance({ address: ME })) / 1e18,
  usdg: Number(await fork.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [ME] })) / 1e6,
  shares: String(await fork.readContract({ address: V05, abi: vaultAbi, functionName: 'balanceOf', args: [ME] })),
  claimable: (await fork.readContract({ address: V05, abi: vaultAbi, functionName: 'claimable', args: [ME] })).map(String),
});
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const manifest = { viewport: { width: 1440, height: 1960 }, scale: 2, shots: [], chain: {} };

(async () => {
  const { browser, page, errors, toasts, until } = await open({ me: ME, width: 1440, height: 1960, scale: 2 });
  const box = async (loc) => {
    const n = await loc.count();
    if (!n) return null;
    const b = await loc.first().boundingBox();
    if (!b) return null;
    const sy = await page.evaluate(() => scrollY);
    return { x: Math.round(b.x), y: Math.round(b.y + sy), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const shot = async (name, targets = {}, note = '') => {
    await page.waitForTimeout(250);
    const boxes = {};
    for (const [k, loc] of Object.entries(targets)) boxes[k] = await box(loc);
    const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    await page.screenshot({ path: `${OUT}/shots/${name}.png`, fullPage: true });
    manifest.shots.push({ name, file: `shots/${name}.png`, size, boxes, note });
    console.log(`shot ${name}  ${size.w}x${size.h}  ${Object.entries(boxes).map(([k, b]) => `${k}${b ? '' : '(missing)'}`).join(' ')}${note ? `  — ${note}` : ''}`);
  };
  const text = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, ' ').trim() : '');

  manifest.chain.start = await chain();
  await page.goto('http://127.0.0.1:3300/stakes', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const connect = page.locator('.top .wm > .btn');
  const panel = page.locator('.spanel');
  await shot('s01-stakes', { connect, panel, vaults: page.locator('.vlist'), vault1: page.locator('.vlist > *').first(), earn: page.locator('.card.earn') });

  await connect.click();
  await page.waitForTimeout(600);
  await shot('s02-wallet-pick', { item: page.locator('.wm-pop .wm-item', { hasText: 'Browser Wallet' }), pop: page.locator('.wm-pop') });
  await page.locator('.wm-pop .wm-item', { hasText: 'Browser Wallet' }).click();
  await page.waitForTimeout(5000);

  const route = (name) => panel.getByRole('group', { name: 'Deposit with' }).getByRole('button', { name, exact: true });
  const amount = panel.locator('#sp-amount');
  const stakeBtn = panel.getByRole('button', { name: /^Stake ETH \/ USDG/ });
  const row = (label) => panel.locator('div, li, tr').filter({ hasText: label }).last();
  const panelTargets = () => ({
    connect, panel, routeEth: route('ETH'), routeUsdg: route('USDG'), routeBoth: route('ETH + USDG'), amount, stake: stakeBtn,
    fee: row('Tidewell'), lockup: row('Lockup'), share: row('Your share of the vault'), weekly: row('Est. weekly fees'),
    yield: panel.locator('text=your fee yield').first(), steps: panel.locator('text=How you get paid').first(), audit: panel.locator('text=Not yet independently audited').first(),
    vault1: page.locator('.vlist > *').first(), earn: page.locator('.card.earn'),
  });
  await shot('s03-connected', panelTargets());

  await route('ETH').click();
  await amount.click();
  await amount.pressSequentially('1', { delay: 80 });
  await page.waitForTimeout(2500);
  await stakeBtn.hover();
  await page.waitForTimeout(400);
  await shot('s04-amount', panelTargets(), await text(panel.locator('[role=alert]')));

  toasts.length = 0;
  manifest.chain.beforeStake = await chain();
  await stakeBtn.click();
  const r1 = await until('Stake 1 ETH into ETH / USDG');
  await page.waitForTimeout(300);
  await shot('s05-stake-confirmed', { ...panelTargets(), toast: page.locator('.toast') }, r1.text);
  manifest.chain.afterStake = await chain();
  if (!r1.ok) throw new Error(`stake failed: ${r1.text}`);

  await page.waitForTimeout(17_000);
  const mine = page.locator('.mine');
  const mineRow = page.locator('.mine tbody tr').first();
  const earnTargets = () => ({ earn: page.locator('.card.earn'), claimable: page.locator('.card.earn > *').nth(0), earned: page.locator('.card.earn > *').nth(1), staked: page.locator('.card.earn > *').nth(2), mine, mineRow, panel });
  await shot('s06-staked', earnTargets(), await text(mineRow));

  // Trading: about a week of this pool's real volume, in three parts, with
  // the Stakes page read after each.
  const daily = Number(process.argv[4] ?? 2_480_000);
  const parts = [0.6, 1.8, 4.6];
  manifest.chain.trading = [];
  for (let i = 0; i < parts.length; i++) {
    const usd = Math.round(daily * parts[i]);
    console.log(`trading ~$${usd.toLocaleString('en-US')}…`);
    const out = execFileSync('node', [`${__dirname}/trade.mjs`, String(usd), '5'], { encoding: 'utf8' });
    console.log(out.trim().split('\n').pop());
    await page.waitForTimeout(17_000);
    const c = await chain();
    manifest.chain.trading.push({ volumeUsd: usd, ...c });
    await shot(`s07-earning-${i + 1}`, earnTargets(), `${await text(page.locator('.card.earn > *').nth(0))} | ${await text(page.locator('.card.earn > *').nth(1))}`);
  }

  // Portfolio.
  await page.locator('a[href="/portfolio"]').first().click();
  await page.waitForURL('**/portfolio');
  await page.waitForTimeout(9000);
  const prow = page.locator('.mine tbody tr').first();
  const portTargets = () => ({ stats: page.locator('.grid.g4'), net: page.locator('.grid.g4 > *').nth(0), fees: page.locator('.grid.g4 > *').nth(1), mine: page.locator('.mine').first(), mineRow: prow, claim: prow.getByRole('button', { name: /^Claim/ }), withdraw: prow.getByRole('button', { name: 'Withdraw', exact: true }), compound: prow.getByRole('button', { name: /^Compound/ }), activity: page.locator('.act-list') });
  await shot('s08-portfolio', portTargets(), await text(page.locator('.grid.g4')));

  toasts.length = 0;
  await prow.getByRole('button', { name: /^Claim/ }).click();
  const r2 = await until('Claim from ETH / USDG');
  await page.waitForTimeout(300);
  await shot('s09-claim-confirmed', { ...portTargets(), toast: page.locator('.toast') }, r2.text);
  manifest.chain.afterClaim = await chain();
  await page.waitForTimeout(16_000);
  await shot('s10-claimed', portTargets(), await text(page.locator('.grid.g4')));

  await prow.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await page.waitForTimeout(500);
  await shot('s11-withdraw-open', { ...portTargets(), wd: page.locator('.wd'), all: page.locator('.wd .quick button', { hasText: 'All' }) });
  await page.locator('.wd .quick button', { hasText: 'All' }).click();
  await page.waitForTimeout(800);
  const wdAll = page.locator('.wd').getByRole('button', { name: /^Withdraw all/ });
  await wdAll.hover();
  await shot('s12-withdraw-all', { ...portTargets(), wd: page.locator('.wd'), all: page.locator('.wd .quick button', { hasText: 'All' }), go: wdAll }, await text(page.locator('.wd')));
  toasts.length = 0;
  manifest.chain.beforeWithdraw = await chain();
  await wdAll.click();
  const r3 = await until('Withdraw from ETH / USDG');
  await page.waitForTimeout(300);
  await shot('s13-withdraw-confirmed', { ...portTargets(), toast: page.locator('.toast') }, r3.text);
  manifest.chain.afterWithdraw = await chain();
  await page.waitForTimeout(17_000);
  await shot('s14-after', portTargets(), await text(page.locator('.act-list')));

  manifest.errors = errors;
  fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest.chain, null, 1));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('CAPTURE ERROR', e); fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2)); process.exit(1); });
