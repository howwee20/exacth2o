import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSettingsPlan,
  settingsInventoryFromDeviceConfig,
  settingsSystemInstructions,
} from "./settings-policy.mjs";

const config = {
  pairings: [{
    name: "Zone1-Pot15",
    groupId: 4,
  }],
  groups: [{ id: 4, name: "Trial pots" }],
  calibrations: [{ id: 2, name: "Field calibration" }],
  sensors: [{ boardSerialId: "sensor-board", address: "0x10" }],
  valves: [{ relayAddress: "relay-board", address: "2" }],
  board_config: [{ address: "0x20", resetPin: 16 }],
};

test("settings inventory contains only current non-secret controller identifiers", () => {
  assert.deepEqual(settingsInventoryFromDeviceConfig(config), {
    pairings: ["Zone1-Pot15"],
    groups: ["Trial pots"],
    calibrations: ["Field calibration"],
    sensors: ["sensor-board:0x10"],
    valves: ["relay-board:2"],
    boards: [{ address: "0x20", reset_pin: 16 }],
  });
});

test("settings plan normalizes a current pairing update", () => {
  const result = normalizeSettingsPlan({
    summary: "Set pot 15",
    commands: [{
      command_type: "update_pairing",
      payload_json: JSON.stringify({
        pairing_name: "Zone1-Pot15",
        target_vwc: 30,
        open_time_seconds: 5,
        measurement_interval_seconds: 600,
      }),
      effect: "Set pot 15 to 30%",
    }],
    questions: [],
  }, config, "researcher");

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.plan.commands[0].payload, {
    pairing_name: "Zone1-Pot15",
    target_vwc: 30,
    open_time_seconds: 5,
    measurement_interval_seconds: 600,
  });
});

test("settings plan validates rename, group assignment, and admin-only deletion", () => {
  const update = normalizeSettingsPlan({
    summary: "Organize pot 15",
    commands: [{
      command_type: "update_pairing",
      payload_json: JSON.stringify({
        pairing_name: "Zone1-Pot15",
        new_name: "Zone2-Pot15",
        group_name: "Trial pots",
      }),
      effect: "Rename and group pot 15",
    }],
    questions: [],
  }, config, "researcher");
  assert.deepEqual(update.errors, []);
  assert.deepEqual(update.plan.commands[0].payload, {
    pairing_name: "Zone1-Pot15",
    new_name: "Zone2-Pot15",
    group_name: "Trial pots",
  });

  const researcherDelete = normalizeSettingsPlan({
    summary: "Delete pot 15",
    commands: [{
      command_type: "delete_pairing",
      payload_json: JSON.stringify({ pairing_name: "Zone1-Pot15" }),
      effect: "Delete pot 15 pairing",
    }],
    questions: [],
  }, config, "researcher");
  assert.equal(researcherDelete.plan.commands.length, 0);
  assert.ok(researcherDelete.errors.some((error) => error.includes("administrator")));

  const adminDelete = normalizeSettingsPlan({
    summary: "Delete pot 15",
    commands: [{
      command_type: "delete_pairing",
      payload_json: JSON.stringify({ pairing_name: "Zone1-Pot15" }),
      effect: "Delete pot 15 pairing",
    }],
    questions: [],
  }, config, "admin");
  assert.deepEqual(adminDelete.errors, []);
  assert.deepEqual(adminDelete.plan.commands[0].payload, { pairing_name: "Zone1-Pot15" });
});

test("settings plan blocks invented hardware and administrator commands for researchers", () => {
  const result = normalizeSettingsPlan({
    summary: "Unsafe",
    commands: [
      {
        command_type: "create_pairing",
        payload_json: JSON.stringify({
          name: "Zone1-Pot16",
          sensor_key: "invented",
          valve_key: "relay-board:2",
          group_name: "Trial pots",
          target_vwc: 30,
          open_time_seconds: 5,
          measurement_interval_seconds: 600,
        }),
        effect: "Create pairing",
      },
      {
        command_type: "apply_calibration",
        payload_json: JSON.stringify({
          calibration_name: "Field calibration",
          pairing_names: ["Zone1-Pot15"],
        }),
        effect: "Apply calibration",
      },
    ],
    questions: [],
  }, config, "researcher");

  assert.equal(result.plan.commands.length, 0);
  assert.ok(result.errors.some((error) => error.includes("Sensor")));
  assert.ok(result.errors.some((error) => error.includes("administrator")));
});

test("assistant prompt keeps manual watering and sensor initialization locked", () => {
  const instructions = settingsSystemInstructions("admin");
  assert.match(instructions, /Manual valve pulses and sensor initialization are locked/);
  assert.doesNotMatch(instructions, /manual_water:/);
});
