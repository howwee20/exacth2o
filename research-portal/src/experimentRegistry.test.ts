import { describe, expect, it } from "vitest";

import {
  isObservationOnlyExperiment,
  portalExperimentById,
  portalExperiments,
} from "./experimentRegistry";

describe("experiment registry", () => {
  it("defines three disjoint experiments with the approved pot counts", () => {
    expect(portalExperiments.map((experiment) => experiment.pairingNames.length)).toEqual([20, 24, 15]);
    const allNames = portalExperiments.flatMap((experiment) => experiment.pairingNames);
    expect(new Set(allNames).size).toBe(59);
  });

  it("keeps both Matt experiments controller-enabled and Oven-Dry protected", () => {
    expect(isObservationOnlyExperiment(portalExperimentById("matt-experiment"))).toBe(false);
    expect(isObservationOnlyExperiment(portalExperimentById("matt-experiment-2"))).toBe(false);
    expect(isObservationOnlyExperiment(portalExperimentById("oven-dry-experiment"))).toBe(true);
  });

  it("numbers the two Matt experiments consistently in the portal", () => {
    expect(portalExperimentById("matt-experiment").name).toBe("Matt Experiment 1");
    expect(portalExperimentById("matt-experiment-2").name).toBe("Matt Experiment 2");
  });

  it("includes Oven-Dry Pot 51 instead of treating it as a diagnostic mapping", () => {
    expect(portalExperimentById("oven-dry-experiment").pairingNames).toContain("Zone3-Pot51");
  });
});
