import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeSecretMatch,
  parseWalkerTelemetryEnvelope,
  walkerTelemetryIdentity,
  walkerTelemetryRpc,
} from "./receiver-policy.mjs";

const base = {
  project_id: walkerTelemetryIdentity.projectId,
  device_id: walkerTelemetryIdentity.deviceId,
  source_cursor: 900,
  source_latest_known: 900,
  observed_at: "2026-07-26T18:00:00Z",
  publisher_instance: "walker-pi5-a1c4ace2",
};

test("accepts only the fixed Walker installation identity", () => {
  assert.throws(
    () => parseWalkerTelemetryEnvelope({
      ...base,
      kind: "heartbeat",
      device_id: "plain-feather",
    }),
    /identity mismatch/,
  );
});

test("maps an initialization to the tail-bootstrap RPC", () => {
  const envelope = parseWalkerTelemetryEnvelope({ ...base, kind: "initialize" });
  assert.deepEqual(walkerTelemetryRpc(envelope), {
    name: "walker_live_initialize_ingest",
    args: {
      source_cursor: 900,
      source_latest_known: 900,
      observed_at: "2026-07-26T18:00:00.000Z",
      publisher_instance: "walker-pi5-a1c4ace2",
    },
  });
});

test("normalizes a bounded append-only reading batch", () => {
  const envelope = parseWalkerTelemetryEnvelope({
    ...base,
    kind: "append",
    readings: [{
      source_reading_id: 900,
      source_sensor_id: 746,
      raw_value: 1234,
      calibrated_value: 27.4,
      temperature: 22.1,
      electrical_conductivity: null,
      device_recorded_at: "2026-07-26T17:59:00Z",
      source_created_at: "2026-07-26T17:59:01Z",
    }],
  });
  const rpc = walkerTelemetryRpc(envelope);
  assert.equal(rpc.name, "ingest_walker_live_telemetry_batch");
  assert.equal(rpc.args.reading_rows.length, 1);
  assert.equal(rpc.args.reading_rows[0].source_sensor_id, 746);
});

test("rejects cursor jumps and non-finite sensor values", () => {
  assert.throws(
    () => parseWalkerTelemetryEnvelope({
      ...base,
      kind: "append",
      readings: [{
        source_reading_id: 899,
        source_sensor_id: 746,
        raw_value: 1234,
        calibrated_value: 27.4,
        device_recorded_at: "2026-07-26T17:59:00Z",
        source_created_at: "2026-07-26T17:59:01Z",
      }],
    }),
    /cursor/,
  );
  assert.throws(
    () => parseWalkerTelemetryEnvelope({
      ...base,
      kind: "append",
      readings: [{
        source_reading_id: 900,
        source_sensor_id: 746,
        raw_value: "NaN",
        calibrated_value: 27.4,
        device_recorded_at: "2026-07-26T17:59:00Z",
        source_created_at: "2026-07-26T17:59:01Z",
      }],
    }),
    /invalid reading/,
  );
});

test("checks publisher secrets without prefix acceptance", () => {
  assert.equal(constantTimeSecretMatch("exact-secret", "exact-secret"), true);
  assert.equal(constantTimeSecretMatch("exact", "exact-secret"), false);
  assert.equal(constantTimeSecretMatch("", "exact-secret"), false);
});
