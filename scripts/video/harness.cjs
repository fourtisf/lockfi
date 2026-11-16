// Shared browser harness: every chain request the page makes goes to the fork,
// and an injected EIP-6963 wallet signs there as ME. Nothing reaches mainnet.
const { chromium } = require('playwright');
const RPC = 'https://rpc.mainnet.chain.robinhood.com/';

async function open({ me, width = 1440, height = 900, scale = 2 }) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'light' });
  await ctx.route('https://rpc.mainnet.chain.robinhood.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const r = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
    route.fulfill({ status: r.status, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
  });
  // Logos from third-party hosts are not reachable from here; answer them empty
  // quickly instead of letting them hang the page.
  // The WETH badge's logo lives on CoinGecko, which this sandbox cannot reach:
  // stand in a plain ETH diamond so the badge is not a broken image.
  const ethLogo = require('fs').readFileSync(require('path').join(__dirname, 'eth-logo.png'));
  await ctx.route(/^https:\/\/(?!rpc\.mainnet\.chain\.robinhood\.com)/, (route) =>
    /coingecko\.com\/coins\/images\/102174283/.test(route.request().url())
      ? route.fulfill({ status: 200, contentType: 'image/png', body: ethLogo })
      : route.fulfill({ status: 404, body: '' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(({ address, rpc }) => {
    const state = { accounts: [] };
    const listeners = {};
    const emit = (e, d) => (listeners[e] ?? []).forEach((f) => f(d));
    let id = 0;
    const forward = async (method, params) => {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
      return j.result;
    };
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_accounts') return state.accounts;
        if (method === 'eth_requestAccounts') { state.accounts = [address]; emit('accountsChanged', state.accounts); return state.accounts; }
        if (method === 'wallet_requestPermissions') { state.accounts = [address]; return [{ parentCapability: 'eth_accounts' }]; }
        if (method === 'wallet_revokePermissions') { state.accounts = []; return null; }
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        return forward(method, params);
      },
      on(e, f) { (listeners[e] ??= []).push(f); },
      removeListener(e, f) { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
    };
    const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0B6E86"/><path d="M7 19c3-3 6 3 9 0s6 3 9 0" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>');
    const detail = Object.freeze({ info: { uuid: '6f1b0d1e-0000-4000-8000-0000000000f1', name: 'Browser Wallet', icon, rdns: 'dev.tidewell.demo' }, provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, { address: me, rpc: RPC });

  const toasts = [];
  await page.exposeFunction('__toast', (t) => toasts.push(t));
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const t = document.querySelector('.toast')?.textContent?.trim();
      if (t && t !== window.__lastToast) { window.__lastToast = t; window.__toast(t); }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const until = async (label, timeout = 90_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = toasts.find((t) => t.startsWith(label) && t.includes('— confirmed'));
      if (hit) return { ok: true, text: hit };
      const bad = toasts.find((t) => t.startsWith(label) && !/ — (confirm in your wallet|sent, waiting for confirmation|confirmed)/.test(t));
      if (bad) return { ok: false, text: bad };
      await page.waitForTimeout(150);
    }
    return { ok: false, text: `timeout; toasts: ${toasts.slice(-4).join(' || ')}` };
  };
  return { browser, ctx, page, errors, toasts, until };
}

module.exports = { open };
