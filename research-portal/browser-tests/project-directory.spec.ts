import { expect, test } from '@playwright/test';

const mainProject = '22222222-2222-4222-8222-222222222222';
const testbedProject = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = { id: userId, email: 'test@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

for (const email of ['test@example.invalid', 'alamriek@msu.edu']) {
  test(`direct system traces and scoped health for ${email}`, async ({ page }) => {
    const account = { ...user, email };
    const now = new Date().toISOString();
    const walkerStatus = { expected_sensor_count: 100, current_sensor_count: 98, evidenced_sensor_count: 100, freshness: 'live', overall_status: 'operational', latest_live_reading_at: now, publisher: { status: 'healthy', last_success_at: now } };
    const payload = Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.test`;
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('sb-zmhdclcjrkntrpynozvo-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
    }, { token, user: account });
    const deviceLookups: string[] = [];
    await page.route('https://*.supabase.co/**', async route => {
      const url = new URL(route.request().url());
      let data: unknown = [];
      if (url.pathname === '/auth/v1/user') data = account;
      else if (url.pathname === '/rest/v1/portal_access') data = [
        { project_id: mainProject, role: 'admin', access_scope: 'project', email: account.email, created_at: '2026-01-01T00:00:00Z' },
        { project_id: testbedProject, role: 'admin', access_scope: 'project', email: account.email, created_at: '2026-02-01T00:00:00Z' },
      ];
      else if (url.pathname === '/rest/v1/projects') data = [
        { id: mainProject, name: 'Matt Greenhouse' },
        { id: testbedProject, name: 'Four-pot testbed' },
        { id: 'unrelated', name: 'Unrelated installation' },
      ];
      else if (url.pathname === '/rest/v1/devices') {
        const project = url.searchParams.get('project_id')?.replace(/^eq\./, '') ?? '';
        deviceLookups.push(project);
        data = [{ id: project === testbedProject ? 'testbed-device' : 'main-device' }];
      } else if (url.pathname === '/rest/v1/portal_experiment_catalog' && url.searchParams.get('project_id') === `eq.${mainProject}`) {
        data = [
          { id: 'completed', slug: 'completed', name: 'Completed experiment', mode: 'observation', status: 'completed', watering_state: 'off', pairing_names: [], assignments: [] },
          { id: 'pan', slug: 'pan', name: 'Huiqiao Pan experiment', mode: 'observation', status: 'active', watering_state: 'off', pairing_names: [], assignments: [] },
        ];
      } else if (url.pathname === '/rest/v1/rpc/walker_live_observation_status') {
        data = walkerStatus;
      } else if (url.pathname === '/rest/v1/rpc/walker_live_observation_snapshot') {
        data = { ...walkerStatus, sensors: [], series: [], bucket_seconds: 900, range_start: new Date(Date.now() - 72 * 3600000).toISOString(), range_end: now };
      } else if (url.pathname === '/rest/v1/rpc/gas_mixer_native_status') {
        data = { online: true, last_seen_at: now, remote_control_allowed: true, active_session: false };
      } else if (url.pathname.startsWith('/rest/v1/rpc/')) data = false;
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: JSON.stringify(data) });
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/portal');
    const testbed = page.getByRole('link', { name: /Four-pot testbed.*Open traces/ });
    const rhee = page.getByRole('link', { name: /Rhee Lab.*Open traces/ });
    await expect(testbed).toBeVisible();
    await expect(rhee).toBeVisible();
    await expect(page.locator('.px-system-tile-grid > .px-system-card')).toHaveCount(email === 'alamriek@msu.edu' ? 4 : 3);
    await expect(page.locator('.px-system-tile-grid > .px-system-card > .px-system-health-link')).toHaveCount(email === 'alamriek@msu.edu' ? 4 : 3);
    await expect(page.locator('.px-system-tile-icon')).toHaveCount(0);
    await expect(page.getByText('Unrelated installation')).toHaveCount(0);
    const health = page.getByRole('link', { name: 'Rhee Lab system health', exact: true });
    const tileBox = await rhee.boundingBox();
    const healthBox = await health.boundingBox();
    expect(healthBox!.y).toBeGreaterThanOrEqual(tileBox!.y + tileBox!.height);
    const administration = page.locator('details.px-home-administration');
    await expect(administration).not.toHaveAttribute('open');
    await administration.locator('summary').click();
    await expect(administration.getByRole('button', { name: 'Open website analytics' })).toBeVisible();
    await expect(administration.getByText('System Health', { exact: true })).toHaveCount(0);
    await expect(administration.getByText('Autocalibrate', { exact: true })).toHaveCount(0);
    await administration.locator('summary').click();
    await page.screenshot({ path: test.info().outputPath('machine-home-desktop.png'), fullPage: true });
    const rheeCalibration = page.getByRole('link', { name: 'Rhee Lab Autocalibrate', exact: true });
    const testbedCalibration = page.getByRole('link', { name: 'Four-pot testbed Autocalibrate', exact: true });
    await expect(rheeCalibration).toHaveAttribute('href', /view=autocalibrate/);
    await expect(testbedCalibration).toHaveAttribute('href', new RegExp(`view=autocalibrate&project=${testbedProject}`));
    await expect(page.getByRole('button', { name: 'Walker Pi Autocalibrate unavailable', exact: true })).toBeDisabled();
    await rheeCalibration.click();
    await expect(page).toHaveURL(/view=autocalibrate/);
    await expect(page.getByLabel('Autocalibrate', { exact: true })).toBeVisible();
    await expect(page.getByText('Rhee Lab', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: /Home/ }).click();

    await rhee.click();
    await expect(page.getByRole('heading', { name: 'Huiqiao Pan experiment', exact: true })).toBeVisible();
    await expect(page.getByLabel('Pot traces', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Installation settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Experiments', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('rhee-direct-traces.png'), fullPage: true });
    await page.getByRole('combobox', { name: 'Experiment', exact: true }).selectOption('completed');
    await expect(page).toHaveURL(/experiment=completed/);
    await page.getByRole('link', { name: /Home/ }).click();
    await health.click();
    await expect(page.getByRole('heading', { name: 'Rhee Lab system health', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Home', exact: true }).click();

    await page.getByRole('link', { name: /Walker Pi.*Open traces/ }).click();
    await expect(page).toHaveURL(/view=walker/);
    await expect(page.getByLabel('Walker VWC observation chart')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create experiment on Walker Pi' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Walker VWC observation chart')).toBeVisible();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('link', { name: 'Walker Pi system health', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Walker Pi system health', exact: true })).toBeVisible();
    await expect(page.getByText('98 / 100', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Home', exact: true }).click();

    if (email === 'alamriek@msu.edu') {
      await page.getByRole('link', { name: 'Chamber system health', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Chamber system health', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Home', exact: true }).click();
    }
    await testbedCalibration.click();
    await expect(page).toHaveURL(new RegExp(`view=autocalibrate&project=${testbedProject}`));
    await expect(page.getByLabel('Autocalibrate', { exact: true })).toBeVisible();
    await expect(page.getByText('Four-pot testbed', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: /Home/ }).click();
    await page.getByRole('link', { name: /Rhee Lab.*Open traces/ }).click();
    await page.getByRole('link', { name: /Home/ }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('machine-home-mobile.png'), fullPage: true });
    await testbed.click();
    await expect(page).toHaveURL(new RegExp(`project=${testbedProject}`));
    await expect(page.getByRole('heading', { name: 'Four-pot testbed', exact: true })).toBeVisible();
    await expect(page.getByLabel('Pot traces', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Installation settings', exact: true })).toHaveCount(0);
    expect(deviceLookups).toContain(testbedProject);
    await page.getByRole('link', { name: /Home/ }).click();
    await page.getByRole('link', { name: 'Four-pot testbed system health', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=health&project=${testbedProject}`));
    await expect(page.getByRole('heading', { name: 'Four-pot testbed system health', exact: true })).toBeVisible();
  });
}
