import { expect, test } from '@playwright/test';

const mainProject = '22222222-2222-4222-8222-222222222222';
const testbedProject = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = { id: userId, email: 'test@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

for (const email of ['test@example.invalid', 'alamriek@msu.edu']) {
  test(`direct system traces and scoped health for ${email}`, async ({ page }) => {
    page.setDefaultTimeout(15_000);
    const account = { ...user, email };
    const now = new Date().toISOString();
    const walkerStatus = { project_id: '33333333-3333-4333-8333-333333333331', device_id: 'balena:a1c4ace2b367fbee8521f1aff6a6329b', expected_sensor_count: 100, current_sensor_count: 98, evidenced_sensor_count: 100, freshness: 'live', overall_status: 'operational', latest_live_reading_at: now, publisher: { status: 'healthy', last_success_at: now } };
    const walkerExperiments = [
      { id: 'walker-previous', project_id: walkerStatus.project_id, device_id: walkerStatus.device_id, name: 'Previous Walker trial', sensor_ids: [1], started_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
      { id: 'walker-current', project_id: walkerStatus.project_id, device_id: walkerStatus.device_id, name: 'Current Walker trial', sensor_ids: [1], started_at: now, created_at: now },
    ];
    const payload = Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.test`;
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('sb-zmhdclcjrkntrpynozvo-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
    }, { token, user: account });
    const deviceLookups: string[] = [];
    const builderRequests: Array<{ action: string; project_id: string }> = [];
    const calibrationWrites: string[] = [];
    let createdExperiment: Record<string, unknown> | null = null;
    const configPairings = [1, 2].map(number => ({
      name: `Zone1-Pot${number}`, sensorId: number, valveId: number,
      Sensor: { boardSerialId: 'test-sensor', address: String(number) },
      Valve: { relayAddress: 'test-relay', address: String(number) },
      WTCPercentLimit: -1000, ValveOpenTime: 2000, MeasurementInterval: 60000,
    }));
    await page.route('https://*.supabase.co/**', async route => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST' && /commissioning_sessions|controller-command|settings-plan|command-plan/.test(url.pathname)) calibrationWrites.push(url.pathname);
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
      } else if (url.pathname === '/rest/v1/device_config_state') {
        data = url.searchParams.get('select') === '*' ? { pairings: configPairings, groups: [], updated_at: now, config_hash: 'test-config' } : [];
      } else if (url.pathname === '/rest/v1/device_runtime_state' || url.pathname === '/rest/v1/latest_device_state') {
        data = null;
      } else if (url.pathname === '/rest/v1/commissioning_sessions') {
        data = url.searchParams.has('active') ? null : [];
      } else if (url.pathname === '/functions/v1/experiment-builder') {
        const body = route.request().postDataJSON();
        builderRequests.push(body);
        if (body.action === 'preflight') data = { draft: body.draft, plan: { change_count: 0, changes: [], commands: [], pairing_count: body.draft.assignments.length, requires_controller_stop: false, final_controller_state: 'running' }, config_hash: 'test-config', inventory_updated_at: now, validation_messages: [] };
        else if (body.action === 'launch') {
          createdExperiment = { id: 'new-study-id', slug: 'new-study', name: body.draft.name, mode: body.draft.mode, status: 'active', watering_state: 'off', pairing_names: body.draft.assignments.map((assignment: { pairing_name: string }) => assignment.pairing_name), assignments: body.draft.assignments, project_id: body.project_id };
          data = { experiment_slug: 'new-study', experiment_id: 'new-study-id', operation_id: 'test-operation', command_ids: [], status: 'active' };
        }
      } else if (url.pathname === '/rest/v1/portal_experiment_catalog') {
        const project = url.searchParams.get('project_id');
        data = [...(project === `eq.${mainProject}` ? [
          { id: 'completed', slug: 'completed', name: 'Completed experiment', mode: 'observation', status: 'completed', watering_state: 'off', pairing_names: [], assignments: [] },
          { id: 'pan', slug: 'pan', name: 'Huiqiao Pan experiment', mode: 'observation', status: 'active', watering_state: 'off', pairing_names: [], assignments: [] },
        ] : []), ...(createdExperiment && project === `eq.${createdExperiment.project_id}` ? [createdExperiment] : [])];
      } else if (url.pathname === '/rest/v1/walker_observation_sensor_metadata') {
        data = [{ source_sensor_id: 1, display_label: 'Sensor 1', position_number: 1 }];
      } else if (url.pathname === '/rest/v1/walker_portal_experiments') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        data = id ? walkerExperiments.find(experiment => experiment.id === id) : walkerExperiments;
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
    const testbed = page.getByRole('link', { name: 'Open Four-pot testbed', exact: true });
    const rhee = page.getByRole('link', { name: 'Open Rhee Lab', exact: true });
    await expect(testbed).toBeVisible();
    await expect(rhee).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Systems', exact: true })).toHaveCount(0);
    await expect(rhee).toContainText('Huiqiao Pan experiment');
    await expect(testbed).toContainText('No active experiment');
    const walker = page.getByRole('link', { name: 'Open Walker Pi', exact: true });
    await expect(walker).toContainText('Current Walker trial');
    await expect(walker).toHaveAttribute('href', /study=walker-current/);
    await expect(page.locator('.px-system-tile-grid > .px-system-card')).toHaveCount(email === 'alamriek@msu.edu' ? 4 : 3);
    await expect(page.locator('.px-system-tile-grid > .px-system-card > .px-system-tile-footer > .px-system-health-link')).toHaveCount(email === 'alamriek@msu.edu' ? 4 : 3);
    await expect(page.locator('.px-system-tile-icon')).toHaveCount(0);
    await expect(page.getByText(/^(Open traces|Sensing and irrigation|Moisture sensing|Gas mixer and lighting)$/)).toHaveCount(0);
    await expect(page.getByText('Unrelated installation')).toHaveCount(0);
    const health = page.getByRole('link', { name: 'Rhee Lab system health', exact: true });
    const card = rhee.locator('..');
    const tileBox = await card.boundingBox();
    const healthBox = await health.boundingBox();
    expect(healthBox!.y + healthBox!.height).toBeLessThanOrEqual(tileBox!.y + tileBox!.height);
    await expect(card.locator('.px-system-status')).toBeVisible();
    await expect(card.locator('.px-system-experiment-label')).toHaveText('Active experiment');
    const administration = page.locator('details.px-home-administration');
    await expect(administration).not.toHaveAttribute('open');
    await administration.locator('summary').click();
    await expect(administration.getByRole('button', { name: 'Open website analytics' })).toBeVisible();
    await expect(administration.getByText('System Health', { exact: true })).toHaveCount(0);
    await expect(administration.getByText('Autocalibrate', { exact: true })).toHaveCount(0);
    await administration.locator('summary').click();
    await page.screenshot({ path: test.info().outputPath('machine-home-desktop.png'), fullPage: true });
    const rheeCreation = page.getByRole('link', { name: 'New experiment on Rhee Lab', exact: true });
    const testbedCreation = page.getByRole('link', { name: 'New experiment on Four-pot testbed', exact: true });
    await expect(rheeCreation).toHaveAttribute('href', /view=new-experiment/);
    await expect(testbedCreation).toHaveAttribute('href', new RegExp(`view=new-experiment&project=${testbedProject}`));
    await expect(page.getByText('Autocalibrate', { exact: true })).toHaveCount(0);
    await rheeCreation.click();
    await expect(page).toHaveURL(/view=new-experiment/);
    await expect(page.getByRole('heading', { name: 'New experiment', exact: true })).toBeVisible();
    await expect(page.getByText('Rhee Lab', { exact: true })).toBeVisible();
    await page.getByLabel('Experiment name', { exact: true }).fill('Draft with optional calibration');
    await page.getByRole('button', { name: 'Select zone', exact: true }).click();
    await page.getByRole('button', { name: 'Open autocalibration', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Autocalibrate', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose pots', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('optional-autocalibration.png'), fullPage: true });
    expect(calibrationWrites).toEqual([]);
    await page.getByRole('button', { name: 'Back to experiment setup' }).click();
    await expect(page.getByLabel('Experiment name', { exact: true })).toHaveValue('Draft with optional calibration');
    await expect(page.getByText('2 selected · 2 available')).toBeVisible();
    await page.getByRole('button', { name: 'Open autocalibration', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('new-experiment-desktop.png'), fullPage: true });
    await page.getByRole('link', { name: /Home/ }).click();

    await page.getByRole('link', { name: 'New experiment on Walker Pi', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New experiment', exact: true })).toBeVisible();
    await expect(page.getByLabel('Experiment name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create experiment', exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'New experiment', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Home', exact: true }).click();

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
    await expect.poll(() => page.locator('.portal-health-chart > svg:visible').first().evaluate(node => Math.abs(node.clientWidth - (node as SVGSVGElement).viewBox.baseVal.width))).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath('system-health-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Home', exact: true }).click();

    await walker.click();
    await expect(page).toHaveURL(/view=walker/);
    await expect(page.getByRole('combobox', { name: 'Walker experiment', exact: true })).toHaveValue('walker-current');
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
      await expect(page.getByRole('button', { name: 'New experiment on Chamber unavailable', exact: true })).toBeDisabled();
      await page.getByRole('link', { name: 'Chamber system health', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Chamber system health', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Home', exact: true }).click();
    }
    await testbedCreation.click();
    await expect(page).toHaveURL(new RegExp(`view=new-experiment&project=${testbedProject}`));
    await expect(page.getByRole('heading', { name: 'New experiment', exact: true })).toBeVisible();
    await expect(page.getByText('Four-pot testbed', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: /Home/ }).click();
    await rhee.click();
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
    await expect.poll(() => page.locator('.portal-health-chart > svg:visible').first().evaluate(node => Math.abs(node.clientWidth - (node as SVGSVGElement).viewBox.baseVal.width))).toBeLessThan(2);
    const timeLabels = await page.locator('.portal-health-chart > svg:visible').first().locator('.health-chart-time-label').evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
    expect(timeLabels).toHaveLength(2);
    expect(timeLabels[0].right).toBeLessThan(timeLabels[1].left);
    await page.screenshot({ path: test.info().outputPath('system-health-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await testbedCreation.click();
    await page.getByLabel('Experiment name', { exact: true }).fill('Testbed observation trial');
    await page.getByRole('button', { name: 'Observation', exact: false }).click();
    await page.getByRole('button', { name: 'Select zone', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Open autocalibration', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('new-experiment-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'Review experiment', exact: true }).click();
    await page.getByLabel('Apply these settings now.').check();
    await page.getByRole('button', { name: 'Confirm and create', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Experiment created', exact: true })).toBeVisible();
    expect(builderRequests.map(request => [request.action, request.project_id])).toEqual([['preflight', testbedProject], ['launch', testbedProject]]);
    expect(calibrationWrites).toEqual([]);
    await page.getByRole('button', { name: 'View experiment', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Testbed observation trial', exact: true })).toBeVisible();
    await page.getByRole('link', { name: /Home/ }).click();
    await expect(testbed).toContainText('Testbed observation trial');
    await expect(rhee).toContainText('Huiqiao Pan experiment');
  });
}
