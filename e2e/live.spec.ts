import { expect, test } from '@playwright/test';

/** §6: values flash on change, rows reorder with a FLIP transform. */
test.describe('live boards', () => {
  test('values update in place and flash green or red', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });

    const before = await page.locator('#main table tbody td.num').allTextContents();
    const seen = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const directions = new Set<string>();
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              const el = m.target as HTMLElement;
              if (el.classList?.contains('fu')) directions.add('fu');
              if (el.classList?.contains('fd')) directions.add('fd');
            }
          });
          observer.observe(document.querySelector('#main')!, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
          });
          setTimeout(() => {
            observer.disconnect();
            resolve([...directions]);
          }, 12_000);
        }),
    );
    const after = await page.locator('#main table tbody td.num').allTextContents();

    expect(after).not.toEqual(before);
    expect(seen.length, 'no value flashed in 12s').toBeGreaterThan(0);
  });

  test('rows animate to a new rank instead of jumping', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });

    // Changing the quote filter reorders the rows deterministically; a tick
    // does it too, but only when ranks happen to cross.
    const transforms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let count = 0;
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              const el = m.target as HTMLElement;
              if (el.tagName === 'TR' && el.style.transform.includes('translateY')) count++;
            }
          });
          observer.observe(document.querySelector('#main')!, {
            subtree: true,
            attributes: true,
            attributeFilter: ['style'],
          });
          document
            .querySelector('[aria-label$="quote filter"]')!
            .querySelectorAll('button')[1]
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
          setTimeout(() => {
            observer.disconnect();
            resolve(count);
          }, 1200);
        }),
    );
    expect(transforms, 'rows jumped instead of animating').toBeGreaterThan(0);
  });

  test('boards rank by market cap first, and remember a switch to their own order', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const board = page.locator('#main .card').filter({ has: page.getByRole('group', { name: /Trending sort/ }) });
    const mcCells = board.locator('tbody td.hide-mc');
    const values = async () =>
      (await mcCells.allTextContents()).map((t) => {
        const m = t.replace(/fdv/, '').match(/\$([\d.]+)([KMBT]?)/);
        return m ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[m[2]] : 0;
      });
    const mc = board.getByRole('button', { name: 'MC', exact: true });
    const volume = board.getByRole('button', { name: 'Volume', exact: true });

    // The default: highest market cap first.
    await expect(mc).toHaveAttribute('aria-pressed', 'true');
    await expect(board.locator('.sect-h')).toContainText('by market cap');
    const ranked = await values();
    expect(ranked.length).toBeGreaterThan(2);
    expect(ranked).toEqual([...ranked].sort((a, b) => b - a));

    // A switch to the board's own order survives a reload.
    await volume.click();
    await expect(board.locator('.sect-h')).toContainText('by volume');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(volume).toHaveAttribute('aria-pressed', 'true');
    await mc.click();
    await expect(board.locator('.sect-h')).toContainText('by market cap');
  });

  test('Gainers and Losers rank the 24h price move, up and down', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const board = page.locator('#main .card').filter({ has: page.getByRole('group', { name: /Trending sort/ }) });
    const moves = async () =>
      (await board.locator('tbody .chg').allTextContents()).map((t) => {
        const m = t.replace('−', '-').match(/([+-]?[\d.]+)%/);
        // "▲ +4.8%", "▼ −2.9%": the sign is in the figure.
        return m ? Number(m[1]) : 0;
      });

    await board.getByRole('button', { name: /Gainers/ }).click();
    await expect(board.locator('.sect-h')).toContainText('top gainers 24h');
    await expect(board.locator('th[aria-sort="descending"]')).toHaveText('24h');
    const up = await moves();
    expect(up.length).toBeGreaterThan(2);
    expect(up).toEqual([...up].sort((a, b) => b - a));

    await board.getByRole('button', { name: /Losers/ }).click();
    await expect(board.locator('.sect-h')).toContainText('top losers 24h');
    const down = await moves();
    expect(down).toEqual([...down].sort((a, b) => a - b));
  });

  test('row one carries the leader highlight on both boards', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    await expect(page.locator('#main tbody tr.lead')).toHaveCount(2);
  });

  // §18 changed §6's hover-reveal: a phone has no hover, and the revealed
  // button used to sit on top of the sparkline. Stake now has its own column,
  // always visible, quiet until its row is hovered.
  test('Stake is on every row, lights up on hover, and opens the drawer without navigating', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    const row = page.locator('#main tbody tr').nth(1);
    const button = row.locator('.stake-btn');
    await expect(button).toBeVisible();
    const quiet = await button.evaluate((el) => getComputedStyle(el).color);
    await row.hover();
    await expect
      .poll(() => button.evaluate((el) => getComputedStyle(el).color))
      .not.toBe(quiet);
    // Its own cell: the sparkline beside it is never covered.
    const [b, s] = await Promise.all([
      button.boundingBox(),
      row.locator('svg.mini').boundingBox(),
    ]);
    expect(b && s && b.x >= s.x + s.width).toBe(true);
    await button.click();
    await expect(page.locator('.drawer')).toHaveClass(/on/);
    await expect(page).toHaveURL(/\/pools$/);
  });

  test('the indexer lag shows in the top bar when it falls behind', async ({ page }) => {
    await page.goto('/pools', { waitUntil: 'networkidle' });
    // The simulator drops behind head periodically so this state is reachable.
    await expect(page.locator('.lag.behind')).toBeVisible({ timeout: 150_000 });
    await expect(page.locator('.lag.behind')).toContainText(/behind/i);
  });
});
