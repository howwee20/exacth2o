import assert from "node:assert/strict";
import test from "node:test";
import { executeCommand, stripTrailingSlash } from "../src/control-executor.mjs";

function apiFixture(overrides = {}) {
  const calls = [];
  const state = overrides.state || "STOPPED";
  const data = {
    pairings: [{ name: "Pot 41", sensorId: 41, valveId: 141 }],
    sensors: [{ id: 41, name: "Sensor 41", boardSerialId: "A", address: 1 }],
    valves: [{ id: 141, name: "Valve 41", relayAddress: 3, address: 7 }],
    groups: [{ id: 1, name: "Bench" }],
    calibrations: [{ id: 9, name: "Cal A" }],
    ...overrides.data,
  };

  return {
    calls,
    api: {
      async get(path) {
        calls.push(["GET", path]);
        if (path === "/system") return { state };
        if (path === "/pairings") return data.pairings;
        if (path === "/sensors") return data.sensors;
        if (path === "/valves") return data.valves;
        if (path === "/groups") return data.groups;
        if (path === "/calibrations") return data.calibrations;
        throw new Error(`Unexpected GET ${path}`);
      },
      async post(path, body) {
        calls.push(["POST", path, body]);
        return { ok: true, path, body };
      },
      async put(path, body) {
        calls.push(["PUT", path, body]);
        return { ok: true, path, body };
      },
      async delete(path) {
        calls.push(["DELETE", path]);
        return { ok: true, path };
      },
    },
  };
}

test("stripTrailingSlash removes only trailing slashes", () => {
  assert.equal(stripTrailingSlash("https://example.test///"), "https://example.test");
});

test("update_pairing maps portal payload to local controller fields", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    {
      command_type: "update_pairing",
      payload: {
        pairing_name: "Pot 41",
        target_vwc: 35,
        open_time_seconds: 12,
        measurement_interval_seconds: 300,
      },
    },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
  );

  assert.deepEqual(result.body, {
    WTCPercentLimit: 35,
    ValveOpenTime: 12000,
    MeasurementInterval: 300000,
  });
  assert.deepEqual(fixture.calls.at(-1), [
    "PUT",
    "/pairings/41/141",
    { WTCPercentLimit: 35, ValveOpenTime: 12000, MeasurementInterval: 300000 },
  ]);
});

test("update_pairing refuses to edit while controller is running", async () => {
  const fixture = apiFixture({ state: "RUNNING" });
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "update_pairing", payload: { pairing_name: "Pot 41", target_vwc: 30 } },
        { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
      ),
    /requires controller state STOPPED/,
  );
});

test("manual_water opens then closes valves", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    { command_type: "manual_water", payload: { valve_keys: ["valve 41"], duration_seconds: 0.001 } },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
  );

  assert.equal(result.valveCount, 1);
  assert.deepEqual(
    fixture.calls.filter((call) => call[0] === "POST" && call[1] === "/valves/operate"),
    [
      ["POST", "/valves/operate", { address: 7, relayAddress: 3, operation: "OPEN" }],
      ["POST", "/valves/operate", { address: 7, relayAddress: 3, operation: "CLOSE" }],
    ],
  );
});

test("manual_water rejects excessive duration", async () => {
  const fixture = apiFixture();
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "manual_water", payload: { valve_keys: ["valve 41"], duration_seconds: 61 } },
        { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
      ),
    /exceeds max/,
  );
});

test("initialize_sensors is blocked without explicit executor flag", async () => {
  const fixture = apiFixture();
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "initialize_sensors", payload: {} },
        { api: fixture.api, dryRun: true, manualWaterMaxSeconds: 60 },
      ),
    /initialize_sensors blocked/,
  );
});

