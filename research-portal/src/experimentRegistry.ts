import type { PairingRow, SensorReading } from "./types";

export type ExperimentId = "matt-experiment" | "matt-experiment-2" | "oven-dry-experiment";
export type ExperimentMode = "controlled" | "observation_only";

export type PortalExperiment = {
  id: ExperimentId;
  name: string;
  shortDescription: string;
  mode: ExperimentMode;
  groupNames: readonly string[];
  pairingNames: readonly string[];
};

const mattExperimentPairings = [
  "Zone2-Pot41", "Zone2-Pot42", "Zone2-Pot43", "Zone2-Pot44", "Zone2-Pot45",
  "Zone2-Pot46", "Zone2-Pot47", "Zone2-Pot48", "Zone2-Pot49", "Zone2-Pot50",
  "Zone4-Pot91", "Zone4-Pot92", "Zone4-Pot93", "Zone4-Pot94", "Zone4-Pot95",
  "Zone4-Pot96", "Zone4-Pot97", "Zone4-Pot98", "Zone4-Pot99", "Zone4-Pot100",
] as const;

const mattExperiment2Pairings = [
  "Zone1-Pot15", "Zone1-Pot16", "Zone1-Pot17", "Zone1-Pot18", "Zone1-Pot19",
  "Zone1-Pot20", "Zone1-Pot21", "Zone1-Pot22", "Zone1-Pot23", "Zone1-Pot24",
  "Zone1-Pot25", "Zone2-Pot26", "Zone3-Pot65", "Zone3-Pot66", "Zone3-Pot67",
  "Zone3-Pot68", "Zone3-Pot69", "Zone3-Pot70", "Zone3-Pot71", "Zone3-Pot72",
  "Zone3-Pot73", "Zone3-Pot74", "Zone3-Pot75", "Zone4-Pot76",
] as const;

const ovenDryPairings = [
  "Zone1-Pot02", "Zone1-Pot04", "Zone1-Pot06", "Zone3-Pot51", "Zone3-Pot52",
  "Zone3-Pot53", "Zone3-Pot54", "Zone3-Pot55", "Zone3-Pot56", "Zone3-Pot57",
  "Zone3-Pot58", "Zone3-Pot59", "Zone3-Pot60", "Zone3-Pot61", "Zone3-Pot62",
] as const;

export const portalExperiments: readonly PortalExperiment[] = [
  {
    id: "matt-experiment",
    name: "Matt Experiment",
    shortDescription: "Original 20-pot controlled experiment",
    mode: "controlled",
    groupNames: ["Matt's 20 pots"],
    pairingNames: mattExperimentPairings,
  },
  {
    id: "matt-experiment-2",
    name: "Matt Experiment 2",
    shortDescription: "24 pots · measurement only",
    mode: "observation_only",
    groupNames: ["Matt Experiment 2 - Observation Only", "Matt Experiment 2 — Observation Only"],
    pairingNames: mattExperiment2Pairings,
  },
  {
    id: "oven-dry-experiment",
    name: "Oven-Dry Experiment",
    shortDescription: "15 pots · measurement only",
    mode: "observation_only",
    groupNames: ["Oven-Dry Experiment - Observation Only", "Oven-Dry Experiment — Observation Only"],
    pairingNames: ovenDryPairings,
  },
] as const;

const experimentById = new Map(portalExperiments.map((experiment) => [experiment.id, experiment]));

export function portalExperimentById(id: ExperimentId): PortalExperiment {
  return experimentById.get(id) ?? portalExperiments[0];
}

export function pairingBelongsToExperiment(pairing: PairingRow, experiment: PortalExperiment) {
  return new Set<string>(experiment.pairingNames).has(pairing.name) ||
    (typeof pairing.group_name === "string" && new Set<string>(experiment.groupNames).has(pairing.group_name));
}

export function pairingsForExperiment(pairings: PairingRow[], experiment: PortalExperiment) {
  return pairings.filter((pairing) => pairingBelongsToExperiment(pairing, experiment));
}

export function readingsForExperiment(readings: SensorReading[], experiment: PortalExperiment) {
  const names = new Set<string>(experiment.pairingNames);
  return readings.filter((reading) => names.has(reading.pairing_name));
}

export function latestExperimentReading(readings: SensorReading[], experiment: PortalExperiment) {
  return readingsForExperiment(readings, experiment).reduce<SensorReading | null>((latest, reading) => {
    if (!latest) return reading;
    return new Date(reading.device_recorded_at).getTime() > new Date(latest.device_recorded_at).getTime()
      ? reading
      : latest;
  }, null);
}

export function isObservationOnlyExperiment(experiment: PortalExperiment) {
  return experiment.mode === "observation_only";
}
