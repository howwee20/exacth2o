import { describe, expect, it } from "vitest";
import { assignmentInGroup, defaultGroups, groupsFromAssignments, nextGroup } from "./experimentGroups";
import type { ExperimentDraftAssignment } from "./experimentSpec";

const pot = (name: string, patch: Partial<ExperimentDraftAssignment> = {}): ExperimentDraftAssignment => ({
  pairing_name: name, crop: null, treatment: null, block: null, substrate: null, notes: null,
  watering_enabled: true, target_vwc_percent: 30, valve_open_seconds: 2, measurement_interval_minutes: 10, ...patch,
});

describe("experiment groups", () => {
  it("starts a new experiment with Control and Drought", () => {
    expect(defaultGroups().map((group) => [group.name, group.target])).toEqual([["Control", 30], ["Drought", 10]]);
    expect(groupsFromAssignments([]).groups).toEqual(defaultGroups());
  });

  it("reads groups from pots that share a treatment and a target", () => {
    const { groups, groupByPot } = groupsFromAssignments([
      pot("a", { treatment: "Control" }), pot("b", { treatment: "Drought", target_vwc_percent: 10 }),
      pot("c", { treatment: "Control" }), pot("d", { treatment: "Dry", watering_enabled: false }),
    ]);
    expect(groups.map((group) => [group.name, group.target])).toEqual([["Control", 30], ["Drought", 10], ["Dry", null]]);
    expect(groupByPot).toEqual({ a: "g1", b: "g2", c: "g1", d: "g3" });
  });

  it("gives an added group an unused id and colour", () => {
    const groups = defaultGroups();
    expect(nextGroup(groups)).toEqual({ id: "g3", name: "", target: null, tone: 2 });
    expect(nextGroup([groups[1]]).tone).toBe(0);
  });

  it("sets treatment and watering from the group", () => {
    const [control] = defaultGroups();
    expect(assignmentInGroup(pot("a", { target_vwc_percent: 5, valve_open_seconds: null }), control, "controlled", 3))
      .toMatchObject({ treatment: "Control", watering_enabled: true, target_vwc_percent: 30, valve_open_seconds: 3 });
    expect(assignmentInGroup(pot("a"), { ...control, name: " ", target: null }, "calibration", 3))
      .toMatchObject({ treatment: null, watering_enabled: false, target_vwc_percent: null, valve_open_seconds: 2 });
    expect(assignmentInGroup(pot("a"), control, "observation", 3))
      .toMatchObject({ watering_enabled: false, target_vwc_percent: null, valve_open_seconds: null });
  });
});
