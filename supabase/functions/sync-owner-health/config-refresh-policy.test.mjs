import assert from "node:assert/strict";
import test from "node:test";

import { configRefreshDue, configRefreshOutcome } from "./config-refresh-policy.mjs";

test("config refresh is due when no valid checkpoint exists", () => {
  assert.equal(configRefreshDue({
    lastConfigUpdatedAtMs: Number.NaN,
    lastAttemptCompletedAtMs: Number.NaN,
    nowMs: 1_000_000,
  }), true);
});

test("a failed refresh attempt suppresses retries until the interval passes", () => {
  assert.equal(configRefreshDue({
    lastConfigUpdatedAtMs: 0,
    lastAttemptCompletedAtMs: 900_000,
    nowMs: 1_000_000,
    intervalMs: 900_000,
  }), false);
  assert.equal(configRefreshDue({
    lastConfigUpdatedAtMs: 0,
    lastAttemptCompletedAtMs: 900_000,
    nowMs: 1_800_000,
    intervalMs: 900_000,
  }), true);
});

test("successful or skipped config work has no error or warning", () => {
  assert.deepEqual(configRefreshOutcome({ includeConfig: false, required: false, writeAttempted: false, writeOk: false, previousConfigUsable: false }), {
    error: null,
    warning: null,
  });
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: true, writeAttempted: true, writeOk: true, previousConfigUsable: false }), {
    error: null,
    warning: null,
  });
});

test("automatic refresh failure preserves config and warns without failing core health", () => {
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: false, writeAttempted: false, writeOk: false, previousConfigUsable: true }), {
    error: null,
    warning: "config_state_preserved",
  });
});

test("explicit refresh failure or unusable fallback remains fail closed", () => {
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: true, writeAttempted: false, writeOk: false, previousConfigUsable: true }), {
    error: "config_state",
    warning: null,
  });
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: false, writeAttempted: false, writeOk: false, previousConfigUsable: false }), {
    error: "config_state",
    warning: null,
  });
});

test("a failed database write is never downgraded to a preservation warning", () => {
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: false, writeAttempted: true, writeOk: false, previousConfigUsable: true }), {
    error: "config_state",
    warning: null,
  });
});
