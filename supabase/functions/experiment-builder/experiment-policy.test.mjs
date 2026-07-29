import assert from "node:assert/strict";
import test from "node:test";
import {
  activeExperimentAssignmentConflicts,
  compileControlPlan,
  controllerCommandChannelIssue,
  inventoryFromDeviceConfig,
  normalizeDraft,
  responseOutputText,
  safeInventoryForModel,
  validateDraft,
  validatePracticeDraft,
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

test("active experiment assignments block accidental pot overlap", () => {
  const experiments = [{
    id: "00000000-0000-4000-8000-000000000001",
    name: "Current edit",
    status: "active",
    pairing_names: ["Zone1-Pot15"],
  }, {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Other trial",
    status: "active",
    pairing_names: ["Zone1-Pot15", "Zone1-Pot16"],
  }, {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Completed trial",
    status: "completed",
    pairing_names: ["Zone1-Pot17"],
  }];

  assert.deepEqual(
    activeExperimentAssignmentConflicts(
      experiments,
      ["Zone1-Pot15", "Zone1-Pot17"],
      "00000000-0000-4000-8000-000000000001",
    ),
    [{
      pairing_name: "Zone1-Pot15",
      experiment_id: "00000000-0000-4000-8000-000000000002",
      experiment_name: "Other trial",
    }],
  );
});

test("controlled experiments require an authorized, non-quarantined command channel", () => {
  const nowMs = Date.parse("2026-07-29T00:30:00.000Z");
  const readyExecutor = {
    observed_at: "2026-07-29T00:29:30.000Z",
    dry_run: false,
    sync_ready: true,
    local_api_reachable: true,
  };

  assert.deepEqual(
    controllerCommandChannelIssue(
      [{ enabled: true, revoked_at: null }],
      { active: true, reason: "command outcome is unknown" },
      readyExecutor,
      { nowMs },
    ),
    {
      code: "CONTROLLER_COMMAND_CHANNEL_QUARANTINED",
      message:
        "Controller changes are temporarily unavailable because the device command channel requires reconciliation.",
    },
  );

  assert.deepEqual(
    controllerCommandChannelIssue(
      [{ enabled: false, revoked_at: null }],
      { active: false },
      readyExecutor,
      { nowMs },
    ),
    {
      code: "CONTROLLER_COMMAND_CHANNEL_UNAVAILABLE",
      message:
        "Controller changes are temporarily unavailable because the device executor is not authorized.",
    },
  );

  assert.deepEqual(
    controllerCommandChannelIssue(
      [{ enabled: true, revoked_at: null }],
      { active: false },
      { ...readyExecutor, observed_at: "2026-07-29T00:20:00.000Z" },
      { nowMs },
    ),
    {
      code: "CONTROLLER_EXECUTOR_OFFLINE",
      message:
        "Controller changes are temporarily unavailable because the device executor is offline or stale.",
    },
  );

  assert.deepEqual(
    controllerCommandChannelIssue(
      [{ enabled: true, revoked_at: null }],
      { active: false },
      { ...readyExecutor, dry_run: true },
      { nowMs },
    ),
    {
      code: "CONTROLLER_EXECUTOR_DRY_RUN",
      message:
        "Controller changes are temporarily unavailable because the device executor is in verification-only mode.",
    },
  );

  assert.deepEqual(
    controllerCommandChannelIssue(
      [{ enabled: true, revoked_at: null }],
      { active: false },
      { ...readyExecutor, sync_ready: false },
      { nowMs },
    ),
    {
      code: "CONTROLLER_EXECUTOR_NOT_READY",
      message:
        "Controller changes are temporarily unavailable because controller readback is not configured.",
    },
  );

  assert.deepEqual(
    controllerCommandChannelIssue(
      [{ enabled: true, revoked_at: null }],
      { active: false },
      { ...readyExecutor, local_api_reachable: false },
      { nowMs },
    ),
    {
      code: "CONTROLLER_API_UNREACHABLE",
      message:
        "Controller changes are temporarily unavailable because the Pi controller API is not reachable.",
    },
  );

  assert.equal(
    controllerCommandChannelIssue(
      [{ enabled: true, revoked_at: null }],
      { active: false },
      readyExecutor,
      { nowMs },
    ),
    null,
  );
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

test("practice experiments cannot change live watering or cadence", () => {
  const controlledInventory = inventoryFromDeviceConfig(config);
  const practiceDraft = {
    name: "Assistant Practice",
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
  };
  assert.match(
    validatePracticeDraft("practice", practiceDraft, controlledInventory).join(" "),
    /must already be sensing only/i,
  );

  const sensingInventory = inventoryFromDeviceConfig({
    ...config,
    pairings: [{
      ...config.pairings[0],
      WTCPercentLimit: -1001,
    }],
  });
  assert.deepEqual(
    validatePracticeDraft("practice", practiceDraft, sensingInventory),
    [],
  );
  assert.match(
    validatePracticeDraft(
      "practice",
      {
        ...practiceDraft,
        assignments: [{
          ...practiceDraft.assignments[0],
          measurement_interval_minutes: 5,
        }],
      },
      sensingInventory,
    ).join(" "),
    /keep its current measurement interval/i,
  );
});

test("future starts cannot be mistaken for scheduled controller execution", () => {
  const inventory = inventoryFromDeviceConfig(config);
  const result = compileControlPlan({
    name: "Future trial",
    description: "",
    mode: "controlled",
    start_date: "2099-01-01T12:00:00.000Z",
    assignments: [{
      pairing_name: "Zone1-Pot15",
      crop: null,
      treatment: null,
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
  }, inventory);

  assert.equal(result.plan, null);
  assert.ok(result.messages.some((message) => message.includes("Future execution")));
});

test("response parser handles Responses API content", () => {
  assert.equal(responseOutputText({
    output: [{ content: [{ type: "output_text", text: "{\"name\":\"Trial\"}" }] }],
  }), "{\"name\":\"Trial\"}");
});
