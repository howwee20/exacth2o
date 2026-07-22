import assert from "node:assert/strict";
import test from "node:test";

import {
  actualByHorizon,
  hasRdSystemAdminAccess,
  isMattControlPairing,
  mattControlPairingNames,
} from "./response-policy.mjs";

test("R&D access requires both portal admin role and the explicit allowlist", () => {
  assert.equal(hasRdSystemAdminAccess("admin", true), true);
  assert.equal(hasRdSystemAdminAccess("admin", false), false);
  assert.equal(hasRdSystemAdminAccess("researcher", true), false);
  assert.equal(hasRdSystemAdminAccess("viewer", true), false);
});

test("the R&D model follows the named 20-pot Matt Experiment 1 cohort", () => {
  assert.equal(mattControlPairingNames.length, 20);
  assert.equal(isMattControlPairing("Zone2-Pot41"), true);
  assert.equal(isMattControlPairing("Zone4-Pot100"), true);
  assert.equal(isMattControlPairing("Zone3-Pot70"), false);
  assert.equal(isMattControlPairing("Zone1-Pot15"), false);
});

test("actual response evidence keeps the reading nearest each horizon", () => {
  const openedAt = "2026-07-22T12:00:00.000Z";
  const readings = [
    {
      pairing_name: "Zone2-Pot41",
      calibrated_value: 10,
      device_recorded_at: "2026-07-22T11:59:00.000Z",
    },
    {
      pairing_name: "Zone2-Pot41",
      calibrated_value: 20,
      device_recorded_at: "2026-07-22T12:14:00.000Z",
    },
    {
      pairing_name: "Zone2-Pot41",
      calibrated_value: 99,
      device_recorded_at: "2026-07-22T12:19:00.000Z",
    },
  ];

  const actual = actualByHorizon(readings, "Zone2-Pot41", openedAt, [0, 15]);

  assert.equal(actual.get(0), 10);
  assert.equal(actual.get(15), 20);
});
