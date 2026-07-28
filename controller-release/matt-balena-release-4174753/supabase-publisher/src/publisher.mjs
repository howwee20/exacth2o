import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DEVICE_ID = "3100e37ee3205651fe3dd86dafd4dc0c";

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function legacyCursorId(state) {
  if (Number.isInteger(Number(state?.cursorId))) {
    return Number(state.cursorId);
  }

  const ids = Array.isArray(state?.sentEventIds)
    ? state.sentEventIds
        .map((eventId) => Number(String(eventId).split(":").at(-1)))
        .filter(Number.isFinite)
    : [];

  return ids.length > 0 ? Math.max(...ids) : 0;
}

export function pairingNameAt(reading, currentPairing, pairingHistory) {
  const sensorId = Number(reading.sensorId);
  const recordedAt = Date.parse(reading.createdAt);
  let name = currentPairing?.name ?? null;

  for (const change of pairingHistory?.changes ?? []) {
    const changedAt = Date.parse(change.changedAt);
    const mapping = (change.mappings ?? []).find(
      (candidate) => Number(candidate.sensorId) === sensorId,
    );
    if (!mapping || !Number.isFinite(changedAt) || !Number.isFinite(recordedAt)) {
      continue;
    }
    name =
      recordedAt < changedAt
        ? mapping.beforePairingName
        : mapping.afterPairingName;
  }

  return name;
}

function sensorKey(pairing) {
  if (!pairing) return null;
  if (pairing.sensor_key) return pairing.sensor_key;
  const board = pairing.Sensor?.boardSerialId;
  const address = pairing.Sensor?.address;
  return board && address ? `${board}:${address}` : null;
}

export function readingEvent(row, pairing, pairingHistory) {
  return {
    event_id: `live-device:reading:${row.id}`,
    type: "sensor_reading",
    source_sensor_id: Number(row.sensorId),
    pairing_name: pairingNameAt(row, pairing, pairingHistory),
    sensor_key: sensorKey(pairing),
    recorded_at: row.createdAt,
    raw_value: row.rawValue,
    calibrated_value: row.calibratedValue,
    temperature: row.temperature,
    electrical_conductivity: row.electricalConductivity,
    unit: "vwc_pct",
    quality_flags: {
      source: "balena_managed_supabase_publisher",
      local_reading_id: Number(row.id),
    },
  };
}

