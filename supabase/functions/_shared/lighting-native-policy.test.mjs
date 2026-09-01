import assert from "node:assert/strict";
import test from "node:test";

import {
  lightingBridgeIsReady,
  nextLightingState,
  normalizeLightingControllerIntensity,
  normalizeLightingIntensity,
} from "./lighting-native-policy.mjs";

test("lighting intensity matches the legacy maintenance GUI range", () => {
  assert.equal(normalizeLightingIntensity(0), 0);
  assert.equal(normalizeLightingIntensity(10), 10);
  assert.equal(normalizeLightingIntensity("255"), 255);
  assert.throws(() => normalizeLightingIntensity(9));
  assert.throws(() => normalizeLightingIntensity(256));
  assert.throws(() => normalizeLightingIntensity(10.5));
});

test("controller observation preserves the wider legacy schedule range", () => {
  assert.equal(normalizeLightingControllerIntensity(2090), 2090);
  assert.equal(normalizeLightingControllerIntensity(10.1254), 10.125);
  assert.throws(() => normalizeLightingControllerIntensity(2091));
});

test("bridge readiness requires a fresh commissioned heartbeat", () => {
  const now = Date.parse("2026-09-01T17:00:00Z");
  assert.equal(lightingBridgeIsReady({
    bridge_connected: true,
    bridge_ready: true,
    last_bridge_at: "2026-09-01T16:59:50Z",
  }, now), true);
  assert.equal(lightingBridgeIsReady({
    bridge_connected: true,
    bridge_ready: true,
    last_bridge_at: "2026-09-01T16:59:40Z",
  }, now), false);
  assert.equal(lightingBridgeIsReady({
    bridge_connected: true,
    bridge_ready: false,
    last_bridge_at: "2026-09-01T16:59:59Z",
  }, now), false);
});

test("local state synchronization preserves the last on intensity", () => {
  const off = nextLightingState({ state_revision: 7, last_nonzero_intensity: 120 }, 0, "local");
  assert.deepEqual(off, {
    controller_intensity: 0,
    requested_intensity: 0,
    last_nonzero_intensity: 120,
    last_source: "local",
    state_revision: 8,
  });
});
