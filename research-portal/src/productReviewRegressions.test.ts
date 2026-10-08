import { describe, expect, it } from "vitest";
import { experimentFactors, potGroups } from "./experimentFactors";
import type { PortalExperimentAssignment } from "./experimentRegistry";
import { homeExceptions } from "./homeExceptions";
import { computeComparison } from "./workbenchModel";

function assignment(pot: number, treatment: string, crop = "maize"): PortalExperimentAssignment {
  return {
    pairing_name: `Zone1-Pot${pot}`,
    zone: 1,
    pot_number: pot,
    crop,
    treatment,
    block: null,
    substrate: null,
    target_vwc_percent: pot === 1 ? 20 : 30,
    measurement_interval_minutes: 10,
  };
}

function experiment(assignments: PortalExperimentAssignment[], extraPots: string[] = []) {
  return { assignments, pairingNames: [...assignments.map((row) => row.pairing_name), ...extraPots] };
}

describe("factor group identity regressions", () => {
  it("keeps punctuation-distinct treatments and their targets in separate groups", () => {
    const groups = potGroups(experiment([assignment(1, "A/B"), assignment(2, "A B")]), ["treatment"]);
    expect(groups.map((group) => [group.label, group.potNumbers, group.plannedTargets])).toEqual([
      ["A/B", [1], [20]],
      ["A B", [2], [30]],
    ]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(2);
    expect(groups.every((group) => group.id !== "a-b")).toBe(true);
    // The old merged group's saved visibility must not select either distinct new group.
    const result = computeComparison({ groups, buckets: [], measure: "vwc", window: { queryStartMs: 0, endMs: 60_000, bucketMs: 60_000 }, hiddenGroups: ["a-b"] });
    expect(result.summaries.map((summary) => summary.hidden)).toEqual([false, false]);
  });

  it("preserves tuple boundaries and produces stable identities across plan ordering", () => {
    const assignments = [assignment(1, "a-b", "c"), assignment(2, "a", "b-c")];
    const groups = potGroups(experiment(assignments), ["treatment", "crop"]);
    expect(groups.map((group) => group.potNumbers)).toEqual([[1], [2]]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(2);
    expect(potGroups(experiment(assignments.slice().reverse()), ["treatment", "crop"]).map((group) => group.id)).toEqual(groups.map((group) => group.id));
  });

  it("separates missing levels, literal not-set, and distinct non-Latin levels", () => {
    const groups = potGroups(experiment([
      assignment(1, ""), assignment(2, "not-set"), assignment(3, "水"), assignment(4, "土"),
    ]), ["treatment"]);
    expect(groups.map((group) => group.potNumbers)).toEqual([[1], [2], [3], [4]]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(4);
  });

  it("keeps a treatment named not-in-plan without overwriting its assigned pots", () => {
    const groups = potGroups(experiment([assignment(1, "not-in-plan")], ["Zone1-Pot2"]), ["treatment"]);
    expect(groups.map((group) => [group.label, group.potNumbers])).toEqual([["Not-in-plan", [1]], ["Not in the plan", [2]]]);
    expect(groups[0].id).not.toBe("not-in-plan");
    expect(groups[1].id).toBe("not-in-plan");
  });

  it("preserves unambiguous saved IDs and the existing case-insensitive level convention", () => {
    const plan = experiment([assignment(1, "control"), assignment(2, "Control"), assignment(3, "deficit")]);
    const groups = potGroups(plan, ["treatment"]);
    expect(experimentFactors(plan)[0].levels.map((level) => level.potCount)).toEqual([2, 1]);
    expect(groups.map((group) => [group.id, group.potNumbers])).toEqual([["control", [1, 2]], ["deficit", [3]]]);
    const result = computeComparison({ groups, buckets: [], measure: "vwc", window: { queryStartMs: 0, endMs: 60_000, bucketMs: 60_000 }, hiddenGroups: ["deficit"] });
    expect(result.summaries.map((summary) => summary.hidden)).toEqual([false, true]);
    expect(potGroups(plan, [])[0].id).toBe("all");
  });
});

describe("controller reporting copy regression", () => {
  it.each([10, 0, null])("does not infer stopped physical watering from last report %s", (lastSeenAt) => {
    const exceptions = homeExceptions({
      experiments: [], pairings: [], readings: [], nowMs: 100,
      checked: true, refresh: { failedAt: null, lastSuccessAt: 100 },
      controller: { offline: true, lastSeenAt }, formatTime: (ms) => `time ${ms}`,
    });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].sentence).toContain("readings and watering status are unconfirmed");
    expect(exceptions[0].sentence).not.toContain("no readings or watering");
    if (lastSeenAt != null) expect(exceptions[0].sentence).toContain(`since time ${lastSeenAt}`);
  });
});
