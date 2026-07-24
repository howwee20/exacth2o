import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryFromDeviceConfig,
  normalizeDraft,
  responseOutputText,
  safeInventoryForModel,
  validateDraft,
} from "./experiment-policy.mjs";

const config = {
  pairings: [{
    name: "Zone1-Pot15",
    groupId: 4,
    Sensor: { boardSerialId: "sensor-board", address: "0x10" },
    Valve: { relayAddress: "relay-board", address: "2" },
    Calibration: { name: "Field calibration" },
    WTCPercentLimit: 30,
    ValveOpenTime: 5000,
    MeasurementInterval: 600000,
  }],
  groups: [{ id: 4, name: "Trial pots" }],
};

test("inventory uses current config while the model inventory omits hardware keys", () => {
  const inventory = inventoryFromDeviceConfig(config);
  assert.equal(inventory[0].sensor_key, "sensor-board:0x10");
  assert.equal(inventory[0].valve_key, "relay-board:2");
  assert.deepEqual(safeInventoryForModel(inventory), [{
    pairing_name: "Zone1-Pot15",
    zone: 1,
    pot_number: 15,
    group: "Trial pots",
    calibration: "Field calibration",
    current_target_vwc_percent: 30,
    current_measurement_interval_minutes: 10,
  }]);
});

test("draft validation blocks invented pairings and watering requests", () => {
  const inventory = inventoryFromDeviceConfig(config);
  const result = validateDraft({
    name: "Trial",
    description: "",
    mode: "observation",
    start_date: null,
    assignments: [{
      pairing_name: "Zone9-Pot999",
      crop: null,
      treatment: null,
      block: null,
      substrate: null,
      target_vwc_percent: null,
      measurement_interval_minutes: null,
      notes: null,
    }],
    visibility_roles: ["researcher", "admin"],
    watering_requested: true,
    questions: [],
  }, inventory);

  assert.deepEqual(result.draft.visibility_roles, ["admin", "researcher"]);
  assert.ok(result.messages.includes("Watering cannot be enabled by the experiment builder."));
  assert.ok(result.messages.some((message) => message.includes("not in the current inventory")));
});

test("normalization preserves declared metadata and forces safe roles", () => {
  const draft = normalizeDraft({
    name: "  Maize run  ",
    mode: "calibration",
    assignments: [],
    visibility_roles: ["viewer"],
    questions: ["  Which substrate?  "],
  });
  assert.equal(draft.name, "Maize run");
  assert.equal(draft.mode, "calibration");
  assert.deepEqual(draft.visibility_roles, ["admin", "researcher"]);
  assert.deepEqual(draft.questions, ["Which substrate?"]);
});

test("response parser handles Responses API content", () => {
  assert.equal(responseOutputText({
    output: [{ content: [{ type: "output_text", text: "{\"name\":\"Trial\"}" }] }],
  }), "{\"name\":\"Trial\"}");
});
