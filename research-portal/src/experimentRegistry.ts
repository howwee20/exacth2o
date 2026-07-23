import type { PairingRow, SensorReading, ValveEvent } from "./types";

export type ExperimentId = "matt-experiment" | "matt-experiment-2" | "swc-saturation-calibration";
export type ExperimentMode = "controlled" | "calibration";
export type ExperimentPortalRole = "admin" | "researcher" | "viewer";

export type PortalExperiment = {
  id: ExperimentId;
  name: string;
  shortDescription: string;
  mode: ExperimentMode;
  groupNames: readonly string[];
  pairingNames: readonly string[];
  startedAt?: string;
  endedAt?: string;
};

export const swcCalibrationStartedAt = "2026-07-23T14:46:34.000Z";

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

const swcCalibrationPairings = [
  "Zone2-Pot41", "Zone2-Pot43", "Zone2-Pot45", "Zone2-Pot47", "Zone2-Pot49",
  "Zone4-Pot91", "Zone4-Pot93", "Zone4-Pot95", "Zone4-Pot97", "Zone4-Pot99",
] as const;

const mattExperiment1: PortalExperiment = {
  id: "matt-experiment",
  name: "Matt Experiment 1",
  shortDescription: "Original 20-pot experiment",
  mode: "controlled",
  groupNames: ["Matt's 20 pots"],
  pairingNames: mattExperimentPairings,
  endedAt: swcCalibrationStartedAt,
};

const mattExperiment2: PortalExperiment = {
  id: "matt-experiment-2",
  name: "Matt Experiment 2",
  shortDescription: "24 pots · 30% target",
  mode: "controlled",
  groupNames: ["Matt Experiment 2 - Observation Only", "Matt Experiment 2 — Observation Only"],
  pairingNames: mattExperiment2Pairings,
};

const swcSaturationCalibration: PortalExperiment = {
  id: "swc-saturation-calibration",
  name: "SWC Saturation Calibration",
  shortDescription: "100% target · 10 s / 10 min",
  mode: "calibration",
  groupNames: [],
  pairingNames: swcCalibrationPairings,
  startedAt: swcCalibrationStartedAt,
};

export const portalExperiments: readonly PortalExperiment[] = [
  mattExperiment1,
  mattExperiment2,
  swcSaturationCalibration,
] as const;

const researcherExperiments: readonly PortalExperiment[] = [
  mattExperiment2,
  swcSaturationCalibration,
] as const;

const experimentById = new Map(portalExperiments.map((experiment) => [experiment.id, experiment]));

export function portalExperimentsForRole(role: ExperimentPortalRole | null | undefined) {
  return role === "admin" ? portalExperiments : researcherExperiments;
}

export function portalExperimentById(id: ExperimentId): PortalExperiment {
  return experimentById.get(id) ?? mattExperiment2;
}

export function pairingBelongsToExperiment(pairing: PairingRow, experiment: PortalExperiment) {
  return new Set<string>(experiment.pairingNames).has(pairing.name) ||
    (typeof pairing.group_name === "string" && new Set<string>(experiment.groupNames).has(pairing.group_name));
}

export function pairingsForExperiment(pairings: PairingRow[], experiment: PortalExperiment) {
  return pairings.filter((pairing) => pairingBelongsToExperiment(pairing, experiment));
}

export function timestampBelongsToExperiment(timestamp: string, experiment: PortalExperiment) {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (experiment.startedAt && timestampMs < Date.parse(experiment.startedAt)) return false;
  if (experiment.endedAt && timestampMs >= Date.parse(experiment.endedAt)) return false;
  return true;
}

export function readingsForExperiment(readings: SensorReading[], experiment: PortalExperiment) {
  const names = new Set<string>(experiment.pairingNames);
  return readings.filter((reading) =>
    names.has(reading.pairing_name) &&
    timestampBelongsToExperiment(reading.device_recorded_at, experiment)
  );
}

export function valveEventsForExperiment(events: ValveEvent[], experiment: PortalExperiment) {
  const names = new Set<string>(experiment.pairingNames);
  return events.filter((event) =>
    names.has(event.pairing_name) &&
    timestampBelongsToExperiment(event.device_recorded_at ?? event.server_received_at, experiment)
  );
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
  return !["controlled", "calibration"].includes(experiment.mode);
}

export function isCalibrationExperiment(experiment: PortalExperiment) {
  return experiment.mode === "calibration";
}

export function experimentCardDescription(experiment: PortalExperiment, pairings: PairingRow[]) {
  if (!isCalibrationExperiment(experiment) || pairings.length === 0) return experiment.shortDescription;

  const wateringEnabled = pairings.filter((pairing) =>
    pairing.valve_open_time_ms > 0 && pairing.wtc_percent_limit > -999_000
  );
  if (wateringEnabled.length === 0) return "Sensing only";

  const first = wateringEnabled[0];
  const sameConfiguration = wateringEnabled.length === pairings.length &&
    wateringEnabled.every((pairing) =>
      pairing.wtc_percent_limit === first.wtc_percent_limit &&
      pairing.valve_open_time_ms === first.valve_open_time_ms &&
      pairing.measurement_interval_ms === first.measurement_interval_ms
    );

  if (!sameConfiguration) return "Calibration active";

  const seconds = first.valve_open_time_ms / 1000;
  const minutes = first.measurement_interval_ms / 60_000;
  return `${first.wtc_percent_limit}% target · ${seconds} s / ${minutes} min`;
}
