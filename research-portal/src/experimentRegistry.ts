import type { PairingRow, SensorReading, ValveEvent } from "./types";
import type { ExperimentDraft } from "./experimentSpec";

export type ExperimentId = string;
export type ExperimentMode = "controlled" | "observation" | "calibration";
export type ExperimentPortalRole = "admin" | "researcher" | "viewer";

export type PortalExperimentAssignment = {
  pot_id?: string | null;
  pairing_name: string;
  zone: number;
  pot_number: number;
  crop: string | null;
  treatment: string | null;
  block: string | null;
  substrate: string | null;
  target_vwc_percent: number | null;
  measurement_interval_minutes: number | null;
};

export type PortalExperiment = {
  id: ExperimentId;
  databaseId?: string;
  currentRevisionId?: string;
  currentVersion?: number;
  currentSpec?: ExperimentDraft;
  name: string;
  shortDescription: string;
  mode: ExperimentMode;
  status?:
    | "published_sensing"
    | "activating"
    | "active"
    | "activation_failed"
    | "completed"
    | "archived";
  wateringState?: "off" | "controller_managed";
  groupNames: readonly string[];
  pairingNames: readonly string[];
  assignments?: readonly PortalExperimentAssignment[];
  startedAt?: string;
  endedAt?: string;
};

export type ExperimentPotOccupancy = {
  experimentId: string;
  experimentName: string;
};

const potOccupyingStatuses = new Set<NonNullable<PortalExperiment["status"]>>([
  "published_sensing",
  "activating",
  "active",
  "activation_failed",
]);

const emptyExperiment: PortalExperiment = {
  id: "unavailable",
  name: "Experiment unavailable",
  shortDescription: "The experiment catalog has not loaded.",
  mode: "observation",
  wateringState: "off",
  groupNames: [],
  pairingNames: [],
  assignments: [],
};

export function portalExperimentsForRole(role: ExperimentPortalRole | null | undefined) {
  void role;
  return [] as readonly PortalExperiment[];
}

export function mergePortalExperiments(
  fallback: readonly PortalExperiment[],
  catalog: readonly PortalExperiment[],
) {
  const merged = new Map(fallback.map((experiment) => [experiment.id, experiment]));
  for (const experiment of catalog) merged.set(experiment.id, experiment);
  return Array.from(merged.values());
}

export function activeExperimentPotOccupancy(
  experiments: readonly PortalExperiment[],
  excludedExperimentId?: string,
) {
  const occupied = new Map<string, ExperimentPotOccupancy[]>();
  for (const experiment of experiments) {
    const identity = experiment.databaseId ?? experiment.id;
    if (
      identity === excludedExperimentId ||
      !experiment.status ||
      !potOccupyingStatuses.has(experiment.status)
    ) continue;

    for (const pairingName of experiment.pairingNames) {
      const current = occupied.get(pairingName) ?? [];
      current.push({
        experimentId: identity,
        experimentName: experiment.name,
      });
      occupied.set(pairingName, current);
    }
  }
  return occupied;
}

export function portalExperimentById(
  id: ExperimentId,
  experiments: readonly PortalExperiment[] = [],
): PortalExperiment {
  return experiments.find((experiment) => experiment.id === id) ??
    experiments[0] ??
    emptyExperiment;
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
  return experiment.wateringState === "off" || experiment.mode === "observation";
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
