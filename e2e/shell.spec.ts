import { expect, test } from '@playwright/test';

const ROUTES = [
  '/pools',
  '/stakes',
  '/positions',
  '/router',
  '/portfolio',
  '/brand',
  '/contracts',
  '/docs',
  '/status',
  '/stats',
  '/token/0x0040dbfd23df97c06FB9A73B59E298D7e5BcE198',
  '/share/0x000000000000000000000000000000000000dEaD',
];
const WIDTHS = [1600, 1180, 760, 360];

test.describe('shell', () => {
  test('every route renders without a console error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('main#main')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('links the official X account and shows the token CA', async ({ page }) => {
    await page.goto('/pools');
    const x = page.getByRole('link', { name: '@usetidewell on X' });
    await expect(x).toHaveAttribute('href', 'https://x.com/usetidewell');
    await expect(x).toHaveAttribute('target', '_blank');
    await expect(x).toHaveAttribute('rel', /noopener/);
    await expect(page.locator('footer .xlink').first()).toHaveAttribute('href', 'https://x.com/usetidewell');
    // Telegram, in the top bar and the footer.
    await expect(page.getByRole('link', { name: 'Tidewell on Telegram' })).toHaveAttribute('href', 'https://t.me/tidewellchannel');
    await expect(page.locator('footer .tglink')).toHaveAttribute('href', 'https://t.me/tidewellchannel');
    // The CA, short in the strip and whole in the footer, linked to the
    // explorer, with the warning that guards against the fake CAs posted
    // around every launch.
    const ca = '0x0040dbfd23df97c06FB9A73B59E298D7e5BcE198';
    await expect(page.locator('.strip .ca-chip')).toContainText('0x0040…E198');
    await expect(page.locator('footer .ca-chip')).toContainText(ca);
    await expect(page.locator('footer .ca-chip a')).toHaveAttribute('href', new RegExp(`/token/${ca}$`));
    await expect(page.locator('footer')).toContainText('Only trust the CA shown on this site and on @usetidewell');
  });

  // The footer's Contracts, Docs and Status lead to real pages (§31), not to
  // placeholders.
  test('the footer links to the contracts, docs and status pages', async ({ page }) => {
    await page.goto('/pools');
    for (const [name, path, heading] of [
      ['Contracts', '/contracts', 'Contracts'],
      ['Docs', '/docs', 'Docs'],
      ['Stats', '/stats', 'Stats'],
      ['Status', '/status', 'Status'],
    ] as const) {
      await page.locator('footer').getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
      await page.goBack();
    }
    await page.goto('/contracts');
    await expect(page.locator('#main')).toContainText('0x0040');
    await expect(page.locator('#main')).toContainText('Vault');
  });

  // §32: a token has a page of its own, reached from its drawer, with its
  // pools and what can be done in each.
  test('the drawer leads to the token page, which lists the token’s pools', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.locator('table tbody tr').first().locator('.tok-btn').click();
    const drawer = page.getByRole('dialog');
    const pair = (await drawer.getAttribute('aria-label')) ?? '';
    await drawer.getByRole('link', { name: 'Token page' }).click();
    await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}$/);
    const symbol = pair.replace(/^Stake /, '').split(' / ')[0];
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(symbol);
    await expect(page.getByRole('heading', { name: new RegExp(`${symbol} trades in \\d+ pools?`) })).toBeVisible();
    await expect(page.locator('#main')).toContainText('Share on X');
  });

  test('the share card is an image the site serves', async ({ request }) => {
    const r = await request.get('/share/0x000000000000000000000000000000000000dEaD/opengraph-image');
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
    const t = await request.get('/token/0x0040dbfd23df97c06FB9A73B59E298D7e5BcE198/opengraph-image');
    expect(t.status()).toBe(200);
  });

  test('/ redirects to the listing', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/pools$/);
  });

  /** §5: a table must never overflow its card, and §11: responsive to 360px. */
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ROUTES) {
        await page.goto(route, { waitUntil: 'networkidle' });
        const result = await page.evaluate(() => {
          const doc = document.documentElement;
          const spilling: string[] = [];
          document.querySelectorAll('table').forEach((t) => {
            // §5 is about the data tables a reader sees. A visually hidden
            // table sits inside a 1px clip box by design, so it is always
            // "wider" than its wrapper and is not what the rule means.
            if (t.closest('.sr-only')) return;
            const wrap = t.parentElement;
            if (wrap && t.scrollWidth > wrap.clientWidth + 1) {
              spilling.push(`${t.scrollWidth}>${wrap.clientWidth}`);
            }
          });
          return { page: doc.scrollWidth - doc.clientWidth, spilling };
        });
        expect(result.page, `page scrolls sideways on ${route}`).toBeLessThanOrEqual(1);
        expect(result.spilling, `table overflows its card on ${route}`).toEqual([]);
      }
    });
  }

  // §19: the destinations live in the top bar on a wide screen and move to a
  // tab bar below 1024px. Exactly one of the two is ever displayed.
  test('navigation is in the top bar, and in a tab bar below 1024px', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/pools');
    await expect(page.locator('.top .links a', { hasText: 'Stakes' })).toBeVisible();
    await expect(page.locator('.tabbar')).toBeHidden();
    await expect(page.locator('.top .links a.on')).toHaveText('Pools');

    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.locator('.top .links')).toBeHidden();
    await expect(page.locator('.tabbar a', { hasText: 'Stakes' })).toBeVisible();
    await page.locator('.tabbar a', { hasText: 'Stakes' }).click();
    await expect(page).toHaveURL(/\/stakes$/);
  });
});

test.describe('brand', () => {
  test('the brand page serves every file it offers', async ({ page, request }) => {
    await page.goto('/brand', { waitUntil: 'networkidle' });
    const links = await page
      .locator('#main a[download]')
      .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href')!));
    expect(links.length).toBeGreaterThan(10);
    for (const href of new Set(links)) {
      const res = await request.get(href);
      expect(res.status(), href).toBe(200);
    }
  });

  test('the site ships its icons and manifest', async ({ request }) => {
    for (const path of ['/icon.svg', '/apple-icon.png', '/manifest.webmanifest', '/icons/icon-512.png', '/og-card.png']) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
  });
});
