import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Settings → Autocalibrate against the simulated 100-pot controller (fake-backend.ts).
// Every backend call is served inside the page; anything that tries to leave it fails.
test.beforeEach(async ({ page }) => {
  await page.route('**/*.supabase.co/**', (route) => route.abort());
});

const harness = (query = '') => `http://127.0.0.1:${process.env.EXACTH2O_HARNESS_PORT || '5178'}/browser-tests/autocal-harness.html${query}`;

async function shot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.AUTOCAL_SCREENSHOT_DIR;
  const body = await page.screenshot({ fullPage: true });
  await info.attach(name, { body, contentType: 'image/png' });
  if (directory) {
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${name}-${info.project.name}.png`), fullPage: true });
  }
}

const setSpeed = (page: Page, speed: number) => page.evaluate((value) => (window as unknown as { __setClockSpeed: (next: number) => void }).__setClockSpeed(value), speed);
const overhead = (page: Page) => page.locator('.ac-map-pot');

test('the saved field map has 100 pots and excludes unresolved and protected routes', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.goto(harness('?field=1'));
  await expect(overhead(page)).toHaveCount(100);
  for (const pot of [63, 87, 88, 89, 90]) {
    await expect(page.locator(`.ac-map-pot[data-pot="${pot}"]`)).toHaveClass(/is-excluded/);
    await expect(page.locator(`.ac-map-pot[data-pot="${pot}"]`)).toHaveAttribute('aria-disabled', 'true');
  }
  for (let pot = 65; pot <= 76; pot++) await expect(page.locator(`.ac-map-pot[data-pot="${pot}"]`)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.ac-map-pot[data-pot="83"]')).toHaveAttribute('aria-label', /output 84, 0x20:36/);
  await expect(page.locator('.ac-map-pot[data-pot="84"]')).toHaveAttribute('aria-label', /output 83, 0x20:35/);
  await expect(page.locator('.ac-map-pot[data-pot="86"]')).toHaveAttribute('aria-label', /output 96, 0x20:48/);
  await expect(page.locator('.ac-map-pot[data-pot="100"]')).toHaveAttribute('aria-label', /output 90, 0x20:42/);
  await page.getByRole('button', { name: 'Select all ready (83)' }).click();
  await expect(page.getByText('83 selected', { exact: true })).toBeVisible();
  await expect(page.locator('.ac-map-pot.is-selected')).toHaveCount(83);
  await expect(page.locator('.ac-map-pot.is-selected.is-protected, .ac-map-pot.is-selected.is-excluded')).toHaveCount(0);
  await shot(page, info, 'field-map-selection');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  const first = page.locator('.ac-map-pot[data-pot="1"]');
  await first.press('Space');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
});

test('phone: the full pot map has readable touch targets and no horizontal overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness('?field=1'));
  await expect(overhead(page)).toHaveCount(100);
  const box = await overhead(page).first().boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await overhead(page).first().click();
  await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await shot(page, info, 'field-map-phone');
});

test('unavailable sensors explain why they cannot be selected', async ({ page }) => {
  await page.goto(harness('?preset=issues'));
  const silent = page.locator('.ac-map-pot[data-pot="47"]');
  await expect(silent).toHaveAttribute('aria-disabled', 'true');
  await expect(silent).toHaveAttribute('aria-label', /No reading from sensor/);
  await expect(page.locator('.ac-map-pot[data-pot="98"]')).toHaveAttribute('aria-label', /also configured on Zone4-Pot99/);
  await silent.click({ force: true });
  await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select all ready (97)' }).click();
  await expect(page.getByText('97 selected', { exact: true })).toBeVisible();
});

test('a viewer is told that operator access is required', async ({ page }) => {
  await page.goto(harness('?role=viewer'));
  await expect(page.getByText('Operator access required')).toBeVisible();
  await expect(overhead(page)).toHaveCount(0);
});

test('full simulated 100-pot run: prepare, check, run, review, apply with readback, restore', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'One engine is enough for the long simulated run.');
  test.setTimeout(8 * 60_000);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(harness());
  await page.getByRole('button', { name: 'Select all ready (100)' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prepare 100 pots' })).toBeVisible();
  await page.getByText('I understand these 100 pots will not be watered automatically').click();
  await page.getByRole('button', { name: /Queue the change: prepare 100 pots/ }).click();
  await setSpeed(page, 30);
  await expect(page.getByRole('heading', { name: 'Check and start' })).toBeVisible({ timeout: 30_000 });
  await setSpeed(page, 1);
  // Preparation is in force on the simulated controller: watering off, 60 s cadence.
  const prepared = await page.evaluate(() => (window as unknown as { __preview: { portalPairings(): Array<{ wtc_percent_limit: number; measurement_interval_ms: number }> } }).__preview.portalPairings());
  expect(prepared.every((pairing) => pairing.wtc_percent_limit < 0 && pairing.measurement_interval_ms === 60_000)).toBe(true);

  await page.getByText('Open real valves', { exact: true }).click();
  await page.getByRole('button', { name: 'Run safety checks' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  await page.getByRole('textbox', { name: /Type OPEN 100 REAL VALVES/ }).fill('OPEN 100 REAL VALVES');
  await page.getByRole('button', { name: 'Open 100 real valves, one at a time' }).click();
  await expect(page.getByRole('button', { name: 'Stop now' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Autocalibration in progress' })).toBeVisible();

  await setSpeed(page, 600);
  await expect.poll(async () => Number((await page.locator('.ac-stats dd').first().textContent())?.split(' ')[0] ?? 0), { timeout: 120_000 }).toBeGreaterThanOrEqual(35);
  await setSpeed(page, 1);
  await shot(page, info, 'run-progress');
  await setSpeed(page, 600);
  await expect(page.getByRole('heading', { name: /^Results ·/ })).toBeVisible({ timeout: 240_000 });
  await setSpeed(page, 1);
  await expect(page.locator('.ac-stats.is-results')).toContainText('100 of 100');
  await shot(page, info, 'results');

  // The hidden layout: a cross-zone swap, a swap inside zone 2, a three-pot cycle, one disconnected hose.
  const cycles = page.locator('.ac-cycles > li');
  await expect(cycles).toHaveCount(3);
  await expect(page.locator('.ac-cycles')).toContainText('Swap: Pot 3 ↔ Pot 97');
  await expect(page.locator('.ac-cycles')).toContainText('Swap: Pot 31 ↔ Pot 32');
  await expect(page.locator('.ac-cycles')).toContainText(/Cycle of 3: Pot 55 → Pot 5[67] → Pot 5[67] → Pot 55/);
  await expect(page.getByText(/Unresolved valves \(1\)/)).toBeVisible();
  for (const ack of await page.getByRole('checkbox', {name: /^I checked .* at the bench:/}).all()) await ack.check();
  for (let index = 0; index < 3; index += 1) await cycles.nth(index).locator('.ac-cycle-head input').check();
  await page.getByRole('textbox', { name: /Type APPLY 7 VALVE CHANGES/ }).fill('APPLY 7 VALVE CHANGES');
  await page.getByRole('button', { name: 'Queue the change: 7 pots' }).click();
  await setSpeed(page, 30);
  await expect(page.getByText('The controller reports all 7 pots on their measured valves.')).toBeVisible({ timeout: 60_000 });
  await setSpeed(page, 1);
  const valves = await page.evaluate(() => Object.fromEntries((window as unknown as { __preview: { portalPairings(): Array<{ name: string; valve_key: string }> } }).__preview.portalPairings().map((pairing) => [pairing.name, pairing.valve_key])));
  // Pot 3 now uses the valve that was recorded on pot 97 (relay 34, channel 1), and the other way round.
  expect(valves['Zone1-Pot3']).toBe('34:1');
  expect(valves['Zone4-Pot97']).toBe('32:3');
  await shot(page, info, 'applied');

  await page.getByRole('button', { name: 'Continue to restore' }).click();
  await expect(page.getByRole('heading', { name: 'Restore and finish' })).toBeVisible();
  await expect(page.locator('.ac-held')).toContainText('Pot 80');
  await page.getByRole('button', { name: 'Queue the restore: 99 pots' }).click();
  await setSpeed(page, 30);
  await expect(page.getByRole('heading', { name: /^Last session ·/ })).toBeVisible({ timeout: 60_000 });
  await setSpeed(page, 1);
  await expect(page.locator('.ac-step.is-closed')).toContainText('1 stayed sensing-only: Pot 80');
  const restored = await page.evaluate(() => (window as unknown as { __preview: { portalPairings(): Array<{ name: string; wtc_percent_limit: number; measurement_interval_ms: number }> } }).__preview.portalPairings());
  expect(restored.filter((pairing) => pairing.name !== 'Zone4-Pot80').every((pairing) => pairing.wtc_percent_limit >= 22 && pairing.measurement_interval_ms === 600_000)).toBe(true);
  expect(restored.find((pairing) => pairing.name === 'Zone4-Pot80')?.wtc_percent_limit).toBeLessThan(0);
  // Ready for another session: every pot can take part again.
  await expect(page.getByRole('button', { name: 'Select all ready (100)' })).toBeVisible();
  await shot(page, info, 'restored');
});

test('manual watering in this tab interrupts the run first and keeps its evidence', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'One engine is enough for the simulated run.');
  test.setTimeout(4 * 60_000);
  await page.goto(harness());
  for (const pot of [1, 2, 3, 4, 5, 6]) await page.locator(`.ac-map-pot[data-pot="${pot}"]`).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('I understand these 6 pots will not be watered automatically').click();
  await page.getByRole('button', { name: /Queue the change: prepare 6 pots/ }).click();
  await setSpeed(page, 30);
  await expect(page.getByRole('heading', { name: 'Check and start' })).toBeVisible({ timeout: 30_000 });
  await setSpeed(page, 1);
  await page.getByText('Open real valves', { exact: true }).click();
  await page.getByRole('button', { name: 'Run safety checks' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  await page.getByRole('textbox', { name: /Type OPEN 6 REAL VALVES/ }).fill('OPEN 6 REAL VALVES');
  await page.getByRole('button', { name: 'Open 6 real valves, one at a time' }).click();
  await setSpeed(page, 60);
  await expect.poll(async () => Number((await page.locator('.ac-stats dd').first().textContent())?.split(' ')[0] ?? 0), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await setSpeed(page, 1);

  await page.getByRole('button', { name: 'Manual water' }).click();
  await page.getByRole('textbox', { name: /Solenoid number/ }).fill('40');
  await page.getByRole('button', { name: /^Solenoid 40,/ }).click();
  await expect(page.getByText(/Autocalibration is running in this tab/)).toBeVisible();
  const hold = page.getByRole('button', { name: /Hold to water/ });
  await expect(hold).toBeDisabled();
  await page.getByRole('button', { name: 'Stop autocalibration when I hold' }).click();
  await hold.hover();
  await page.mouse.down();
  await expect(page.getByRole('button', { name: /Watering/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await expect(page.locator('.px-water-status [role="status"]')).toHaveText(/Stopped · the controller reports the valve closed/);
  await page.getByRole('button', { name: 'Close' }).click();

  await expect(page.getByRole('heading', { name: 'Resume the run' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ac-interruption')).toContainText(/Manual watering \(Solenoid 40\) interrupted autocalibration/);
  await expect(page.locator('.ac-interruption')).toContainText(/valves have usable evidence and are not pulsed again/);
});


test('partial live inventory and obsolete layout still show all 100 slots without selectable invented routes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(harness('?preset=partial'));
  await expect(overhead(page)).toHaveCount(100);
  await expect(page.locator('.ac-unplaced')).toHaveCount(0);
  const missing = page.locator('.ac-map-pot[data-pot="1"]');
  await expect(missing).toHaveAttribute('aria-disabled', 'true');
  await expect(missing).toHaveAttribute('aria-label', /sensor not linked/);
  await missing.click({ force: true });
  await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select all ready (2)', exact: true }).click();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  await expect(page.locator('.ac-map-pot[data-pot="65"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ac-map-pot[data-pot="100"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(missing).toHaveAttribute('aria-pressed', 'false');
});
