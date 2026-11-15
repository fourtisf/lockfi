import { expect, test } from '@playwright/test';

test.describe('shape builder', () => {
  test('the bin chart follows shape, range and bin count', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    const bars = page.locator('.bins rect');

    await expect(bars).toHaveCount(24);
    await page.locator('#b-bins').fill('40');
    await expect(bars).toHaveCount(40);

    // Spot is flat; curve is not.
    const heightsOf = async () =>
      page.locator('.bins rect').evaluateAll((els) => els.map((el) => el.getAttribute('height')));
    const spot = await heightsOf();
    expect(new Set(spot).size).toBe(1);

    await page.getByRole('button', { name: 'Curve' }).click();
    const curve = await heightsOf();
    expect(new Set(curve).size).toBeGreaterThan(1);

    await page.locator('#b-max').fill('30');
    await expect(page.locator('.sum .num').first()).not.toHaveText('');
  });

  test('refuses an inverted range instead of drawing nonsense', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    const mint = page.getByRole('button', { name: 'Mint position' });
    await expect(mint).toBeEnabled();

    await page.locator('#b-max').fill('-20');
    await expect(mint).toBeDisabled();
    await expect(page.locator('.builder p[role="alert"]')).toContainText('Max must be above Min');

    await page.locator('#b-max').fill('15');
    await expect(mint).toBeEnabled();
  });

  test('refuses a deposit above the balance', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    await page.locator('#b-amount').fill('999');
    await expect(page.getByRole('button', { name: 'Mint position' })).toBeDisabled();
    await expect(page.locator('.builder p[role="alert"]')).toContainText('above your balance');

    await page.locator('#b-amount').fill('0');
    await expect(page.locator('.builder p[role="alert"]')).toContainText('Enter a deposit amount');
  });

  test('shows the trailing figure the estimate is derived from', async ({ page }) => {
    await page.goto('/positions', { waitUntil: 'networkidle' });
    await expect(page.locator('.sum .est')).toContainText(/est\. · from \d+% trailing/);
  });
});

test.describe('router form', () => {
  test('rejects milestones that are out of order at config time', async ({ page }) => {
    await page.goto('/router', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Market-cap milestones' }).click();

    const enable = page.getByRole('button', { name: 'Enable router' });
    await expect(enable).toBeEnabled();

    await page.locator('#ms-mc-2').fill('1,000,000');
    await expect(enable).toBeDisabled();
    await expect(page.locator('.hint.down')).toContainText('must ascend');

    await page.locator('#ms-mc-2').fill('20,000,000');
    await expect(enable).toBeEnabled();
  });
});

test.describe('search', () => {
  test('filters the boards and shows an empty state', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await page.fill('#q', 'pons');
    await expect(page.locator('#main tbody tr')).toHaveCount(2);
    await page.fill('#q', 'zzzz');
    await expect(page.locator('.empty')).toHaveCount(2);
  });

  test('filters the stakes page too, as its placeholder promises', async ({ page }) => {
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    const all = await page.locator('.vault').count();
    expect(all).toBeGreaterThan(1);
    await page.fill('#q', 'pons');
    await expect(page.locator('.vault')).toHaveCount(1);
  });

  test('takes you to the listing when the page cannot be filtered', async ({ page }) => {
    await page.goto('/router', { waitUntil: 'networkidle' });
    await page.fill('#q', 'mooncat');
    await expect(page).toHaveURL(/\/pools/);
    await expect(page.locator('#main tbody tr .tok-btn').first()).toContainText('MOONCAT');
  });
});

test.describe('stakes page', () => {
  test('choosing a vault fills the stake panel, fee disclosed before staking', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    const rows = page.locator('.vault');
    const second = rows.nth(1);
    const symbol = (await second.locator('.tok b').innerText()).split(' / ')[0].trim();
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');

    const panel = page.locator('.spanel');
    await expect(panel.locator('h2')).toContainText(`Stake ${symbol}`);
    await expect(panel).toContainText('10% of fees earned');
    await expect(panel).toContainText('Lockup');

    // Over the balance: refused with a reason, not staked.
    await panel.locator('#sp-amount').fill('999');
    await expect(panel.getByRole('button', { name: `Stake ${symbol}` })).toBeDisabled();
    await expect(panel.locator('[role="alert"]')).toContainText('above your balance');
  });

  test('offers ETH, the pool’s token, or both — and matches the second side to the first', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    await page.locator('.vault').first().click();
    const panel = page.locator('.spanel');
    const routes = panel.getByRole('group', { name: 'Deposit with' }).getByRole('button');
    await expect(routes).toHaveCount(3);
    const labels = await routes.allInnerTexts();
    expect(labels[2]).toBe(`${labels[0]} + ${labels[1]}`);

    // One token: one field, and the note says half of it is swapped.
    await routes.nth(1).click();
    await expect(panel.locator('.sf-field')).toHaveCount(1);
    await expect(panel.locator('.sf-note')).toContainText('swapped');

    // Both: two fields; typing the first fills the second, and nothing is swapped.
    await routes.nth(2).click();
    await expect(panel.locator('.sf-field')).toHaveCount(2);
    await expect(panel.locator('.sf-note')).toContainText('nothing is swapped');
    await panel.locator('#sp-amount').fill('0.5');
    await expect(panel.locator('#sp-amount-2')).not.toHaveValue('');
    await expect(panel.locator('.sf-matched')).toBeVisible();
  });

  test('ranks vaults by fee yield', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    const yields = await page
      .locator('.vault .apr')
      .evaluateAll((els) => els.map((el) => Number.parseFloat(el.firstChild?.textContent ?? '') || -1));
    expect(yields).toEqual([...yields].sort((a, b) => b - a));
  });

  test('on a phone a vault opens the drawer instead', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/stakes', { waitUntil: 'networkidle' });
    await expect(page.locator('.spanel')).toBeHidden();
    await page.locator('.vault').first().click();
    await expect(page.locator('.drawer')).toHaveClass(/on/);
  });
});
