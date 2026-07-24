import assert from "node:assert/strict";
import test from "node:test";
import {
  compileControlPlan,
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
    current_watering_enabled: true,
    current_target_vwc_percent: 30,
    current_valve_open_seconds: 5,
    current_measurement_interval_minutes: 10,
  }]);
});

test("draft validation blocks invented pairings and incomplete watering settings", () => {
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
      watering_enabled: true,
      target_vwc_percent: 90,
      valve_open_seconds: null,
      measurement_interval_minutes: 10,
      notes: null,
    }],
    visibility_roles: ["researcher", "admin"],
    controller_changes_requested: true,
    questions: [],
  }, inventory);

  assert.deepEqual(result.draft.visibility_roles, ["admin", "researcher"]);
  assert.ok(result.messages.includes("Zone9-Pot999 is not in the current inventory."));
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

test("control plan stops, applies reviewed changes, and resumes in order", () => {
  const inventory = inventoryFromDeviceConfig(config);
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const result = compileControlPlan({
    name: "Controlled trial",
    description: "",
    mode: "controlled",
    start_date: null,
    assignments: [{
      pairing_name: "Zone1-Pot15",
      crop: null,
      treatment: "Control",
      block: null,
      substrate: null,
      watering_enabled: true,
      target_vwc_percent: 35,
      valve_open_seconds: 8,
      measurement_interval_minutes: 10,
      notes: null,
    }],
    visibility_roles: ["admin", "researcher"],
    controller_changes_requested: true,
    questions: [],
  }, inventory, () => ids.shift());

  assert.deepEqual(result.messages, []);
  assert.equal(result.plan.change_count, 1);
  assert.deepEqual(result.plan.commands.map((command) => command.command_type), [
    "update_system_state",
    "bulk_update_pairings",
    "update_system_state",
  ]);
  assert.deepEqual(result.plan.commands[1].payload, {
    pairing_names: ["Zone1-Pot15"],
    measurement_interval_seconds: 600,
    target_vwc: 35,
    open_time_seconds: 8,
  });
});

test("observation plan disables watering while preserving sensing", () => {
  const inventory = inventoryFromDeviceConfig(config);
  const result = compileControlPlan({
    name: "Dry-down",
    description: "",
    mode: "observation",
    start_date: null,
    assignments: [{
      pairing_name: "Zone1-Pot15",
      crop: null,
      treatment: null,
      block: null,
      substrate: null,
      watering_enabled: false,
      target_vwc_percent: null,
      valve_open_seconds: null,
      measurement_interval_minutes: 10,
      notes: null,
    }],
    visibility_roles: ["admin", "researcher"],
    controller_changes_requested: true,
    questions: [],
  }, inventory, () => crypto.randomUUID());

  assert.equal(result.plan.change_count, 1);
  assert.deepEqual(result.plan.commands[1].payload, {
    pairing_names: ["Zone1-Pot15"],
    measurement_interval_seconds: 600,
    disable_watering: true,
  });
});

test("response parser handles Responses API content", () => {
  assert.equal(responseOutputText({
    output: [{ content: [{ type: "output_text", text: "{\"name\":\"Trial\"}" }] }],
  }), "{\"name\":\"Trial\"}");
});
