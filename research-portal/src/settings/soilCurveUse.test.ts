import { describe, expect, it } from "vitest";
import { soilCurveUse } from "./soilCurveUse";

describe("soil curve use in Experiment Settings", () => {
  const assignments = [1, 2, 3, 4].map((pot) => ({ pot_number: pot, calibration_name_snapshot: "Substrate v1" }));
  const names = new Set(["P1", "P2", "P3", "P4"]);
  it("plans the setup curve for every pot even when the controller still had the old curve at creation", () => {
    // Audit 2026-11-25: after the controller confirmed "Audit peat" on 4/4 pots, Settings said the plan used
    // Substrate v1 on 4/4 pots and Audit peat on 0/4.
    const pairings = [1, 2, 3, 4].map((pot) => ({ name: `P${pot}`, pot_number: pot, calibration_name: "Audit peat" }));
    const use = soilCurveUse("Audit peat", assignments, pairings, names);
    expect(use.get("Audit peat")).toEqual({ planned: [1, 2, 3, 4], reported: [1, 2, 3, 4], snapshot: [] });
    expect(use.get("Substrate v1")).toEqual({ planned: [], reported: [], snapshot: [1, 2, 3, 4] });
  });
  it("uses the per-pot snapshot as the plan when no curve was chosen in setup", () => {
    const use = soilCurveUse(undefined, assignments, [], names);
    expect(use.get("Substrate v1")?.planned).toEqual([1, 2, 3, 4]);
  });
});
