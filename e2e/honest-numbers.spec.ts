import { expect, test } from '@playwright/test';

/** §1 and §7. These are product rules, so they are asserted, not eyeballed. */
test.describe('honest numbers', () => {
  test('never says APY or APR anywhere in the app', async ({ page }) => {
    for (const route of ['/pools', '/stakes', '/positions', '/router', '/portfolio']) {
      await page.goto(route, { waitUntil: 'networkidle' });
      const text = await page.locator('body').innerText();
      expect(text, `${route} contains APY`).not.toMatch(/APY/i);
      expect(text, `${route} contains APR`).not.toMatch(/\bAPR\b/);
    }
  });

  test('labels every vault yield as trailing 7d', async ({ page }) => {
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    const cards = page.locator('.vault .apr small');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toContainText('fee yield, trailing 7d');
    }
  });

  test('a pool under 24h old shows an em dash, not a number', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'TWINE');
    await page.locator('#main tbody tr .stake-btn').first().click();
    const drawer = page.locator('.drawer');
    await expect(drawer).toHaveClass(/on/);
    // The dash, and why: a dash nobody can read is a number nobody can trust.
    await expect(drawer.locator('.kv .v').first()).toHaveText(/^—/);
    await expect(drawer.locator('.kv .v').first()).toContainText('under 24h of fees');
    // And it cannot be staked while it is still on its launchpad curve (§4).
    await expect(drawer).toContainText('Not stakeable yet');
    await expect(drawer.getByRole('button', { name: 'Stake', exact: true })).toBeDisabled();
  });

  test('a pool under 7d old is labelled est. and carries its age', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'LAURA');
    await page.locator('#main tbody tr .stake-btn').first().click();
    const drawer = page.locator('.drawer');
    await expect(drawer.locator('.kv .est').first()).toHaveText('est. · 1d');
  });

  test('discloses the protocol fee in the drawer before signing', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'PONS');
    await page.locator('#main tbody tr .stake-btn').first().click();
    const drawer = page.locator('.drawer');
    await expect(drawer).toContainText('10% of fees earned');
    await expect(drawer).toContainText('Lockup');
    await expect(drawer).toContainText('None');
  });

  test('says out-of-range positions earn nothing, in the row, in red', async ({ page }) => {
    await page.goto('/portfolio', { waitUntil: 'networkidle' });
    const status = page.locator('.pnl-row .down').first();
    await expect(status).toContainText('out of range — earning nothing');
    // --red, the one colour a negative gets (§19).
    await expect(status).toHaveCSS('color', 'rgb(194, 59, 46)');
  });

  test('shows price impact on holdings as a negative figure', async ({ page }) => {
    await page.goto('/portfolio', { waitUntil: 'networkidle' });
    const card = page.locator('.stat', { hasText: 'Price impact on holdings' });
    await expect(card.locator('.v')).toContainText('−');
    await expect(card.locator('.v')).toHaveClass(/down/);
  });

  test('states that routed liquidity is permanent', async ({ page }) => {
    await page.goto('/router', { waitUntil: 'networkidle' });
    await expect(page.locator('main')).toContainText('Routed liquidity is permanent');
    await expect(page.locator('main')).toContainText('cannot be withdrawn');
  });

  test('the top bar total agrees with the pools underneath it', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const topBarTvl = await page.locator('.ts', { hasText: 'TVL' }).locator('.v').innerText();
    const featuredLiquidity = await page
      .locator('.feat .fg > div', { hasText: 'Liquidity' })
      .locator('.v')
      .innerText();
    const top = Number(topBarTvl.replace(/[^0-9.]/g, ''));
    const featured = Number(featuredLiquidity.replace(/[^0-9.]/g, ''));
    // $15,112,440 in the bar, $15.11M on the card — the same number.
    expect(Math.abs(top / 1e6 - featured)).toBeLessThan(0.02);
  });
});
