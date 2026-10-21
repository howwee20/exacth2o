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
const overhead = (page: Page) => page.locator('.ax-overhead .ax-pot');

test('the aerial view shows every pot; all 100, a zone, one pot and the keyboard all select', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(harness());
  await expect(page.getByRole('heading', { name: 'Choose pots' })).toBeVisible();
  await expect(overhead(page)).toHaveCount(100);
  await expect(page.getByText(/Schematic arrangement by zone and pot number/)).toBeVisible();
  // The presentation composition: rows of 25, zone 1 interlocking with zone 2.
  const row = async (pot: number) => Number(await page.locator(`.ax-overhead .ax-pot[data-pot="${pot}"]`).evaluate((node) => getComputedStyle(node).gridRowStart));
  expect([await row(1), await row(13), await row(14), await row(26), await row(38), await row(51), await row(100)]).toEqual([1, 1, 2, 1, 2, 3, 4]);

  await page.getByRole('button', { name: 'Select all 100' }).click();
  await expect(page.getByText('100 of 100 selected')).toBeVisible();
  await expect(page.locator('.ac-summary')).toContainText('Pots 1–100');
  await shot(page, info, 'aerial-selection-all-100');

  await page.getByRole('button', { name: /^Zone 2: 25 of 25 selected/ }).first().click();
  await expect(page.getByText('75 of 100 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('0 of 100 selected')).toBeVisible();

  const first = page.locator('.ax-overhead .ax-pot[data-pot="1"]');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await first.press('ArrowRight');
  await expect(page.locator('.ax-overhead .ax-pot[data-pot="2"]')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.ax-overhead .ax-pot[data-pot="2"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.ax-overhead .ax-pot[data-pot="15"]')).toBeFocused();
  await expect(page.getByText('2 of 100 selected')).toBeVisible();
  // Details open from the keyboard too.
  await page.keyboard.press('i');
  await expect(page.getByRole('dialog', { name: /Pot 15/ })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Pot 15/ })).toContainText('Zone1-Pot15');
});

test('phone: one zone at a time with full-size touch targets', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/*.supabase.co/**', (route) => route.abort());
  await page.goto(harness());
  await expect(page.getByRole('heading', { name: 'Choose pots' })).toBeVisible();
  await expect(page.locator('.ax-overhead')).toBeHidden();
  const compact = page.locator('.ax-compact .ax-pot');
  await expect(compact).toHaveCount(100);
  const box = await compact.first().boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await compact.nth(0).tap();
  await compact.nth(30).tap();
  await expect(page.getByText('2 of 100 selected')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Select all 100' }).tap();
  await expect(page.getByText('100 of 100 selected')).toBeVisible();
  await shot(page, info, 'aerial-selection-phone');
  await context.close();
});

test('pots that cannot take part are drawn as unavailable and say why', async ({ page }) => {
  await page.goto(harness('?preset=issues'));
  await expect(page.getByRole('heading', { name: 'Choose pots' })).toBeVisible();
  const silent = page.locator('.ax-overhead .ax-pot[data-pot="47"]');
  await expect(silent).toHaveAttribute('aria-disabled', 'true');
  await expect(silent).toHaveAttribute('aria-label', /unavailable: No reading from sensor/);
  await expect(page.locator('.ax-overhead .ax-pot[data-pot="98"]')).toHaveAttribute('aria-label', /also configured on Zone4-Pot99/);
  // Tapping an unavailable pot selects nothing (force: the control is aria-disabled on purpose).
  await silent.click({ force: true });
  await expect(page.getByText('0 of 100 selected')).toBeVisible();
  await page.getByRole('button', { name: /Select all 97/ }).click();
  await expect(page.getByText('97 of 100 selected')).toBeVisible();
  await page.getByText('3 pots cannot take part right now').click();
  await expect(page.locator('.ac-unavailable')).toContainText('Pot 47');
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
  await page.getByRole('button', { name: 'Select all 100' }).click();
  await page.getByRole('button', { name: 'Continue with 100 pots' }).click();
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
  await expect(page.getByRole('button', { name: 'Select all 100' })).toBeVisible();
  await shot(page, info, 'restored');
});

test('manual watering in this tab interrupts the run first and keeps its evidence', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'One engine is enough for the simulated run.');
  test.setTimeout(4 * 60_000);
  await page.goto(harness());
  for (const pot of [1, 2, 3, 4, 5, 6]) await page.locator(`.ax-overhead .ax-pot[data-pot="${pot}"]`).click();
  await page.getByRole('button', { name: 'Continue with 6 pots' }).click();
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
