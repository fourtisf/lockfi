import { expect, test, type Page } from '@playwright/test';

/**
 * The wallet layer, driven end to end with a stand-in browser wallet: an
 * EIP-1193 provider announced over EIP-6963, the way MetaMask, Rabby and
 * Coinbase Wallet announce themselves. It answers the handful of requests a
 * connect, a network switch and a disconnect make — and nothing that would
 * sign, because the simulator never sends a transaction.
 */
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const ROBINHOOD_HEX = '0x1237'; // 4663

async function installWallet(page: Page, chainId: string) {
  await page.addInitScript(
    ({ address, chainId: startChain }) => {
      const state = { chainId: startChain, accounts: [] as string[], known: new Set([startChain]) };
      const listeners: Record<string, ((x: unknown) => void)[]> = {};
      const emit = (event: string, data: unknown) => (listeners[event] ?? []).forEach((f) => f(data));
      const w = window as unknown as { __walletCalls: string[]; __added?: { chainId: string; rpcUrls: string[] } };
      w.__walletCalls = [];
      const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          w.__walletCalls.push(method);
          switch (method) {
            case 'eth_chainId':
              return state.chainId;
            case 'eth_accounts':
              return state.accounts;
            case 'wallet_requestPermissions':
              state.accounts = [address];
              return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [address] }] }];
            case 'eth_requestAccounts':
              state.accounts = [address];
              emit('accountsChanged', state.accounts);
              return state.accounts;
            case 'wallet_revokePermissions':
              state.accounts = [];
              return null;
            case 'wallet_switchEthereumChain': {
              const id = (params?.[0] as { chainId: string }).chainId;
              if (!state.known.has(id)) throw rpcError(4902, 'Unrecognized chain ID');
              state.chainId = id;
              emit('chainChanged', id);
              return null;
            }
            case 'wallet_addEthereumChain': {
              const added = params?.[0] as { chainId: string; rpcUrls: string[] };
              w.__added = added;
              state.known.add(added.chainId);
              state.chainId = added.chainId;
              emit('chainChanged', added.chainId);
              return null;
            }
            default:
              throw rpcError(4200, `unsupported ${method}`);
          }
        },
        on(event: string, f: (x: unknown) => void) {
          (listeners[event] ??= []).push(f);
        },
        removeListener(event: string, f: (x: unknown) => void) {
          listeners[event] = (listeners[event] ?? []).filter((x) => x !== f);
        },
      };
      const detail = Object.freeze({
        info: {
          uuid: '6f1b0d1e-0000-4000-8000-000000000001',
          name: 'Test Wallet',
          icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/%3E',
          rdns: 'dev.tidewell.testwallet',
        },
        provider,
      });
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { address: ADDRESS, chainId },
  );
}

const walletButton = (page: Page) => page.locator('.top .wm > .btn');

test.describe('wallet', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('with no wallet installed, connecting says so instead of pretending', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await expect(walletButton(page)).toHaveText('Connect wallet');
    await walletButton(page).click();
    await expect(page.locator('.wm-pop')).toContainText('No browser wallet found');
    // Escape closes it and hands focus back.
    await page.keyboard.press('Escape');
    await expect(page.locator('.wm-pop')).toHaveCount(0);
    await expect(walletButton(page)).toBeFocused();
  });

  test('connects an announced wallet, shows only its address, and disconnects', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installWallet(page, ROBINHOOD_HEX);
    await page.goto('/pools', { waitUntil: 'networkidle' });

    await walletButton(page).click();
    const choice = page.locator('.wm-pop .wm-item', { hasText: 'Test Wallet' });
    await expect(choice).toBeVisible();
    await choice.click();

    // The short form of the address the wallet reported, and nothing else.
    await expect(walletButton(page)).toHaveText('0x1234…5678');
    await expect(walletButton(page)).toHaveAttribute('aria-label', /0x1234567890AbcdEF1234567890aBcdef12345678/i);
    await expect(page.locator('.wm-pop')).toHaveCount(0);

    await walletButton(page).click();
    await expect(page.locator('.wm-addr')).toHaveText(/0x1234567890abcdef1234567890abcdef12345678/i);
    await page.locator('.wm-pop .wm-item', { hasText: 'Disconnect' }).click();
    await expect(walletButton(page)).toHaveText('Connect wallet');
    expect(errors).toEqual([]);
  });

  test('on another network, offers the switch and adds Robinhood Chain to the wallet', async ({ page }) => {
    await installWallet(page, '0x1');
    await page.goto('/pools', { waitUntil: 'networkidle' });

    await walletButton(page).click();
    await page.locator('.wm-pop .wm-item', { hasText: 'Test Wallet' }).click();
    await expect(walletButton(page)).toHaveText('Wrong network');

    // The menu stays open on the wrong network, now offering the switch.
    const switchButton = page.locator('.wm-pop .wm-item', { hasText: 'Switch to Robinhood Chain' });
    await expect(switchButton).toBeVisible();
    await switchButton.click();
    await expect(walletButton(page)).toHaveText('0x1234…5678');

    // The wallet did not know the chain, so it was added — with our RPC and explorer.
    const added = await page.evaluate(() => (window as unknown as { __added?: { chainId: string; rpcUrls: string[]; blockExplorerUrls?: string[] } }).__added);
    expect(added?.chainId).toBe(ROBINHOOD_HEX);
    expect(added?.rpcUrls[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(added?.blockExplorerUrls?.[0]).toBe('https://robinhoodchain.blockscout.com');
  });

  test('the simulator stays a preview with a wallet connected: nothing is signed', async ({ page }) => {
    await installWallet(page, ROBINHOOD_HEX);
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    await walletButton(page).click();
    await page.locator('.wm-pop .wm-item', { hasText: 'Test Wallet' }).click();
    await expect(walletButton(page)).toHaveText('0x1234…5678');

    await page.locator('.vault').first().click();
    const panel = page.locator('.spanel');
    await panel.getByRole('button', { name: /^Stake / }).click();
    await expect(page.locator('.toast')).toContainText('is a preview — no transaction was sent');
    const calls = await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls);
    expect(calls.filter((m) => /send|sign/i.test(m))).toEqual([]);
  });

  test('a stake under the $10 minimum is refused with the reason', async ({ page }) => {
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    await page.locator('.vault').first().click();
    const panel = page.locator('.spanel');
    await expect(panel).toContainText('Minimum $10');
    await panel.locator('#sp-amount').fill('0.0001');
    await expect(panel.getByRole('button', { name: /^Stake / })).toBeDisabled();
    await expect(panel.locator('[role="alert"]')).toContainText('Minimum $10');
  });
});
