import type { ExperimentDraftAssignment, ExperimentBuilderMode } from "./experimentSpec";
import type { PairingRow } from "./types";

/** Observation never inherits an enabled valve from the current inventory or a template. */
export function assignmentForMode(
  pairing: PairingRow,
  mode: ExperimentBuilderMode,
  template?: ExperimentDraftAssignment,
): ExperimentDraftAssignment {
  const assignment: ExperimentDraftAssignment = template
    ? { ...template, pairing_name: pairing.name }
    : {
      pairing_name: pairing.name,
      crop: null, treatment: null, block: null, substrate: null, notes: null,
      watering_enabled: pairing.wtc_percent_limit > -1_000,
      target_vwc_percent: pairing.wtc_percent_limit > -1_000 ? pairing.wtc_percent_limit : null,
      valve_open_seconds: Math.max(1, pairing.valve_open_time_ms / 1_000),
      measurement_interval_minutes: Math.max(0.5, pairing.measurement_interval_ms / 60_000),
    };
  return mode === "observation"
    ? { ...assignment, watering_enabled: false, target_vwc_percent: null, valve_open_seconds: null }
    : assignment;
}

export function commonAssignmentValue<K extends keyof ExperimentDraftAssignment>(
  assignments: readonly ExperimentDraftAssignment[], key: K,
): ExperimentDraftAssignment[K] | "" {
  const value = assignments[0]?.[key];
  return value !== undefined && assignments.every((assignment) => assignment[key] === value) ? value : "";
}
