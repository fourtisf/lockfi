import { expect, test } from '@playwright/test';

const ROUTES = ['/pools', '/stakes', '/positions', '/router', '/router/deploy', '/portfolio', '/learn', '/ask'];
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

  test('the navigation marks the current page and stays reachable on a phone', async ({ page }) => {
    await page.goto('/stakes');
    await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('Stakes');
    // Below 900px the links take their own row and scroll inside it; every
    // page is still one tap away and the page itself never scrolls sideways.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('.nav-links a', { hasText: 'Portfolio' }).click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText(/^Portfolio( \d+ out of range)?$/);
  });
});
