import assert from "node:assert/strict";
import test from "node:test";
import { ControllerSimulator } from "../src/controller-simulator.mjs";

function experiment(overrides = {}) {
  return {
    id: "experiment-1",
    watering_enabled: true,
    valve_open_seconds: 10,
    assignments: [
      {
        pairing_name: "Zone1-Pot15",
        pot_number: 15,
        target_vwc_percent: 30,
        measurement_interval_minutes: 10,
        initial_vwc_percent: 28,
      },
    ],
    ...overrides,
  };
}

test("records the reading before watering and the response later", () => {
  const simulator = new ControllerSimulator({ evaporationPerMinute: 0 });
  simulator.loadExperiment(experiment());
  simulator.advance(10);

  const first = simulator.snapshot();
  assert.deepEqual(first.events.map((event) => event.type), [
    "sensor_reading",
    "valve_event",
    "delivery_evidence",
  ]);
  assert.equal(first.events[0].vwc_percent, 28);
  assert.equal(first.events[2].verification_result, "verified");

  simulator.advance(10);
  const readings = simulator.snapshot().events.filter((event) => event.type === "sensor_reading");
  assert.equal(readings[1].vwc_percent, 28.84);
});

test("sensing-only experiments never produce valve events", () => {
  const simulator = new ControllerSimulator({ evaporationPerMinute: 0.1 });
  simulator.loadExperiment(experiment({ watering_enabled: false }));
  simulator.advance(10);
  simulator.advance(10);
  assert.equal(
    simulator.snapshot().events.filter((event) => event.type === "valve_event").length,
    0,
  );
});

test("blocked delivery is not reported as physically verified", () => {
  const simulator = new ControllerSimulator({ evaporationPerMinute: 0 });
  simulator.loadExperiment(experiment());
  simulator.setDeliveryMode("Zone1-Pot15", "blocked");
  simulator.advance(10);

  const state = simulator.snapshot();
  const evidence = state.events.find((event) => event.type === "delivery_evidence");
  assert.equal(evidence.delivered_ml, 0);
  assert.equal(evidence.verification_result, "mismatch");
  assert.equal(state.pots[0].vwcPercent, 28);
});

test("enforces the minimum interval and hourly limit", () => {
  const simulator = new ControllerSimulator({ evaporationPerMinute: 0 });
  simulator.loadExperiment(experiment());
  for (let index = 0; index < 6; index += 1) simulator.advance(10);

  const state = simulator.snapshot();
  assert.equal(state.events.filter((event) => event.type === "valve_event").length, 2);
  assert.ok(state.events.some((event) => event.type === "watering_suppressed"));
});
