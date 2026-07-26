#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const EXPECTED_READING_COUNT = 858_720;
const EXPECTED_SENSOR_COUNT = 96;
const EXPECTED_FIRST_AT = "2026-03-10T04:01:53.000Z";
const EXPECTED_LAST_AT = "2026-07-15T03:59:57.000Z";
const EXPECTED_READINGS_SHA256 =
  "6592a8ee109609455dd37f3b8ad32ac0e2b1bd25469e5db7ab0382e3e4f02a23";
const EXPECTED_MISSING_POSITIONS = [48, 50, 51, 100];

const args = new Set(process.argv.slice(2));
const archiveArgument = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--"));
const archiveDirectory = resolve(
  archiveArgument ??
    "/Users/ejhowe/Documents/Codex/2026-07-15/i/work/Walker_Pi5_Data_2026-03-10_to_2026-07-14",
);
const importRequested = args.has("--import");

const readingsPath = join(
  archiveDirectory,
  "data",
  "sensor-readings-2026-03-10_to_2026-07-14.csv",
);
const sensorsPath = join(
  archiveDirectory,
  "configuration",
  "api-sensors.json",
);
const pairingsPath = join(
  archiveDirectory,
  "configuration",
  "api-pairings.json",
);
const groupsPath = join(
  archiveDirectory,
  "configuration",
  "api-groups.json",
);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function positionFromPairingName(name) {
  const numeric = /^(\d+)-/.exec(name);
  if (numeric) return Number(numeric[1]);
  const qLabel = /^Q-(\d+)$/.exec(name);
  return qLabel ? Number(qLabel[1]) : null;
}

function nullableNumber(value) {
  return value === "" || value === undefined ? null : Number(value);
}

function utcIso(value) {
  return new Date(`${value.replace(" ", "T")}Z`).toISOString();
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function forEachReading(path, visitor) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let rowIndex = -1;
  for await (const line of lines) {
    rowIndex += 1;
    if (rowIndex === 0) {
      invariant(
        line ===
          "id,sensorId,rawValue,calibratedValue,temperature,electricalConductivity,createdAt,updatedAt",
        "Walker readings CSV header does not match the verified format",
      );
      continue;
    }
    if (!line) continue;
    const fields = line.split(",");
    invariant(fields.length === 8, `Malformed Walker reading at CSV line ${rowIndex + 1}`);
    const row = {
      source_reading_id: Number(fields[0]),
      source_sensor_id: Number(fields[1]),
      raw_value: Number(fields[2]),
      calibrated_value: Number(fields[3]),
      temperature: nullableNumber(fields[4]),
      electrical_conductivity: nullableNumber(fields[5]),
      device_recorded_at: utcIso(fields[6]),
    };
    invariant(
      Number.isSafeInteger(row.source_reading_id) &&
        Number.isInteger(row.source_sensor_id) &&
        Number.isFinite(row.raw_value) &&
        Number.isFinite(row.calibrated_value),
      `Invalid Walker reading at CSV line ${rowIndex + 1}`,
    );
    await visitor(row);
  }
}

function buildCatalog() {
  const sensors = loadJson(sensorsPath);
  const pairings = loadJson(pairingsPath);
  const groups = loadJson(groupsPath);
  invariant(Array.isArray(sensors), "Walker sensor configuration must be an array");
  invariant(Array.isArray(pairings), "Walker pairing configuration must be an array");
  invariant(Array.isArray(groups), "Walker group configuration must be an array");
  invariant(sensors.length === EXPECTED_SENSOR_COUNT, "Expected exactly 96 Walker sensors");
  invariant(pairings.length === EXPECTED_SENSOR_COUNT, "Expected exactly 96 Walker pairings");

  const sensorById = new Map(sensors.map((sensor) => [sensor.id, sensor]));
  const groupById = new Map(groups.map((group) => [group.id, group.name]));
  const seenPairings = new Set();
  const seenSensorIds = new Set();
  const seenValveIds = new Set();

  const catalog = pairings.map((pairing) => {
    const sensor = sensorById.get(pairing.sensorId);
    invariant(sensor, `Pairing ${pairing.name} references an unknown sensor`);
    invariant(!seenPairings.has(pairing.name), `Duplicate pairing ${pairing.name}`);
    invariant(!seenSensorIds.has(pairing.sensorId), `Duplicate sensor ${pairing.sensorId}`);
    invariant(!seenValveIds.has(pairing.valveId), `Duplicate valve ${pairing.valveId}`);
    seenPairings.add(pairing.name);
    seenSensorIds.add(pairing.sensorId);
    seenValveIds.add(pairing.valveId);
    invariant(
      sensor.boardSerialId === pairing.Sensor?.boardSerialId &&
        sensor.address === pairing.Sensor?.address,
      `Pairing ${pairing.name} sensor identity does not match the sensor catalog`,
    );
    const sensorKey = `${sensor.boardSerialId}:${sensor.address}`;
    return {
      source_sensor_id: sensor.id,
      sensor_key: sensorKey,
      display_label: pairing.name,
      source_pairing_name: pairing.name,
      position_number: positionFromPairingName(pairing.name),
      board_serial_id: sensor.boardSerialId,
      sensor_address: sensor.address,
      historical_group:
        pairing.groupId === null ? null : (groupById.get(pairing.groupId) ?? null),
      sensor_type: sensor.type ?? "SDI12",
    };
  });

  const representedPositions = new Set(
    catalog
      .map((item) => item.position_number)
      .filter((position) => Number.isInteger(position)),
  );
  const missingPositions = Array.from({ length: 100 }, (_, index) => index + 1).filter(
    (position) => !representedPositions.has(position),
  );
  invariant(
    JSON.stringify(missingPositions) === JSON.stringify(EXPECTED_MISSING_POSITIONS),
    `Walker position discrepancy changed: ${missingPositions.join(", ")}`,
  );
  invariant(
    catalog.some((item) => item.source_pairing_name === "Q-41"),
    "Expected the Walker Q-41 source label",
  );
  return catalog.sort(
    (left, right) =>
      (left.position_number ?? Number.MAX_SAFE_INTEGER) -
        (right.position_number ?? Number.MAX_SAFE_INTEGER) ||
      left.source_sensor_id - right.source_sensor_id,
  );
}

