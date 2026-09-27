import { expect, test, type Page } from '@playwright/test';

/**
 * A wallet's own tokens, found the moment it connects (§50). The simulator
 * has no API, so `/api/router/mine` is answered here, and the wallet is a
 * fake that announces itself the way an extension does (EIP-6963).
 */
const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DEV = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

async function fakeWallet(page: Page) {
  await page.addInitScript((address) => {
    window.localStorage.setItem('lockfi:router-detect', 'on');
    const provider = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return '0x1237';
        return null;
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({
            info: { uuid: 'test-wallet', name: 'Test Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'io.test.wallet' },
            provider,
          }),
        }),
      );
    window.addEventListener('eip6963:requestProvider', announce);
  }, WALLET);
}

async function connect(page: Page) {
  await page.getByRole('button', { name: /Connect wallet|Connect/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /Test Wallet/ }).click();
}

test.describe('tokens a wallet created', () => {
  test('are found on connect: said once, listed in the wallet, and on the Router page', async ({ page }) => {
    await fakeWallet(page);
    let asked = 0;
    await page.route('**/api/router/mine?**', (route) => {
      asked++;
      return route.fulfill({
        json: {
          wallet: WALLET.toLowerCase(),
          tokens: [
            {
              address: DEV.toLowerCase(),
              symbol: 'DEV',
              name: 'Dev Coin',
              decimals: 18,
              creator: { address: WALLET.toLowerCase(), tx: `0x${'ab'.repeat(32)}`, via: '0x' + '9'.repeat(40) },
            },
          ],
        },
      });
    });
    await page.goto('/pools');
    await connect(page);

    await expect(page.getByRole('status')).toContainText('Found a token you created: DEV');
    // the dialog closes on connect; the wallet button opens it again
    await page.locator('button.btn-brand', { hasText: '0x7099' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('created-tokens')).toContainText('DEV');
    await expect(dialog.getByTestId('created-tokens')).toContainText('launched through');
    await dialog.getByRole('link', { name: 'Router' }).click();
    await expect(page).toHaveURL(/\/router\?token=0x5fbdb/i);
    await expect(page.getByTestId('router-mine').getByTestId('created-tokens')).toContainText('Dev Coin');
    // one request for the whole visit: the dialog, the notice and the page share it
    expect(asked).toBe(1);
  });

  test('a wallet that created nothing is told so, not shown an empty list', async ({ page }) => {
    await fakeWallet(page);
    await page.route('**/api/router/mine?**', (route) => route.fulfill({ json: { wallet: WALLET.toLowerCase(), tokens: [] } }));
    await page.goto('/router');
    await expect(page.getByTestId('router-mine')).toContainText('Connect the wallet you launched from');
    await page.getByTestId('router-mine').getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Test Wallet/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('router-mine')).toContainText('No token created by this wallet was found');
  });
});
