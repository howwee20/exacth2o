import type { PairingRow } from "./types";
import type { ExperimentDraft, ExperimentDraftAssignment } from "./experimentSpec";

export type ExperimentValidationIssue = {
  path: string;
  message: string;
};

function cleanText(value: string | null, maxLength: number) {
  if (value === null) return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || null;
}

function normalizeAssignment(assignment: ExperimentDraftAssignment): ExperimentDraftAssignment {
  return {
    pairing_name: assignment.pairing_name.trim().slice(0, 120),
    crop: cleanText(assignment.crop, 80),
    treatment: cleanText(assignment.treatment, 80),
    block: cleanText(assignment.block, 80),
    substrate: cleanText(assignment.substrate, 80),
    target_vwc_percent: assignment.target_vwc_percent,
    measurement_interval_minutes: assignment.measurement_interval_minutes,
    notes: cleanText(assignment.notes, 300),
  };
}

export function normalizeExperimentDraft(draft: ExperimentDraft): ExperimentDraft {
  return {
    name: draft.name.trim().slice(0, 120),
    description: draft.description.trim().slice(0, 300),
    mode: draft.mode === "calibration" ? "calibration" : "observation",
    start_date: cleanText(draft.start_date, 40),
    assignments: draft.assignments.map(normalizeAssignment),
    visibility_roles: ["admin", "researcher"],
    watering_requested: draft.watering_requested === true,
    questions: draft.questions
      .map((question) => question.trim().slice(0, 180))
      .filter(Boolean)
      .slice(0, 12),
  };
}

export function validateExperimentDraft(
  draft: ExperimentDraft,
  inventory: PairingRow[],
): ExperimentValidationIssue[] {
  const issues: ExperimentValidationIssue[] = [];
  const normalized = normalizeExperimentDraft(draft);
  const inventoryByName = new Map(inventory.map((pairing) => [pairing.name, pairing]));
  const selectedNames = new Set<string>();
  const selectedSensorKeys = new Set<string>();
  const selectedValveKeys = new Set<string>();

  if (!normalized.name) {
    issues.push({ path: "name", message: "Name is required." });
  }

  if (normalized.assignments.length < 1) {
    issues.push({ path: "assignments", message: "Select at least one pot." });
  }

  if (normalized.assignments.length > 100) {
    issues.push({ path: "assignments", message: "An experiment can include at most 100 pots." });
  }

  if (normalized.watering_requested) {
    issues.push({
      path: "watering_requested",
      message: "Watering cannot be enabled by the experiment builder.",
    });
  }

  normalized.assignments.forEach((assignment, index) => {
    const path = `assignments.${index}`;
    const pairing = inventoryByName.get(assignment.pairing_name);
    if (!pairing) {
      issues.push({ path, message: `${assignment.pairing_name || "Unknown pot"} is not in the current inventory.` });
      return;
    }

    if (selectedNames.has(pairing.name)) {
      issues.push({ path, message: `${pairing.name} is selected more than once.` });
    }
    selectedNames.add(pairing.name);

    if (selectedSensorKeys.has(pairing.sensor_key)) {
      issues.push({ path, message: `${pairing.name} shares a sensor with another selected pot.` });
    }
    selectedSensorKeys.add(pairing.sensor_key);

    if (selectedValveKeys.has(pairing.valve_key)) {
      issues.push({ path, message: `${pairing.name} shares a valve with another selected pot.` });
    }
    selectedValveKeys.add(pairing.valve_key);

    if (
      assignment.target_vwc_percent !== null
      && (
        !Number.isFinite(assignment.target_vwc_percent)
        || assignment.target_vwc_percent < 0
        || assignment.target_vwc_percent > 100
      )
    ) {
      issues.push({ path: `${path}.target_vwc_percent`, message: "Target must be between 0% and 100%." });
    }

    if (
      assignment.measurement_interval_minutes !== null
      && (
        !Number.isFinite(assignment.measurement_interval_minutes)
        || assignment.measurement_interval_minutes < 1
        || assignment.measurement_interval_minutes > 1440
      )
    ) {
      issues.push({
        path: `${path}.measurement_interval_minutes`,
        message: "Measurement interval must be between 1 and 1,440 minutes.",
      });
    }
  });

  return issues;
}

export function experimentSlug(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return base || "experiment";
}
