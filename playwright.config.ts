import { defineConfig, devices } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';

/**
 * End-to-end checks for the behaviour §6 and §11 ask for: the flash, the FLIP
 * reorder, the drawer's focus trap, the honest-number states, and no
 * horizontal overflow at any width. Unit tests cannot see any of that.
 *
 * Run with `npm run test:e2e`. Kept out of CI's default job because it needs a
 * browser binary; CI runs `npm test` plus the build.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);

/** Some sandboxes ship Chromium already; use it instead of downloading one. */
const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  // Newer images link the binary itself at this path.
  '/opt/pw-browsers/chromium',
].find((p) => existsSync(p) && statSync(p).isFile());

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
    launchOptions: PREINSTALLED ? { executablePath: PREINSTALLED } : {},
  },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/pools`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
