import { defineConfig } from '@playwright/test';
const previewPort = process.env.EXACTH2O_PREVIEW_PORT || '4899';
const harnessPort = process.env.EXACTH2O_HARNESS_PORT || '5178';
export default defineConfig({
  testDir: './browser-tests', timeout: 90000, expect: { timeout: 15000 },
  fullyParallel: true, workers: 3, retries: 1,
  reporter: [['list'], ['html', {open:'never'}]],
  use: { baseURL:`http://127.0.0.1:${previewPort}`, reducedMotion:'reduce', locale:'en-US', timezoneId:'America/Detroit', trace:'retain-on-failure', screenshot:'only-on-failure' },
  projects: [{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer: [{ command:'python3 ../scripts/preview-site.py', url:`http://127.0.0.1:${previewPort}`, reuseExistingServer:!process.env.CI }, { command:`npx vite --mode production --host 127.0.0.1 --port ${harnessPort} --strictPort`, url:`http://127.0.0.1:${harnessPort}`, reuseExistingServer:!process.env.CI }],
});
