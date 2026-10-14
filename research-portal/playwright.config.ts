import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests', timeout: 90000, expect: { timeout: 15000 },
  fullyParallel: true, workers: 3, retries: 1,
  reporter: [['list'], ['html', {open:'never'}]],
  use: { baseURL:'http://127.0.0.1:4899', reducedMotion:'reduce', locale:'en-US', timezoneId:'America/Detroit', trace:'retain-on-failure', screenshot:'only-on-failure' },
  projects: [{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer: { command:'python3 ../scripts/preview-site.py', url:'http://127.0.0.1:4899', reuseExistingServer:!process.env.CI },
});