export function selectOldestUnseenRows(
  pageResults,
  cursorId,
  snapshotId,
) {
  const rowsById = new Map();
  for (const result of pageResults) {
    for (const row of Array.isArray(result?.data) ? result.data : []) {
      const id = Number(row.id);
      if (id > cursorId && id <= snapshotId) rowsById.set(id, row);
    }
  }
  return [...rowsById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

function makeConfig() {
  return {
    apiBase:
      process.env.EXACTH2O_LOCAL_API_BASE || "http://api_svc:8888/v1",
    supabaseUrl:
      process.env.EXACTH2O_PUBLISHER_SUPABASE_URL ||
      process.env.SUPABASE_URL,
    anonKey:
      process.env.EXACTH2O_PUBLISHER_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY,
    deviceToken:
      process.env.EXACTH2O_PUBLISHER_DEVICE_TOKEN ||
      process.env.EXACTH2O_DEVICE_TOKEN,
    deviceId: process.env.EXACTH2O_DEVICE_ID || DEFAULT_DEVICE_ID,
    statePath:
      process.env.EXACTH2O_PUBLISHER_STATE || "/data/publisher-state.json",
    healthPath:
      process.env.EXACTH2O_PUBLISHER_HEALTH || "/data/publisher-health.json",
    pairingHistoryPath:
      process.env.EXACTH2O_PAIRING_HISTORY_PATH ||
      "/app/config/pairing-history.json",
    bootstrapCursorId: Math.max(
      0,
      Number.parseInt(
        process.env.EXACTH2O_PUBLISHER_BOOTSTRAP_CURSOR_ID || "0",
        10,
      ) || 0,
    ),
    publishIntervalMs: positiveInteger(
      process.env.EXACTH2O_PUBLISH_INTERVAL_MS,
      30000,
      3600000,
    ),
    catchupDelayMs: positiveInteger(
      process.env.EXACTH2O_PUBLISHER_CATCHUP_DELAY_MS,
      1000,
      60000,
    ),
    retryMinMs: positiveInteger(
      process.env.EXACTH2O_PUBLISHER_RETRY_MIN_MS,
      2000,
      60000,
    ),
    retryMaxMs: positiveInteger(
      process.env.EXACTH2O_PUBLISHER_RETRY_MAX_MS,
      60000,
      600000,
    ),
    requestTimeoutMs: positiveInteger(
      process.env.EXACTH2O_PUBLISHER_REQUEST_TIMEOUT_MS,
      30000,
      120000,
    ),
    pageSize: positiveInteger(
      process.env.EXACTH2O_READINGS_PAGE_SIZE,
      500,
      1000,
    ),
    maxPagesPerPass: positiveInteger(
      process.env.EXACTH2O_RECONCILE_MAX_PAGES,
      4,
      20,
    ),
    ingestBatchSize: positiveInteger(
      process.env.EXACTH2O_INGEST_BATCH_SIZE,
      200,
      1000,
    ),
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push("EXACTH2O_PUBLISHER_SUPABASE_URL");
  if (!config.anonKey) missing.push("EXACTH2O_PUBLISHER_SUPABASE_ANON_KEY");
  if (!config.deviceToken) missing.push("EXACTH2O_PUBLISHER_DEVICE_TOKEN");
  if (missing.length > 0) {
    throw new Error(`missing publisher configuration: ${missing.join(", ")}`);
  }
}

function requestWithTimeout(config, url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
}

async function localGet(config, path) {
  const response = await requestWithTimeout(config, `${config.apiBase}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return response.json();
}

async function localPost(config, path, body) {
  const response = await requestWithTimeout(
    config,
    `${config.apiBase}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status}`);
  }
  return response.json();
}

async function ingest(config, events) {
  const response = await requestWithTimeout(
    config,
    `${config.supabaseUrl}/rest/v1/rpc/device_ingest`,
    {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_token: config.deviceToken,
        payload: {
          device_id: config.deviceId,
          sent_at: new Date().toISOString(),
          events,
        },
      }),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`device_ingest failed: ${response.status} ${detail}`);
  }
  return response.json();
}

function pairingMap(pairingsResponse) {
  const pairings = Array.isArray(pairingsResponse)
    ? pairingsResponse
    : pairingsResponse?.data ?? [];
  return new Map(
    pairings.map((pairing) => [Number(pairing.sensorId), pairing]),
  );
}

async function cursorRecordedAt(config, cursorId) {
  if (cursorId <= 0) return null;
  const reading = await localGet(config, `/readings/${cursorId}`);
  return reading.createdAt;
}

async function initializeState(config, state) {
  let cursorId = legacyCursorId(state);
  if (cursorId <= 0) cursorId = config.bootstrapCursorId;

  if (cursorId <= 0) {
    const latest = await localGet(config, "/readings?page=1&pageSize=1");
    const latestRow = latest?.data?.[0];
    cursorId = Number(latestRow?.id || 0);
    return {
      version: 2,
      cursorId,
      cursorRecordedAt: latestRow?.createdAt ?? null,
      initializedAtLatest: true,
      uploadedEvents: 0,
      duplicateEvents: 0,
    };
  }

  return {
    version: 2,
    cursorId,
    cursorRecordedAt:
      state?.cursorRecordedAt || (await cursorRecordedAt(config, cursorId)),
    migratedLegacyState: Array.isArray(state?.sentEventIds),
    uploadedEvents: Number(state?.uploadedEvents || 0),
    duplicateEvents: Number(state?.duplicateEvents || 0),
    lastSuccessAt: state?.lastSuccessAt || state?.lastUploadedAt || null,
  };
}

async function filteredPage(
  config,
  cursorAt,
  snapshotAt,
  page,
) {
  return localPost(config, "/readings/filtered", {
    startDate: cursorAt,
    endDate: snapshotAt,
    page,
    pageSize: config.pageSize,
  });
}

async function writeHealth(config, state, extra = {}) {
  await writeJsonAtomic(config.healthPath, {
    ok: true,
    checkedAt: new Date().toISOString(),
    lastSuccessAt: state.lastSuccessAt,
    cursorId: state.cursorId,
    latestKnownId: state.latestKnownId,
    pending: state.pending,
    consecutiveFailures: 0,
    ...extra,
  });
}

async function writeFailureHealth(config, state, error, consecutiveFailures) {
  await writeJsonAtomic(config.healthPath, {
    ok: false,
    checkedAt: new Date().toISOString(),
    lastSuccessAt: state?.lastSuccessAt ?? null,
    cursorId: state?.cursorId ?? null,
    latestKnownId: state?.latestKnownId ?? null,
    pending: state?.pending ?? null,
    consecutiveFailures,
    lastError: error instanceof Error ? error.message : String(error),
  });
}

export async function reconcileOnce(config, state, pairingHistory) {
  validateConfig(config);
  if (!state.cursorRecordedAt && state.cursorId > 0) {
    state.cursorRecordedAt = await cursorRecordedAt(config, state.cursorId);
  }
  const [latestResponse, pairingsResponse] = await Promise.all([
    localGet(config, "/readings?page=1&pageSize=1"),
    localGet(config, "/pairings"),
  ]);
  const snapshot = latestResponse?.data?.[0];
  if (!snapshot) throw new Error("local readings endpoint returned no rows");

  state.latestKnownId = Number(snapshot.id);
  if (state.cursorId >= state.latestKnownId) {
    const result = await ingest(config, []);
    state.lastSuccessAt = new Date().toISOString();
    state.pending = false;
    state.lastResult = result;
    state.lastPass = { checked: 0, uploaded: 0, duplicateEvents: 0 };
    await writeJsonAtomic(config.statePath, state);
    await writeHealth(config, state);
    return state;
  }

  const firstPage = await filteredPage(
    config,
    state.cursorRecordedAt,
    snapshot.createdAt,
    1,
  );
  const totalPages = positiveInteger(firstPage?.pagination?.totalPages, 1);
  const firstOldestPage = Math.max(
    1,
    totalPages - config.maxPagesPerPass + 1,
  );
  const pageNumbers = [];
  for (let page = totalPages; page >= firstOldestPage; page -= 1) {
    pageNumbers.push(page);
  }
  const pageResults = await Promise.all(
    pageNumbers.map((page) =>
      page === 1 && totalPages === 1
        ? firstPage
        : filteredPage(
            config,
            state.cursorRecordedAt,
            snapshot.createdAt,
            page,
          ),
    ),
  );
  const rows = selectOldestUnseenRows(
    pageResults,
    state.cursorId,
    state.latestKnownId,
  );
  if (rows.length === 0) {
    throw new Error(
      `reconciliation made no progress: cursor=${state.cursorId} latest=${state.latestKnownId}`,
    );
  }

  const bySensorId = pairingMap(pairingsResponse);
  let uploaded = 0;
  let duplicateEvents = 0;
  let lastResult = null;
  for (let offset = 0; offset < rows.length; offset += config.ingestBatchSize) {
    const batch = rows.slice(offset, offset + config.ingestBatchSize);
    const events = batch.map((row) =>
      readingEvent(row, bySensorId.get(Number(row.sensorId)), pairingHistory),
    );
    lastResult = await ingest(config, events);
    uploaded += Number(lastResult?.inserted_readings ?? events.length);
    duplicateEvents += Number(lastResult?.duplicate_events ?? 0);
    const lastRow = batch.at(-1);
    state.cursorId = Number(lastRow.id);
    state.cursorRecordedAt = lastRow.createdAt;
    state.uploadedEvents += Number(lastResult?.inserted_readings ?? 0);
    state.duplicateEvents += Number(lastResult?.duplicate_events ?? 0);
    state.lastSuccessAt = new Date().toISOString();
    state.pending = state.cursorId < state.latestKnownId;
    state.lastResult = lastResult;
    await writeJsonAtomic(config.statePath, state);
  }

  state.lastPass = {
    checked: rows.length,
    uploaded,
    duplicateEvents,
    pages: pageNumbers.length,
    snapshotId: Number(snapshot.id),
  };
  await writeJsonAtomic(config.statePath, state);
  await writeHealth(config, state, { lastPass: state.lastPass });
  return state;
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const config = makeConfig();
  const pairingHistory = await readJson(config.pairingHistoryPath, {
    changes: [],
  });
  let stopping = false;
  let consecutiveFailures = 0;
  let retryMs = config.retryMinMs;
  let state = null;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });

  const savedState = await readJson(config.statePath, {});
  while (!stopping && !state) {
    try {
      validateConfig(config);
      state = await initializeState(config, savedState);
      await writeJsonAtomic(config.statePath, state);
    } catch (error) {
      consecutiveFailures += 1;
      await writeFailureHealth(
        config,
        savedState,
        error,
        consecutiveFailures,
      );
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          phase: "startup",
          consecutiveFailures,
          retryMs,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      await sleep(retryMs);
      retryMs = Math.min(config.retryMaxMs, retryMs * 2);
    }
  }
  if (!state) return;

  process.stdout.write(
    `${JSON.stringify({
      service: "supabase_publisher",
      deviceId: config.deviceId,
      apiBase: config.apiBase,
      cursorId: state.cursorId,
      pageSize: config.pageSize,
      maxPagesPerPass: config.maxPagesPerPass,
      ingestBatchSize: config.ingestBatchSize,
    })}\n`,
  );
  consecutiveFailures = 0;
  retryMs = config.retryMinMs;

  while (!stopping) {
    try {
      state = await reconcileOnce(config, state, pairingHistory);
      consecutiveFailures = 0;
      retryMs = config.retryMinMs;
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          cursorId: state.cursorId,
          latestKnownId: state.latestKnownId,
          pending: state.pending,
          lastPass: state.lastPass,
          lastResult: state.lastResult,
        })}\n`,
      );
      await sleep(state.pending ? config.catchupDelayMs : config.publishIntervalMs);
    } catch (error) {
      consecutiveFailures += 1;
      await writeFailureHealth(
        config,
        state,
        error,
        consecutiveFailures,
      );
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          consecutiveFailures,
          retryMs,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      await sleep(retryMs);
      retryMs = Math.min(config.retryMaxMs, retryMs * 2);
    }
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  });
}
