import { defineConfig, devices } from '@playwright/test';

/**
 * Live checks against the deployed site. NOT part of CI or `npm run test:e2e`:
 * it logs in with a real account and creates (then cancels) one test expense.
 *
 *   D89_LIVE_EMAIL=… D89_LIVE_PASSWORD=… npx playwright test -c playwright.live.config.ts
 */
export default defineConfig({
  testDir: './tests/live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-live' }]],
  outputDir: 'test-results-live',
  use: {
    baseURL: process.env.D89_LIVE_URL ?? 'https://d89.escalaleads.com.mx',
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});
