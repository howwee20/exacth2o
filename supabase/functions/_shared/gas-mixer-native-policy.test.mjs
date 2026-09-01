import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNativeField,
  bridgeIsReady,
  normalizeNativeField,
  normalizeNativeMachineState,
} from "./gas-mixer-native-policy.mjs";

const state = {
  use_licor: false,
  total_slpm: 0,
  channels: {
    A: { address: "A", formula: "N2", balance: true, ratio_unit: "%", flow_unit: "SLPM", ratio: 100, setpoint: 0, delivered: 0, available: true, flow_error: false },
    B: { address: "B", formula: "O2", balance: false, ratio_unit: "%", flow_unit: "SLPM", ratio: 0, setpoint: 0, delivered: 0, available: true, flow_error: false },
    C: { address: "C", formula: "Ar", balance: false, ratio_unit: "PPM", flow_unit: "SCCM", ratio: 0, setpoint: 0, delivered: 0, available: false, flow_error: false },
    D: { address: "D", formula: "CO2", balance: false, ratio_unit: "PPM", flow_unit: "SCCM", ratio: 0, setpoint: 0, delivered: 0, available: true, flow_error: false },
    E: { address: "E", formula: "N2", balance: false, ratio_unit: "%", flow_unit: "SLPM", ratio: 0, setpoint: 0, delivered: 0, available: false, flow_error: false },
    F: { address: "F", formula: "O2", balance: false, ratio_unit: "%", flow_unit: "SLPM", ratio: 0, setpoint: 0, delivered: 0, available: false, flow_error: false },
  },
};

test("only configured non-balance fields are writable", () => {
  assert.deepEqual(normalizeNativeField("mfc.D.ratio", 400.4), { field: "mfc.D.ratio", value: 400 });
  assert.throws(() => normalizeNativeField("mfc.A.ratio", 90));
  assert.throws(() => normalizeNativeField("mfc.B.ratio", 101));
  assert.throws(() => normalizeNativeField("shell", "id"));
});

test("structured changes preserve the existing balance behavior", () => {
  let next = applyNativeField(state, "total_slpm", 2);
  next = applyNativeField(next, "mfc.B.ratio", 20);
  next = applyNativeField(next, "mfc.D.ratio", 400);
  assert.equal(next.channels.B.setpoint, 0.4);
  assert.equal(next.channels.D.setpoint, 0.8);
  assert.ok(Math.abs(next.channels.A.ratio - 79.96) < 0.000001);
  assert.ok(Math.abs(next.channels.A.setpoint - 1.5992) < 0.000001);
});

test("over-total changes follow the Qt modified-controller balance path", () => {
  let next = applyNativeField(state, "total_slpm", 1);
  next = applyNativeField(next, "mfc.B.ratio", 80);
  next = applyNativeField(next, "mfc.E.ratio", 40);
  assert.equal(next.channels.B.setpoint, 0);
  assert.equal(next.channels.E.setpoint, 0.4);
  assert.equal(next.channels.A.setpoint, 0.6);
  assert.throws(() => applyNativeField(next, "mfc.D.setpoint", 1001), /exceeds total flow/);
});

test("bridge readiness requires commissioning and a fresh heartbeat", () => {
  const now = Date.parse("2026-09-01T00:30:00Z");
  assert.equal(bridgeIsReady({ bridge_connected: true, bridge_ready: true, last_bridge_at: "2026-09-01T00:29:30Z" }, now), true);
  assert.equal(bridgeIsReady({ bridge_connected: true, bridge_ready: false, last_bridge_at: "2026-09-01T00:29:59Z" }, now), false);
  assert.equal(bridgeIsReady({ bridge_connected: true, bridge_ready: true, last_bridge_at: "2026-09-01T00:28:00Z" }, now), false);
});

test("device state validation rejects changed physical channel identities", () => {
  assert.deepEqual(normalizeNativeMachineState(state), state);
  const altered = structuredClone(state);
  altered.channels.D.formula = "N2";
  assert.throws(() => normalizeNativeMachineState(altered));
});
