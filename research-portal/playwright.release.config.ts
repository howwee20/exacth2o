import { defineConfig } from '@playwright/test';
import { browserChecks, escapeRegex } from './scripts/release-checks.mjs';

const previewPort = process.env.EXACTH2O_PREVIEW_PORT || '4899';
const harnessPort = process.env.EXACTH2O_HARNESS_PORT || '5178';
export default defineConfig({
  testDir: './browser-tests',
  testMatch: 'experiment-controls.spec.ts',
  grep: new RegExp(`(?:${browserChecks.map(escapeRegex).join('|')})$`),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: '.release-results/browser.json' }]],
  outputDir: 'test-results/release',
  use: { baseURL: `http://127.0.0.1:${previewPort}`, browserName: 'chromium', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'America/Detroit', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'python3 ../scripts/preview-site.py', url: `http://127.0.0.1:${previewPort}`, reuseExistingServer: !process.env.CI },
    { command: `npx vite --mode production --host 127.0.0.1 --port ${harnessPort} --strictPort`, url: `http://127.0.0.1:${harnessPort}`, reuseExistingServer: !process.env.CI },
  ],
});
