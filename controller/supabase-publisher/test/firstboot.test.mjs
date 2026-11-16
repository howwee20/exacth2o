import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, reconcileOnce } from '../src/publisher.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-firstboot-'));
  const original = globalThis.fetch;
  const calls = [];
  const config = { apiBase: 'http://local/v1', supabaseUrl: 'http://cloud', anonKey: 'test-anon',
    deviceToken: 'test-device-token', deviceId: 'testbed', bootstrapCursorId: 0,
    statePath: join(directory, 'state.json'), healthPath: join(directory, 'health.json'),
    requestTimeoutMs: 1000, pageSize: 10, maxPagesPerPass: 1, ingestBatchSize: 10 };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/pairings')) return Response.json([]);
    if (String(url).includes('/rpc/device_ingest')) return Response.json({ ok: true, device_id: 'testbed', inserted_readings: 0, duplicate_events: 0 });
    return Response.json({ data: [], pagination: { totalPages: 0 } });
  };
  try { await run({ config, calls }); }
  finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
}

test('empty first-boot database sends an authenticated heartbeat with zero readings', async () => fixture(async ({ config, calls }) => {
  const state = await initializeState(config, {});
  await reconcileOnce(config, state, {});
  const sent = calls.filter(call => call.url.endsWith('/rpc/device_ingest'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.headers.apikey, 'test-anon');
  const body = JSON.parse(sent[0].options.body);
  assert.equal(body.device_token, 'test-device-token');
  assert.equal(body.payload.device_id, 'testbed');
  assert.deepEqual(body.payload.events, []);
  assert.ok(Number.isFinite(Date.parse(body.payload.sent_at)));
  assert.ok(Date.parse(body.payload.sent_at) <= Date.parse(state.lastSuccessAt));
  assert.equal(state.cursorId, 0);
  assert.equal(state.uploadedEvents, 0);
  assert.equal(state.pending, false);
  assert.deepEqual(state.lastPass, { checked: 0, uploaded: 0, duplicateEvents: 0 });
  const health = JSON.parse(await readFile(config.healthPath, 'utf8'));
  assert.equal(health.ok, true);
  assert.equal(health.lastSuccessAt, state.lastSuccessAt);
}));

test('an empty reset database starts a new durable generation without inventing an event', async () => fixture(async ({ config, calls }) => {
  const state = { cursorId: 99, cursorRecordedAt: '2026-01-01T00:00:00Z', epoch: 'old-generation', uploadedEvents: 4, duplicateEvents: 0 };
  await reconcileOnce(config, state, {});
  assert.notEqual(state.epoch, 'old-generation');
  assert.equal(state.cursorId, 0);
  const epoch = state.epoch;
  assert.equal(JSON.parse(await readFile(config.statePath, 'utf8')).epoch, epoch);
  await reconcileOnce(config, state, {});
  assert.equal(state.epoch, epoch);
  assert.ok(calls.filter(call => call.url.endsWith('/rpc/device_ingest')).every(call => JSON.parse(call.options.body).payload.events.length === 0));
}));

for (const kind of ['readings HTTP failure', 'pairings HTTP failure', 'malformed readings', 'malformed reading row', 'malformed pairings', 'ingest HTTP failure']) {
  test(`${kind} cannot become a healthy empty heartbeat`, async () => fixture(async ({ config, calls }) => {
    const normalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const path = String(url);
      if (kind === 'readings HTTP failure' && path.includes('/readings?')) return new Response('unavailable', { status: 503 });
      if (kind === 'pairings HTTP failure' && path.endsWith('/pairings')) return new Response('unavailable', { status: 503 });
      if (kind === 'malformed readings' && path.includes('/readings?')) return Response.json({ error: 'not a row list' });
      if (kind === 'malformed reading row' && path.includes('/readings?')) return Response.json({ data: [null] });
      if (kind === 'malformed pairings' && path.endsWith('/pairings')) return Response.json({ error: 'not a row list' });
      if (kind === 'ingest HTTP failure' && path.endsWith('/rpc/device_ingest')) return new Response('unauthorized', { status: 401 });
      return normalFetch(url, options);
    };
    const state = await initializeState(config, {});
    await assert.rejects(reconcileOnce(config, state, {}));
    assert.equal(state.lastSuccessAt, undefined);
    await assert.rejects(readFile(config.healthPath), { code: 'ENOENT' });
    if (kind !== 'ingest HTTP failure') assert.equal(calls.filter(call => call.url.endsWith('/rpc/device_ingest')).length, 0);
  }));
}
