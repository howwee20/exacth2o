import { expect, test } from '@playwright/test';

const mainProject = '22222222-2222-4222-8222-222222222222';
const testbedProject = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = { id: userId, email: 'test@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

for (const email of ['test@example.invalid', 'alamriek@msu.edu']) {
test(`machine home and project switching for ${email}`, async ({ page }) => {
  const account = { ...user, email };
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
      // Extra returned rows must not become a client-side navigation grant.
      { id: 'unrelated', name: 'Unrelated installation' },
    ];
    else if (url.pathname === '/rest/v1/devices') {
      const project = url.searchParams.get('project_id')?.replace(/^eq\./, '') ?? '';
      deviceLookups.push(project);
      data = [{ id: project === testbedProject ? 'testbed-device' : 'main-device' }];
    } else if (url.pathname === '/rest/v1/rpc/walker_live_observation_status') {
      data = { expected_sensor_count: 100, current_sensor_count: 98 };
    } else if (url.pathname.startsWith('/rest/v1/rpc/')) data = false;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: JSON.stringify(data) });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/portal');
  const testbed = page.getByRole('link', { name: /Four-pot testbed/ });
  await expect(testbed).toBeVisible();
  await expect(page.getByRole('link', { name: /Rhee Lab Sensing and irrigation/ })).toBeVisible();
  await expect(page.locator('.px-system-tile-grid > a')).toHaveCount(email === 'alamriek@msu.edu' ? 4 : 3);
  await expect(page.getByRole('link', { name: /Chamber/ })).toHaveCount(email === 'alamriek@msu.edu' ? 1 : 0);
  await expect(page.locator('.px-system-tile-icon')).toHaveCount(0);
  await expect(page.locator('.px-system-tile-grid .px-system-section')).toHaveCount(0);
  const administration = page.locator('details.px-home-administration');
  await expect(administration).not.toHaveAttribute('open');
  await expect(administration.getByRole('button', { name: 'Open website analytics' })).toBeHidden();
  await administration.locator('summary').click();
  await expect(administration.getByRole('button', { name: 'Open website analytics' })).toBeVisible();
  await expect(administration.getByText('System Health', { exact: true })).toBeVisible();
  await expect(administration.getByText('Autocalibrate', { exact: true })).toBeVisible();
  await expect(page.getByText('Unrelated installation')).toHaveCount(0);
  await administration.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(administration).not.toHaveAttribute('open');
  await page.screenshot({ path: test.info().outputPath('machine-home-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: /Walker Pi/ }).click();
  await expect(page).toHaveURL(/view=walker-home/);
  await expect(page.getByRole('button', { name: 'Create experiment on Walker Pi' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Create experiment on Walker Pi' })).toBeVisible();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(testbed).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('machine-home-mobile.png'), fullPage: true });
  await testbed.click();
  await expect(page).toHaveURL(new RegExp(`project=${testbedProject}`));
  await expect(page).toHaveURL(/view=controller/);
  await expect(page.getByRole('heading', { name: 'Four-pot testbed', exact: true })).toBeVisible();
  await expect(page.getByText('Awaiting first connection', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Autocalibrate →', exact: true })).toBeVisible();
  expect(deviceLookups).toContain(testbedProject);
  await expect(page.getByText('Online', { exact: true })).toHaveCount(0);
});
}
