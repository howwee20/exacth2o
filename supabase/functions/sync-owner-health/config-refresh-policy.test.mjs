import assert from "node:assert/strict";
import test from "node:test";

import { shouldWriteObservedConfig } from "./config-refresh-policy.mjs";

const completeObservedConfig = {
  includeConfig: true,
  pairingsObserved: true,
  boardObserved: true,
  sensorsObserved: true,
  valvesObserved: true,
  pairingCount: 1,
  boardCount: 1,
  sensorCount: 20,
  valveCount: 8,
};

test("accepts a complete config observed in the aggregate owner-health response", () => {
  assert.equal(shouldWriteObservedConfig(completeObservedConfig), true);
});

test("rejects a partial current response padded by carried-forward config", () => {
  for (const missingObservation of ["pairingsObserved", "boardObserved", "sensorsObserved", "valvesObserved"]) {
    assert.equal(shouldWriteObservedConfig({
      ...completeObservedConfig,
      [missingObservation]: false,
    }), false, missingObservation);
  }
});

test("rejects config work that was not requested", () => {
  assert.equal(shouldWriteObservedConfig({
    ...completeObservedConfig,
    includeConfig: false,
  }), false);
});

test("rejects an incomplete safety-critical config mirror", () => {
  for (const missingCount of ["pairingCount", "boardCount", "sensorCount", "valveCount"]) {
    assert.equal(shouldWriteObservedConfig({
      ...completeObservedConfig,
      [missingCount]: 0,
    }), false, missingCount);
  }
});
