import assert from 'node:assert/strict';
import test from 'node:test';
import { collectConfiguration, publishConfiguration } from '../src/device-config-push.mjs';
import { assertRuntimeConfig, createSupabaseRpcClient, getConfig, refreshOwnerHealthMirror } from '../src/control-executor.mjs';

const base = {
  SUPABASE_URL: 'https://cloud.example.test', SUPABASE_ANON_KEY: 'public-key',
  EXACTH2O_DEVICE_TOKEN: 'command-token', EXACTH2O_INGEST_TOKEN: 'observation-token',
  EXACTH2O_PROJECT_ID: 'project-a', EXACTH2O_DEVICE_ID: 'device-a',
  EXACTH2O_CONTROLLER_COMMAND_SECRET: 'local-secret',
  EXACTH2O_LOCAL_API_BASE: 'http://controller.test/v1', EXACTH2O_STATE_SYNC_MODE: 'device_push',
};
const config = () => getConfig(base);
const snapshot = {
  system: { state: 'STOPPED', configuration: { boardConfigs: [] } },
  pairings: [], calibrations: [], sensors: [], valves: [], groups: [],
};

function transport({ values = snapshot, badPath, result = { ok: true, config_updated: true, project_id: 'project-a', device_id: 'device-a' } } = {}) {
  const calls = [];
  return { calls, fetch: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/rest/v1/rpc/')) return new Response(JSON.stringify(result), { status: 200 });
    const path = new URL(url).pathname.split('/').at(-1);
    return new Response(JSON.stringify(values[path] ?? {}), { status: path === badPath ? 503 : 200 });
  } };
}

test('device push accepts a complete empty new-device snapshot and preserves raw controller values', async () => {
  const t = transport();
  const value = await collectConfiguration(config(), t.fetch);
  assert.equal(value.device_id, 'device-a');
  assert.deepEqual(value.system, snapshot.system);
  assert.deepEqual(value.config, { pairings: [], calibrations: [], sensors: [], valves: [], groups: [], board_config: [] });
  assert.equal(t.calls.length, 6);
  assert.ok(t.calls.every(call => call.options.method === 'GET'));
});

test('one failed or malformed section prevents configuration publication', async () => {
  for (const t of [transport({ badPath: 'sensors' }), transport({ values: { ...snapshot, valves: {} } }), transport({ values: { ...snapshot, system: { state: 'STOPPED' } } })]) {
    await assert.rejects(publishConfiguration(config(), t.fetch));
    assert.ok(t.calls.every(call => !call.url.includes('/rest/v1/rpc/')));
  }
});

test('device push sends only the ingestion token in the RPC body and checks returned scope', async () => {
  const t = transport();
  assert.equal((await publishConfiguration(config(), t.fetch)).ok, true);
  const request = t.calls.at(-1);
  assert.equal(request.url, 'https://cloud.example.test/rest/v1/rpc/device_publish_configuration');
  assert.equal(request.options.headers.Authorization, 'Bearer public-key');
  assert.equal(JSON.parse(request.options.body).device_token, 'observation-token');
  assert.ok(!request.url.includes('observation-token'));
  for (const result of [
    { ok: true, config_updated: true, project_id: 'project-b', device_id: 'device-a' },
    { ok: true, config_updated: true, project_id: 'project-a', device_id: 'device-b' },
    { ok: true, config_updated: false, project_id: 'project-a', device_id: 'device-a' },
  ]) await assert.rejects(publishConfiguration(config(), transport({ result }).fetch));
});

test('push-mode startup needs explicit scope and ingestion credentials in dry and live modes', () => {
  assert.doesNotThrow(() => assertRuntimeConfig(config()));
  const live = getConfig({ ...base, EXACTH2O_CONTROL_EXECUTOR_DRY_RUN: '0' });
  assert.doesNotThrow(() => assertRuntimeConfig(live));
  assert.equal(live.manualWaterEnabled, false);
  assert.equal(live.syncOwnerHealthSecret, '');
  for (const key of ['EXACTH2O_INGEST_TOKEN', 'EXACTH2O_PROJECT_ID', 'EXACTH2O_DEVICE_ID']) {
    assert.throws(() => assertRuntimeConfig(getConfig({ ...base, [key]: '' })), new RegExp(key));
  }
  assert.throws(() => assertRuntimeConfig(getConfig({ ...base, EXACTH2O_STATE_SYNC_MODE: 'unknown' })), /STATE_SYNC_MODE/);
});

test('legacy owner-health mode and its live validation remain the default', () => {
  const c = getConfig({ SUPABASE_URL: base.SUPABASE_URL, SUPABASE_ANON_KEY: 'key', EXACTH2O_DEVICE_TOKEN: 'token' });
  assert.equal(c.stateSyncMode, 'owner_health');
  assert.doesNotThrow(() => assertRuntimeConfig(c));
  assert.throws(() => assertRuntimeConfig({ ...c, dryRun: false }), /SYNC_OWNER_HEALTH_SECRET/);
});

test('both periodic and post-command readback use outbound push with the same device scope', async () => {
  const c = { ...config(), dryRun: false };
  const t = transport();
  assert.equal((await refreshOwnerHealthMirror(null, c, t.fetch)).ok, true);
  assert.equal((await refreshOwnerHealthMirror({ command_type: 'update_pairing', project_id: 'project-a', device_id: 'device-a' }, c, t.fetch)).ok, true);
  assert.equal(t.calls.filter(call => call.url.includes('/rest/v1/rpc/')).length, 2);
  const before = t.calls.length;
  const rejected = await refreshOwnerHealthMirror({ command_type: 'update_pairing', project_id: 'other-project', device_id: 'device-a' }, c, t.fetch);
  assert.equal(rejected.ok, false);
  assert.equal(t.calls.length, before);
  const dry = await refreshOwnerHealthMirror({ command_type: 'update_pairing', project_id: 'project-a', device_id: 'device-a' }, config(), t.fetch);
  assert.equal(dry.reason, 'dry_run');
});

test('readiness recognizes push-mode credentials without declaring live watering enabled', async () => {
  const calls = [];
  const client = createSupabaseRpcClient(config(), async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response('null', { status: 200 });
  });
  await client.reportStatus({ localApiReachable: true, controllerState: 'STOPPED', lastError: null });
  assert.equal(calls[0].executor_sync_ready, true);
  assert.equal(calls[0].executor_dry_run, true);
  assert.equal(calls[0].executor_manual_water_enabled, false);
});
