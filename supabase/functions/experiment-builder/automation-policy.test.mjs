import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMonitorPlan,
  normalizeSchedulePlan,
} from "./automation-policy.mjs";

const config = {
  pairings: [{
    name: "Zone1-Pot15",
    WTCPercentLimit: 30,
    ValveOpenTime: 5000,
    MeasurementInterval: 600000,
  }],
  groups: [],
  calibrations: [],
  sensors: [],
  valves: [],
  board_config: [],
};

test("scheduled settings stay bounded to reviewed safe command types", () => {
  const result = normalizeSchedulePlan({
    name: "Tomorrow",
    run_at: "2026-07-25T09:00:00-04:00",
    recurrence: "once",
    timezone: "America/Detroit",
    settings_plan: {
      summary: "Set the target",
      commands: [{
        command_type: "bulk_update_pairings",
        payload_json: JSON.stringify({
          pairing_names: ["Zone1-Pot15"],
          target_vwc: 25,
        }),
        effect: "Set Pot 15 to 25%",
      }],
      questions: [],
    },
    questions: [],
  }, config, "researcher", new Date("2026-07-24T12:00:00Z"));

  assert.equal(result.plan.questions.length, 0);
  assert.equal(result.plan.settings_plan.commands[0].command_type, "bulk_update_pairings");
});

test("scheduled manual water and stale times are rejected", () => {
  const result = normalizeSchedulePlan({
    name: "Unsafe",
    run_at: "2026-07-24T11:00:00Z",
    recurrence: "once",
    timezone: "UTC",
    settings_plan: {
      summary: "Pulse a valve",
      commands: [{
        command_type: "manual_water",
        payload_json: JSON.stringify({
          pairing_names: ["Zone1-Pot15"],
          duration_seconds: 10,
        }),
        effect: "Water Pot 15",
      }],
      questions: [],
    },
    questions: [],
  }, config, "researcher", new Date("2026-07-24T12:00:00Z"));

  assert.equal(result.plan.settings_plan.commands.length, 0);
  assert.ok(result.plan.questions.some((question) => /currently support/i.test(question)));
  assert.ok(result.plan.questions.some((question) => /future/i.test(question)));
});

test("schedules require an explicit offset and a real timezone", () => {
  const result = normalizeSchedulePlan({
    name: "Ambiguous clock",
    run_at: "2026-07-25T09:00:00",
    recurrence: "daily",
    timezone: "Greenhouse/Imaginary",
    settings_plan: {
      summary: "Set the target",
      commands: [{
        command_type: "update_pairing",
        payload_json: JSON.stringify({
          pairing_name: "Zone1-Pot15",
          target_vwc: 25,
        }),
        effect: "Set Pot 15 to 25%",
      }],
      questions: [],
    },
    questions: [],
  }, config, "researcher", new Date("2026-07-24T12:00:00Z"));

  assert.ok(result.plan.questions.some((question) => /UTC offset/i.test(question)));
  assert.ok(result.plan.questions.some((question) => /IANA timezone/i.test(question)));
});

test("monitor plans resolve exact experiments and assigned pots", () => {
  const result = normalizeMonitorPlan({
    name: "Low control",
    experiment: "Matt Experiment 2",
    metric: "current_vwc",
    comparator: "below",
    threshold: 20,
    window_minutes: 60,
    pairing_names: ["Zone1-Pot15"],
    check_every_minutes: 10,
    cooldown_minutes: 60,
    questions: [],
  }, [{
    id: "experiment-1",
    name: "Matt Experiment 2",
    slug: "matt-experiment-2",
    pairing_names: ["Zone1-Pot15"],
  }]);

  assert.equal(result.plan.experiment_id, "experiment-1");
  assert.deepEqual(result.plan.pairing_names, ["Zone1-Pot15"]);
  assert.equal(result.plan.questions.length, 0);
});

test("monitor plans reject pairings outside the experiment", () => {
  const result = normalizeMonitorPlan({
    name: "Wrong pot",
    experiment: "Matt Experiment 2",
    metric: "sensor_stale",
    comparator: "stale",
    threshold: null,
    window_minutes: 30,
    pairing_names: ["Zone9-Pot999"],
    check_every_minutes: 10,
    cooldown_minutes: 60,
    questions: [],
  }, [{
    id: "experiment-1",
    name: "Matt Experiment 2",
    slug: "matt-experiment-2",
    pairing_names: ["Zone1-Pot15"],
  }]);

  assert.ok(result.plan.questions.some((question) => /belong/i.test(question)));
});
