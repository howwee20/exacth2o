import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLiveReadingRows,
  normalizePairToken,
  resolveEvidencePairing,
  semanticDedupeValveEvents,
} from "./rd-evidence-policy.mjs";

const health = {
  api: {
    researcherMap: {
      rows: [{
        ok: true,
        sensorId: 662,
        valveId: 1580,
        actualName: "Zone4-Pot91",
        actualSensor: "D30GQN2D:1",
        latestReading: {
          createdAt: "2026-07-12T12:50:00.000Z",
          rawValue: 19.8,
          calibratedValue: 19.6,
          temperature: 24.1,
          electricalConductivity: 0.8,
        },
      }],
    },
  },
};

test("normalizes and resolves controller pair tokens", () => {
  assert.equal(normalizePairToken("662-1580;"), "662-1580");
  assert.deepEqual(resolveEvidencePairing("662-1580;", health), {
    raw: "662-1580;",
    normalized: "662-1580",
    pairingName: "Zone4-Pot91",
    resolved: true,
  });
});

test("builds deterministic live reading rows from verified researcher map evidence", () => {
  const rows = collectLiveReadingRows(health, {
    organizationId: "org",
    projectId: "project",
    deviceId: "device",
    serverReceivedAt: "2026-07-12T12:51:00.000Z",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pairing_name, "Zone4-Pot91");
  assert.equal(
    rows[0].event_id,
    "live-device:device:662:2026-07-12T12:50:00.000Z",
  );
});

test("prefers direct automatic evidence over a scalar duplicate", () => {
  const base = {
    pairing_name: "Zone4-Pot91",
    action: "open",
    device_recorded_at: "2026-07-12T12:55:00.000Z",
  };
  const result = semanticDedupeValveEvents([
    {
      ...base,
      event_id: "scalar",
      evidence_source: "owner_health_scalar",
      source_class: "unknown",
    },
    {
      ...base,
      event_id: "direct",
      evidence_source: "owner_health_direct",
      source_class: "automatic",
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].event_id, "direct");
});
