import { test, expect } from '@playwright/test';
const harness = `http://127.0.0.1:${process.env.EXACTH2O_HARNESS_PORT || '5178'}/browser-tests/experiment-controls-harness.html`;

for (const group of [{ name: 'Control', old: 30 }, { name: 'Drought', old: 10 }]) {
  test(`${group.name} requires confirmation after the checkmark`, async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => { if (/\.supabase\.co\/|\/rest\/v1\/|\/functions\/v1\//.test(request.url())) requests.push(request.url()); });
    await page.goto(harness);
    const pill = page.getByRole('slider', { name: `${group.name} target`, exact: true });
    await pill.focus(); await page.keyboard.press('ArrowUp');
    await expect(page.getByLabel('Applied targets')).toContainText(`${group.name} ${group.old}%`);
    await page.getByRole('button', { name: `Apply ${group.old + 1}% target to 1 pot`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Change ${group.name} target?` });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Applied targets')).toContainText(`${group.name} ${group.old}%`);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pill).toHaveAttribute('aria-valuenow', String(group.old));
    await pill.focus(); await page.keyboard.press('ArrowUp');
    await page.getByRole('button', { name: `Apply ${group.old + 1}% target to 1 pot`, exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm target', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Applied targets')).toContainText(`${group.name} ${group.old + 1}%`);
    expect(requests).toEqual([]);
  });
}

test('range pills stay beneath the slider and work on long experiments at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness);
  const presets = page.getByRole('group', { name: 'Time range', exact: true });
  await expect(presets.getByRole('button', { name: 'Entire experiment', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await presets.getByRole('button', { name: '24h', exact: true }).click();
  const start = page.getByRole('slider', { name: 'Start time', exact: true });
  expect(Number(await start.getAttribute('aria-valuenow'))).toBeGreaterThan(99);
  await expect(presets.getByRole('button', { name: '24h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Next reading', exact: true }).click();
  await expect(presets.getByRole('button', { name: '24h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await presets.getByRole('button', { name: '7d', exact: true }).click();
  await expect(presets.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await presets.boundingBox())!.y).toBeGreaterThan((await start.boundingBox())!.y);
  await presets.getByRole('button', { name: 'Entire experiment', exact: true }).click();
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('experiment loading pages past the server limit and can retry a failed read', async ({ page }) => {
  let fail = true;
  let pages = 0;
  await page.route('**/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/sensor_readings')) { await route.fulfill({ json: [] }); return; }
    if (fail) { await route.fulfill({ status: 503, json: { message: 'Read unavailable' } }); return; }
    pages++;
    const before = Number(url.searchParams.get('or')?.match(/id\.lt\.(\d+)/)?.[1] ?? 1204);
    const data = Array.from({ length: 1203 }, (_, i) => ({ id: 1203 - i, event_id: `test:${i}`, pairing_name: 'Pot65', sensor_key: 'sensor:65', raw_value: 200, calibrated_value: 30, temperature: 22, electrical_conductivity: 1, device_recorded_at: '2026-01-01T00:00:00Z', server_received_at: '2026-01-01T00:00:00Z' })).filter(row => row.id < before).slice(0, 1000);
    await route.fulfill({ json: data });
  });
  await page.goto(`${harness}?history`);
  await expect(page.getByRole('alert')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByLabel('Reading count')).toHaveText('1203');
  expect(pages).toBe(2);
});

test('assembled demo has one quiet graph, with Groups sharing the time range and Record under More', async ({ page }) => {
  await page.goto('/demo?experiment=experiment-2');
  const presets = page.getByRole('group', { name: 'Time range', exact: true });
  await expect(presets).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: /^History$/ })).toHaveCount(0);
  await expect(page.getByText('Experiment details', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Measurement status' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Experiment sections' })).toHaveCount(0);
  await presets.getByRole('button', { name: '3d', exact: true }).click();
  await expect(presets.getByRole('button', { name: '3d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Groups', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Time range', exact: true }).getByRole('button', { name: '3d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Individual', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Individual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await presets.getByRole('button', { name: 'Entire experiment', exact: true }).click();
  await expect(presets.getByRole('button', { name: 'Entire experiment', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('More', { exact: true }).click();
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await expect(page).toHaveURL(/tab=record/);
  await page.getByText('More', { exact: true }).click();
  await page.getByRole('link', { name: 'Back to traces', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Individual', exact: true })).toBeVisible();
});
