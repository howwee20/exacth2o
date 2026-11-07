import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/*.supabase.co/**', route => route.abort());
});

test('four pots: one confirmation prepares and runs, with a 15 minute observation window', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(`http://127.0.0.1:${process.env.EXACTH2O_HARNESS_PORT || '5178'}/browser-tests/autocal-harness.html`);
  for (const pot of [1, 2, 4, 6]) await page.locator(`.ac-map-pot[data-pot="${pot}"]`).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run autocalibration' })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Wait for sensor response (minutes per valve)' })).toHaveValue('15');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: /Type OPEN 4 REAL VALVES/ }).fill('OPEN 4 REAL VALVES');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __setClockSpeed: (speed: number) => void }).__setClockSpeed(60));
  await expect(page.getByRole('button', { name: 'Stop now' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Matches so far' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __setClockSpeed: (speed: number) => void }).__setClockSpeed(600));
  await expect(page.getByRole('heading', { name: /^Results ·/ })).toBeVisible({ timeout: 80_000 });
  await expect(page.locator('.ac-stats.is-results')).toContainText('4 of 4');
});

test('phone: invalid observation window cannot start a run and cancel keeps valves closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${process.env.EXACTH2O_HARNESS_PORT || '5178'}/browser-tests/autocal-harness.html`);
  for (const pot of [1, 2, 4, 6]) await page.locator(`.ac-map-pot[data-pot="${pot}"]`).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('textbox', { name: /Type OPEN 4 REAL VALVES/ }).fill('OPEN 4 REAL VALVES');
  await page.getByRole('spinbutton', { name: 'Wait for sensor response (minutes per valve)' }).fill('0');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await expect(page.getByText('Observation window (sec) must be between 60 and 3600.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Cancel and restore settings' }).click();
  await expect(page.getByRole('heading', { name: 'Restore and finish' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop now' })).toHaveCount(0);
});

test('stopping setup prevents a late preparation completion from starting pulses', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${process.env.EXACTH2O_HARNESS_PORT || '5178'}/browser-tests/autocal-harness.html`);
  for (const pot of [1, 2, 4, 6]) await page.locator(`.ac-map-pot[data-pot="${pot}"]`).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('textbox', { name: /Type OPEN 4 REAL VALVES/ }).fill('OPEN 4 REAL VALVES');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Stop setup' }).click();
  await page.evaluate(() => (window as unknown as { __setClockSpeed: (speed: number) => void }).__setClockSpeed(600));
  await expect(page.getByText('Setup stopped. Restore the recorded settings before leaving this session.')).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole('button', { name: 'Stop now' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __preview: { rows: (table: string) => Array<{command_type: string}> } }).__preview.rows('project_control_commands').some(row => row.command_type === 'manual_water'))).toBe(false);
});
