import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateRawValue,
  initializeObserverState,
  normalizeSensorResponse,
  publishObservationBatch,
  replayPendingBatch,
  retryBounded,
  walkerPublisherIdentity,
  walkerSensorCatalog,
} from "../src/publisher-core.mjs";

function memoryStore(initial = null) {
  let value = initial;
  const writes = [];
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = structuredClone(next);
      writes.push(value);
    },
    value() {
      return value;
    },
    writes,
  };
}

function response(sensor, rawValue = 2111.39) {
  return {
    data: [{
      sensorAddress: sensor.address,
      volumetricWaterContent: rawValue,
      temperature: 28,
      electricalConductivity: 14,
    }],
  };
}

test("catalog is exactly the two verified 48-sensor Walker boards", () => {
  assert.equal(walkerSensorCatalog.length, 96);
  assert.deepEqual(
    [...new Set(walkerSensorCatalog.map((sensor) => sensor.boardSerial))].sort(),
    ["D30GQN2F", "D30GQN2S"],
  );
  assert.deepEqual(
    walkerSensorCatalog
      .map((sensor) => sensor.position)
      .filter((position) => [48, 50, 51, 100].includes(position)),
    [],
  );
  assert.equal(walkerSensorCatalog.find((sensor) => sensor.position === 1)?.sourceSensorId, 770);
  assert.equal(walkerSensorCatalog.find((sensor) => sensor.position === 49)?.sourceSensorId, 769);
  assert.equal(walkerSensorCatalog.find((sensor) => sensor.position === 52)?.sourceSensorId, 817);
  assert.equal(walkerSensorCatalog.find((sensor) => sensor.position === 99)?.sourceSensorId, 818);
});

test("calibrates the probed raw Walker value using the verified polynomial", () => {
  assert.ok(Math.abs(calibrateRawValue(2111.39) - 6.841) < 0.01);
});

test("normalizes only a matching fixed-catalog sensor response", () => {
  const sensor = walkerSensorCatalog[0];
  const reading = normalizeSensorResponse(
    sensor,
    response(sensor),
    1_518_646,
    new Date("2026-07-27T01:45:00Z"),
  );
  assert.equal(reading.source_sensor_id, sensor.sourceSensorId);
  assert.equal(reading.source_reading_id, 1_518_646);
  assert.equal(reading.temperature, 28);
  assert.throws(
    () => normalizeSensorResponse(
      sensor,
      { data: [{ ...response(sensor).data[0], sensorAddress: "z" }] },
      1_518_646,
      new Date(),
    ),
    /address mismatch/,
  );
  assert.throws(
    () => normalizeSensorResponse(
      sensor,
      { data: [] },
      1_518_646,
      new Date(),
    ),
    /exactly one measurement/,
  );
});

test("bootstraps at the verified archive boundary without backfill", async () => {
  const sent = [];
  const store = memoryStore();
  const state = await initializeObserverState({
    sink: { send: async (payload) => sent.push(payload) },
    store,
    publisherInstance: "walker-pi5-a1c4ace2",
    bootstrapCursor: 1_518_645,
    now: () => new Date("2026-07-27T01:45:00Z"),
  });
  assert.equal(state.cursor, 1_518_645);
  assert.equal(state.sourceStream, "walker-sdi12-observer-v1");
  assert.equal(sent[0].kind, "initialize");
  assert.equal(sent[0].readings, undefined);
  assert.equal(sent[0].project_id, walkerPublisherIdentity.projectId);
});

test("persists an exact outbox before append acknowledgement", async () => {
  const sent = [];
  const store = memoryStore();
  const state = {
    version: 2,
    sourceStream: "walker-sdi12-observer-v1",
    projectId: walkerPublisherIdentity.projectId,
    deviceId: walkerPublisherIdentity.deviceId,
    publisherInstance: "walker-pi5-a1c4ace2",
    cursor: 1_518_645,
    acceptedAfter: "2026-07-27T01:40:00.000Z",
    pending: null,
  };
  const next = await publishObservationBatch({
    observations: walkerSensorCatalog.slice(0, 2).map((sensor) => ({
      sensor,
      payload: response(sensor),
    })),
    sink: { send: async (payload) => sent.push(payload) },
    store,
    state,
    now: () => new Date("2026-07-27T01:45:00Z"),
  });
  assert.equal(next.cursor, 1_518_647);
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes[0].cursor, 1_518_645);
  assert.equal(store.writes[0].pending.sourceCursor, 1_518_647);
  assert.equal(store.writes[1].pending, null);
  assert.equal(sent[0].readings.length, 2);
});

test("replays the exact pending payload after an acknowledgement crash", async () => {
  const sensor = walkerSensorCatalog[0];
  const pendingReading = normalizeSensorResponse(
    sensor,
    response(sensor),
    1_518_646,
    new Date("2026-07-27T01:45:00Z"),
  );
  const store = memoryStore();
  const state = {
    version: 2,
    sourceStream: "walker-sdi12-observer-v1",
    projectId: walkerPublisherIdentity.projectId,
    deviceId: walkerPublisherIdentity.deviceId,
    publisherInstance: "walker-pi5-a1c4ace2",
    cursor: 1_518_645,
    acceptedAfter: "2026-07-27T01:40:00.000Z",
    pending: {
      sourceCursor: 1_518_646,
      observedAt: "2026-07-27T01:45:01.000Z",
      readings: [pendingReading],
    },
  };
  const sent = [];
  const next = await replayPendingBatch({
    sink: { send: async (payload) => sent.push(payload) },
    store,
    state,
  });
  assert.equal(next.cursor, 1_518_646);
  assert.deepEqual(sent[0].readings, [pendingReading]);
});

test("leaves the acknowledged cursor unchanged when append fails", async () => {
  const store = memoryStore();
  const state = {
    version: 2,
    sourceStream: "walker-sdi12-observer-v1",
    projectId: walkerPublisherIdentity.projectId,
    deviceId: walkerPublisherIdentity.deviceId,
    publisherInstance: "walker-pi5-a1c4ace2",
    cursor: 1_518_645,
    acceptedAfter: "2026-07-27T01:40:00.000Z",
    pending: null,
  };
  await assert.rejects(
    publishObservationBatch({
      observations: [{
        sensor: walkerSensorCatalog[0],
        payload: response(walkerSensorCatalog[0]),
      }],
      sink: { send: async () => { throw new Error("receiver unavailable"); } },
      store,
      state,
    }),
    /receiver unavailable/,
  );
  assert.equal(store.value().cursor, 1_518_645);
  assert.equal(store.value().pending.sourceCursor, 1_518_646);
});

test("bounds retries and eventually returns the acknowledged response", async () => {
  let calls = 0;
  const result = await retryBounded(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary");
      return "ok";
    },
    { attempts: 4, wait: async () => undefined },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});
