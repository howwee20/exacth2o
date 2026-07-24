import { describe, expect, it } from "vitest";
import {
  experimentGraphGroups,
  plantGroupForExperimentPairing,
  treatmentForExperimentPairing,
} from "./experimentPresentation";
import type { PortalExperiment } from "./experimentRegistry";
import type { PairingRow } from "./types";

const pairing = {
  name: "Zone1-Pot16",
  zone: 1,
  pot_number: 16,
  group_name: "legacy label",
} as PairingRow;

const experiment: PortalExperiment = {
  id: "trial",
  name: "Trial",
  shortDescription: "",
  mode: "controlled",
  groupNames: [],
  pairingNames: ["Zone1-Pot16", "Zone1-Pot18"],
  assignments: [
    {
      pairing_name: "Zone1-Pot16",
      zone: 1,
      pot_number: 16,
      crop: "Maize",
      treatment: "Drought",
      block: null,
      substrate: null,
      target_vwc_percent: 10,
      measurement_interval_minutes: 10,
    },
    {
      pairing_name: "Zone1-Pot18",
      zone: 1,
      pot_number: 18,
      crop: "Maize",
      treatment: "Drought",
      block: null,
      substrate: null,
      target_vwc_percent: 10,
      measurement_interval_minutes: 10,
    },
  ],
};

describe("experiment presentation", () => {
  it("uses assignment metadata rather than experiment names or pot-number rules", () => {
    expect(treatmentForExperimentPairing(pairing, experiment)).toBe("drought");
    expect(plantGroupForExperimentPairing(pairing, experiment)).toBe("maize");
  });

  it("builds graph groups from the current revision assignments", () => {
    expect(experimentGraphGroups(experiment)).toEqual([
      {
        id: "maize-drought",
        label: "Maize Drought",
        crop: "maize",
        treatment: "drought",
        target: 10,
        pairingNames: ["Zone1-Pot16", "Zone1-Pot18"],
        potNumbers: [16, 18],
      },
    ]);
  });
});
