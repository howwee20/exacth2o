import { describe, expect, it } from "vitest";
import {
  experimentGraphGroups,
  experimentSidebarGroups,
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

  it("keeps the confirmed Pan crops together across zones and separates crops sharing a zone", () => {
    const maize = [16, 18, 20, 22, 24, 26];
    const sorghum = [65, 67, 69, 71, 73, 75];
    const pairings = [...maize, ...sorghum].map((number) => ({
      ...pairing,
      name: `Zone${number === 26 ? 4 : 3}-Pot${number}`,
      zone: number === 26 ? 4 : 3,
      pot_number: number,
      group_name: "Shared controller group",
    }));
    const pan = {
      ...experiment,
      pairingNames: pairings.map((item) => item.name),
      assignments: pairings.map((item) => ({
        ...experiment.assignments![0],
        pairing_name: item.name,
        zone: item.zone,
        pot_number: item.pot_number,
        crop: maize.includes(item.pot_number) ? "Maize" : "Sorghum",
        treatment: "Observation",
      })),
    };
    const groups = experimentSidebarGroups(pairings.slice().reverse(), pan);
    expect(groups.map((group) => [group.label, group.pairings.map((item) => item.pot_number)]))
      .toEqual([["Maize", maize], ["Sorghum", sorghum]]);
    expect(groups.flatMap((group) => group.pairings)).toHaveLength(12);
  });

  it("retains pots with missing crop metadata without displaying wiring zones", () => {
    const unassigned = { ...pairing, name: "Zone4-Pot26", zone: 4, pot_number: 26 };
    expect(experimentSidebarGroups([unassigned]).map((group) => group.label)).toEqual(["All pots"]);
    expect(experimentSidebarGroups([pairing, unassigned], experiment)
      .map((group) => [group.label, group.pairings.map((item) => item.pot_number)]))
      .toEqual([["Maize", [16]], ["Other pots", [26]]]);
  });
});
