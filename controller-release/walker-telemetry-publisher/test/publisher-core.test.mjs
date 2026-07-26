import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeAtSourceTail,
  normalizeSourceReading,
  publishCycle,
  retryBounded,
  walkerPublisherIdentity,
} from "../src/publisher-core.mjs";

function memoryStore(initial = null) {
  let value = initial;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = structuredClone(next);
    },
    value() {
      return value;
    },
  };
}

test("tail bootstrap skips every pre-existing drought/archive row", async () => {
  const sent = [];
  const store = memoryStore();
  const state = await initializeAtSourceTail({
    source: { latestId: async () => 1_518_645 },
    sink: { send: async (payload) => sent.push(payload) },
    store,
    publisherInstance: "walker-pi5-a1c4ace2",
    now: () => new Date("2026-07-26T19:00:00Z"),
  });
  assert.equal(state.cursor, 1_518_645);
  assert.equal(sent[0].kind, "initialize");
  assert.equal(sent[0].readings, undefined);
  assert.equal(sent[0].project_id, walkerPublisherIdentity.projectId);
  assert.equal(store.value().acceptedAfter, "2026-07-26T19:00:00.000Z");
});

test("publishes new rows in bounded batches and persists only acknowledged cursors", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: 101 + index,
    sensorId: 746 + index,
    rawValue: 1200 + index,
    calibratedValue: 25 + index,
    temperature: null,
    electricalConductivity: null,
    createdAt: new Date(`2026-07-26T19:0${index}:00Z`),
  }));
  const sent = [];
  const writes = [];
  const store = {
    async write(value) {
      writes.push(value.cursor);
    },
  };
  const result = await publishCycle({
    source: {
      latestId: async () => 105,
      after: async (cursor, limit) =>
        rows.filter((row) => row.id > cursor).slice(0, limit),
    },
    sink: { send: async (payload) => sent.push(payload) },
    store,
    state: {
      version: 1,
      projectId: walkerPublisherIdentity.projectId,
      deviceId: walkerPublisherIdentity.deviceId,
      publisherInstance: "walker-pi5-a1c4ace2",
      cursor: 100,
      acceptedAfter: "2026-07-26T19:00:00.000Z",
    },
    batchSize: 2,
    maxRowsPerCycle: 4,
    now: () => new Date("2026-07-26T19:10:00Z"),
  });
  assert.equal(result.published, 4);
  assert.equal(result.caughtUp, false);
  assert.deepEqual(sent.map((payload) => payload.source_cursor), [102, 104]);
  assert.deepEqual(writes, [102, 104]);
});

test("does not advance the durable cursor when the receiver rejects a batch", async () => {
  const writes = [];
  await assert.rejects(
    publishCycle({
      source: {
        latestId: async () => 101,
        after: async () => [{
          id: 101,
          sensorId: 746,
          rawValue: 1200,
          calibratedValue: 25,
          temperature: null,
          electricalConductivity: null,
          createdAt: new Date("2026-07-26T19:01:00Z"),
        }],
      },
      sink: { send: async () => { throw new Error("receiver unavailable"); } },
      store: { write: async (value) => writes.push(value.cursor) },
      state: {
        publisherInstance: "walker-pi5-a1c4ace2",
        cursor: 100,
      },
    }),
    /receiver unavailable/,
  );
  assert.deepEqual(writes, []);
});

test("rejects uncalibrated rows instead of fabricating VWC", () => {
  assert.throws(
    () => normalizeSourceReading({
      id: 101,
      sensorId: 746,
      rawValue: 1200,
      calibratedValue: null,
      createdAt: new Date("2026-07-26T19:01:00Z"),
    }),
    /calibrated value/,
  );
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
