import { expect, test } from '@playwright/test';

const project = '22222222-2222-4222-8222-222222222222';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('active traces are prepared on Home and appear before watering history', async ({ page }, testInfo) => {
  const baseline = process.env.EXACTH2O_TRACE_BASELINE === '1';
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString();
  const user = { id: userId, email: 'test@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: iso(-86_400_000) };
  const payload = Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('sb-zmhdclcjrkntrpynozvo-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
  }, { token: `eyJhbGciOiJIUzI1NiJ9.${payload}.test`, user });
  let archives = 0;
  let wateringFinished = false;
  let analyticsCalls = 0;
  const writes: string[] = [];
  await page.route('https://*.supabase.co/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && !url.pathname.includes('/rpc/') && !url.pathname.endsWith('/website-analytics')) writes.push(url.pathname);
    let data: unknown = [];
    if (url.pathname === '/auth/v1/user') data = user;
    else if (url.pathname.endsWith('/portal_access')) data = [{ project_id: project, role: 'admin', access_scope: 'project', email: user.email, created_at: iso(-86_400_000) }];
    else if (url.pathname.endsWith('/projects')) data = [{ id: project, name: 'Rhee Lab' }];
    else if (url.pathname.endsWith('/devices')) data = [{ id: 'main-device' }];
    else if (url.pathname.endsWith('/device_config_state')) data = url.searchParams.get('select') === '*' ? { pairings: [{ name: 'Zone1-Pot1', sensorId: 1, valveId: 1, Sensor: { boardSerialId: 'test-sensor', address: '1' }, Valve: { relayAddress: 'test-relay', address: '1' }, WTCPercentLimit: -1000, ValveOpenTime: 2000, MeasurementInterval: 60000 }], groups: [], updated_at: iso(0), config_hash: 'test-config' } : [];
    else if (url.pathname.endsWith('/latest_device_state') || url.pathname.endsWith('/device_runtime_state')) data = null;
    else if (url.pathname.endsWith('/portal_experiment_catalog')) data = [{ id: 'pan', slug: 'pan', name: 'Huiqiao Pan experiment', mode: 'observation', status: 'active', watering_state: 'off', started_at: iso(-3_600_000), pairing_names: ['Zone1-Pot1'], assignments: [{ pairing_name: 'Zone1-Pot1', zone: 1, pot_number: 1, measurement_interval_minutes: 1 }] }];
    else if (url.pathname.endsWith('/experiment_assignments')) data = [{ pairing_name: 'Zone1-Pot1' }];
    else if (url.pathname.endsWith('/sensor_readings')) {
      if (url.searchParams.has('pairing_name')) {
        archives++;
        await new Promise(resolve => setTimeout(resolve, 600));
        data = [1, 2, 3].map((n) => ({ id: n, event_id: `live-device:${n}`, pairing_name: 'Zone1-Pot1', sensor_key: 'test-sensor:1', raw_value: 30 + n, calibrated_value: 30 + n, temperature: null, electrical_conductivity: null, device_recorded_at: iso(-n * 60_000), server_received_at: iso(-n * 60_000) }));
      } else data = url.searchParams.get('select') === 'id, server_received_at' ? [{ id: 1, server_received_at: iso(0) }] : [];
    } else if (url.pathname.endsWith('/valve_events') && url.searchParams.has('pairing_name')) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      wateringFinished = true;
    } else if (url.pathname.endsWith('/website-analytics')) {
      analyticsCalls++;
      data = { status: 'ready', visitors: 5, demoClicks: 0, demoInteractionSessions: 2, quoteClicks: 0, inquiries: 0, inquirySource: 'server', updatedAt: iso(0), days: [{ date: iso(0).slice(0, 10), visitors: 1 }] };
    } else if (url.pathname.includes('/rpc/')) data = false;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: JSON.stringify(data) });
  });
  await page.goto(process.env.EXACTH2O_TRACE_ORIGIN ? `${process.env.EXACTH2O_TRACE_ORIGIN}/portal` : '/portal');
  const tile = page.getByRole('link', { name: 'Open Rhee Lab', exact: true });
  await expect(tile).toContainText('Huiqiao Pan experiment');
  if (!baseline) {
    await expect.poll(() => archives).toBe(1);
    // Let the first 600 ms reading response arrive while watering remains outstanding.
    await page.waitForTimeout(750);
  }
  const started = Date.now();
  await tile.click();
  await expect(page.getByRole('group', { name: /^Soil moisture .*for 1 pot/ })).toBeVisible();
  const elapsed = Date.now() - started;
  console.log(JSON.stringify({ baseline, clickToTraceMs: elapsed, archives, wateringFinished }));
  await testInfo.attach('trace-timing', { body: JSON.stringify({ baseline, clickToTraceMs: elapsed, archives, wateringFinished }), contentType: 'application/json' });
  if (!baseline) {
    expect(elapsed).toBeLessThan(1000);
    expect(wateringFinished).toBe(false);
    expect(archives).toBe(1); // Home → traces must not cancel or repeat the same archive.
    await expect(page.getByText('Loading full history… 3 readings')).toBeVisible();
  }
  await expect.poll(() => wateringFinished).toBe(true);
  await expect(page.getByText(/Loading (?:full history|experiment data)…/)).toHaveCount(0);
  await page.getByRole('link', { name: /Home/ }).click();
  const admin = page.locator('details.px-home-administration');
  await admin.locator('summary').click();
  if (!baseline) {
    await expect(admin.getByText('Unique visitors', { exact: true })).toBeVisible();
    await expect(admin.getByText('Demo sessions', { exact: true }).locator('..')).toContainText('2');
    await expect(admin.locator('time')).toHaveAttribute('datetime', iso(0));
    const before = analyticsCalls;
    await admin.getByRole('button', { name: 'Refresh website analytics', exact: true }).click();
    await expect.poll(() => analyticsCalls).toBe(before + 1);
    await expect(admin.getByRole('button', { name: 'Refresh website analytics' })).toBeEnabled();
    await expect(admin.getByRole('button', { name: 'This browser excluded' })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.screenshot({ path: testInfo.outputPath('analytics-freshness.png'), fullPage: true });
  expect(writes).toEqual([]);
});
