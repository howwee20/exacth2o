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
  assert.deepEqual(configRefreshOutcome({ includeConfig: false, required: false, writeOk: false, previousConfigAvailable: false }), {
    error: null,
    warning: null,
  });
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: true, writeOk: true, previousConfigAvailable: false }), {
    error: null,
    warning: null,
  });
});

test("automatic refresh failure preserves config and warns without failing core health", () => {
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: false, writeOk: false, previousConfigAvailable: true }), {
    error: null,
    warning: "config_state_preserved",
  });
});

test("explicit refresh failure or missing fallback remains fail closed", () => {
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: true, writeOk: false, previousConfigAvailable: true }), {
    error: "config_state",
    warning: null,
  });
  assert.deepEqual(configRefreshOutcome({ includeConfig: true, required: false, writeOk: false, previousConfigAvailable: false }), {
    error: "config_state",
    warning: null,
  });
});
