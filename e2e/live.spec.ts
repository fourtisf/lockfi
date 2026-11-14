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
            .querySelectorAll('.seg')[0]
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
