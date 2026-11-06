import { describe, expect, it } from "vitest";
import { assignmentForMode, commonAssignmentValue } from "./experimentSetup";
import { manualExperimentDraft } from "./experimentSpec";
import {
  experimentSlug,
  normalizeExperimentDraft,
  validateExperimentDraft,
} from "./experimentValidation";
import type { PairingRow } from "./types";

const inventory: PairingRow[] = [
  {
    id: 1,
    name: "Zone1-Pot15",
    zone: 1,
    pot_number: 15,
    group_name: null,
    source_sensor_id: 101,
    sensor_key: "board-a:A",
    source_valve_id: 201,
    valve_key: "relay-a:1",
    wtc_percent_limit: 30,
    valve_open_time_ms: 0,
    measurement_interval_ms: 600_000,
    calibration_name: "Default",
    calibration_id: 1,
  },
  {
    id: 2,
    name: "Zone1-Pot16",
    zone: 1,
    pot_number: 16,
    group_name: null,
    source_sensor_id: 102,
    sensor_key: "board-a:B",
    source_valve_id: 202,
    valve_key: "relay-a:2",
    wtc_percent_limit: 30,
    valve_open_time_ms: 0,
    measurement_interval_ms: 600_000,
    calibration_name: "Default",
    calibration_id: 1,
  },
];

describe("experiment validation", () => {
  it("accepts a sensing-only draft built from current inventory", () => {
    const draft = manualExperimentDraft(inventory, ["Zone1-Pot15"]);
    draft.name = "New maize trial";
    draft.assignments[0].crop = "Maize";
    draft.assignments[0].target_vwc_percent = 30;

    expect(validateExperimentDraft(draft, inventory)).toEqual([]);
  });

  it("rejects invented and duplicated pairings", () => {
    const draft = manualExperimentDraft(inventory, ["Zone1-Pot15"]);
    draft.name = "Unsafe draft";
    draft.assignments.push({ ...draft.assignments[0] });
    draft.assignments.push({
      ...draft.assignments[0],
      pairing_name: "Zone9-Pot999",
    });

    expect(validateExperimentDraft(draft, inventory).map((issue) => issue.message)).toEqual([
      "Zone1-Pot15 is selected more than once.",
      "Zone1-Pot15 shares a sensor with another selected pot.",
      "Zone1-Pot15 shares a valve with another selected pot.",
      "Zone9-Pot999 is not in the current inventory.",
    ]);
  });

  it("normalizes visibility and preserves reviewed controller intent", () => {
    const draft = manualExperimentDraft(inventory, ["Zone1-Pot16"]);
    draft.name = "  Trial  ";
    draft.visibility_roles = ["researcher", "admin"];
    draft.controller_changes_requested = true;

    expect(normalizeExperimentDraft(draft)).toMatchObject({
      name: "Trial",
      visibility_roles: ["admin", "researcher"],
      controller_changes_requested: true,
    });
    expect(validateExperimentDraft(draft, inventory)).toEqual([]);
  });

  it("requires complete bounded watering settings", () => {
    const draft = manualExperimentDraft(inventory, ["Zone1-Pot16"]);
    draft.name = "Controlled trial";
    draft.assignments[0].target_vwc_percent = 90;
    draft.assignments[0].valve_open_seconds = null;

    expect(validateExperimentDraft(draft, inventory).map((issue) => issue.message)).toEqual([
      "Target must be between 0% and 80%.",
      "Zone1-Pot16 needs a valve time before watering can be enabled.",
    ]);
  });

  it("creates stable slugs", () => {
    expect(experimentSlug(" Matt's Calibration #3 ")).toBe("matt-s-calibration-3");
  });

  it("does not treat a future date as scheduled execution", () => {
    const draft = manualExperimentDraft(inventory, ["Zone1-Pot15"]);
    draft.name = "Future trial";
    draft.start_date = "2099-01-01T12:00:00.000Z";

    expect(validateExperimentDraft(draft, inventory).map((issue) => issue.message)).toContain(
      "Future execution is not available yet. Create the experiment when it is ready to start.",
    );
  });
});


describe("experiment setup", () => {
  it("keeps newly selected and duplicated observation pots off", () => {
    const enabled = assignmentForMode(inventory[0], "controlled");
    expect(enabled.watering_enabled).toBe(true);
    const observation = assignmentForMode(inventory[1], "observation", enabled);
    expect(observation.pairing_name).toBe(inventory[1].name);
    expect(observation.watering_enabled).toBe(false);
    expect(observation.target_vwc_percent).toBeNull();
    expect(observation.valve_open_seconds).toBeNull();
    expect(enabled.watering_enabled).toBe(true);
  });
  it("preserves half-minute inventory cadence when duplicating a setup", () => {
    const pot = { ...inventory[0], measurement_interval_ms: 30_000 };
    expect(manualExperimentDraft([pot], [pot.name]).assignments[0].measurement_interval_minutes).toBe(0.5);
    expect(assignmentForMode(pot, "controlled").measurement_interval_minutes).toBe(0.5);
  });
  it("does not present mixed targets as a shared setting", () => {
    const first = assignmentForMode(inventory[0], "controlled");
    const second = { ...assignmentForMode(inventory[1], "controlled"), target_vwc_percent: 20 };
    expect(commonAssignmentValue([first, second], "target_vwc_percent")).toBe("");
    expect(commonAssignmentValue([first, second], "measurement_interval_minutes")).toBe(10);
  });
});