async function validateArchive(catalog) {
  const digest = await sha256(readingsPath);
  invariant(
    digest === EXPECTED_READINGS_SHA256,
    `Walker readings checksum mismatch: ${digest}`,
  );
  const catalogIds = new Set(catalog.map((item) => item.source_sensor_id));
  const observedIds = new Set();
  let count = 0;
  let firstAt = null;
  let lastAt = null;
  await forEachReading(readingsPath, (row) => {
    invariant(
      catalogIds.has(row.source_sensor_id),
      `Reading ${row.source_reading_id} uses unknown sensor ${row.source_sensor_id}`,
    );
    observedIds.add(row.source_sensor_id);
    count += 1;
    firstAt ??= row.device_recorded_at;
    lastAt = row.device_recorded_at;
  });
  invariant(count === EXPECTED_READING_COUNT, `Expected 858720 readings, found ${count}`);
  invariant(
    observedIds.size === EXPECTED_SENSOR_COUNT,
    `Expected 96 observed sensors, found ${observedIds.size}`,
  );
  invariant(firstAt === EXPECTED_FIRST_AT, `Unexpected first reading ${firstAt}`);
  invariant(lastAt === EXPECTED_LAST_AT, `Unexpected last reading ${lastAt}`);
  return { count, sensorCount: observedIds.size, firstAt, lastAt, digest };
}

function apiConfiguration() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  invariant(url, "SUPABASE_URL is required with --import");
  invariant(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY is required with --import");
  return { url, serviceRoleKey };
}

async function request(api, path, options = {}) {
  const response = await fetch(`${api.url}${path}`, {
    ...options,
    headers: {
      apikey: api.serviceRoleKey,
      authorization: `Bearer ${api.serviceRoleKey}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status} ${path}: ${detail.slice(0, 1000)}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function retryingRequest(api, path, options, attempts = 12) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request(api, path, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(30_000, 750 * 2 ** (attempt - 1))),
      );
    }
  }
  throw lastError;
}

async function importArchive(catalog, validation) {
  const api = apiConfiguration();
  const sensorCatalog = catalog.map((item) => ({
    source_sensor_id: item.source_sensor_id,
    sensor_key: item.sensor_key,
    display_label: item.display_label,
    source_pairing_name: item.source_pairing_name,
    position_number: item.position_number,
    board_serial_id: item.board_serial_id,
    sensor_address: item.sensor_address,
    historical_group: item.historical_group,
    sensor_type: item.sensor_type,
  }));
  const catalogResult = await retryingRequest(
    api,
    "/rest/v1/rpc/walker_observation_import_catalog",
    {
      method: "POST",
      body: JSON.stringify({ sensor_rows: sensorCatalog }),
    },
  );
  invariant(
    catalogResult?.accepted === true && catalogResult?.sensor_count === 96,
    "Walker catalog import was not accepted",
  );

  const catalogById = new Map(catalog.map((item) => [item.source_sensor_id, item]));
  let batch = [];
  let processed = 0;
  let inserted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const result = await retryingRequest(
      api,
      "/rest/v1/rpc/walker_observation_import_readings",
      { method: "POST", body: JSON.stringify({ reading_rows: batch }) },
    );
    inserted += Number(result ?? 0);
    processed += batch.length;
    batch = [];
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    if (processed % 50_000 === 0 || processed === validation.count) {
      process.stdout.write(
        `Walker historical import: ${processed}/${validation.count} validated, ${inserted} new\n`,
      );
    }
  };

  await forEachReading(readingsPath, async (row) => {
    const identity = catalogById.get(row.source_sensor_id);
    batch.push({
      ...row,
      sensor_key: identity.sensor_key,
      pairing_name: identity.source_pairing_name,
    });
    if (batch.length === 1000) await flush();
  });
  await flush();

  for (const [index, sensor] of catalog.entries()) {
    await retryingRequest(
      api,
      "/rest/v1/rpc/walker_observation_finalize_sensor",
      {
        method: "POST",
        body: JSON.stringify({
          selected_source_sensor_id: sensor.source_sensor_id,
        }),
      },
    );
    if ((index + 1) % 12 === 0 || index + 1 === catalog.length) {
      process.stdout.write(
        `Walker aggregate finalization: ${index + 1}/${catalog.length} sensors\n`,
      );
    }
  }

  const result = await retryingRequest(
    api,
    "/rest/v1/rpc/walker_observation_finalize_import",
    { method: "POST", body: "{}" },
  );
  invariant(result?.verified === true, "Walker import did not reconcile as verified");
  return { ...result, insertedThisRun: inserted };
}

const catalog = buildCatalog();
const validation = await validateArchive(catalog);
process.stdout.write(
  `Verified Walker archive: ${validation.count} readings, ${validation.sensorCount} sensors, ` +
    `${validation.firstAt} to ${validation.lastAt}; missing positions ` +
    `${EXPECTED_MISSING_POSITIONS.join(", ")}.\n`,
);

if (importRequested) {
  const result = await importArchive(catalog, validation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write("Validation only; no database writes were made.\n");
}
