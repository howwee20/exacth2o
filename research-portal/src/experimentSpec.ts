import type { PairingRow } from "./types";

export type ExperimentBuilderMode = "observation" | "calibration";
export type ExperimentDraftSource = "manual" | "natural_language";

export type ExperimentDraftAssignment = {
  pairing_name: string;
  crop: string | null;
  treatment: string | null;
  block: string | null;
  substrate: string | null;
  target_vwc_percent: number | null;
  measurement_interval_minutes: number | null;
  notes: string | null;
};

export type ExperimentDraft = {
  name: string;
  description: string;
  mode: ExperimentBuilderMode;
  start_date: string | null;
  assignments: ExperimentDraftAssignment[];
  visibility_roles: Array<"admin" | "researcher">;
  watering_requested: boolean;
  questions: string[];
};

export type ExperimentInventoryItem = Pick<
  PairingRow,
  | "name"
  | "zone"
  | "pot_number"
  | "group_name"
  | "sensor_key"
  | "valve_key"
  | "calibration_name"
  | "wtc_percent_limit"
  | "valve_open_time_ms"
  | "measurement_interval_ms"
>;

export type ExperimentDraftResponse = {
  draft: ExperimentDraft;
  inventory_updated_at: string;
  source: ExperimentDraftSource;
  model: string | null;
  prompt_fingerprint: string | null;
  validation_messages: string[];
};

export const experimentDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 300 },
    mode: { type: "string", enum: ["observation", "calibration"] },
    start_date: { type: ["string", "null"], maxLength: 40 },
    assignments: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pairing_name: { type: "string", minLength: 1, maxLength: 120 },
          crop: { type: ["string", "null"], maxLength: 80 },
          treatment: { type: ["string", "null"], maxLength: 80 },
          block: { type: ["string", "null"], maxLength: 80 },
          substrate: { type: ["string", "null"], maxLength: 80 },
          target_vwc_percent: { type: ["number", "null"], minimum: 0, maximum: 100 },
          measurement_interval_minutes: { type: ["number", "null"], minimum: 1, maximum: 1440 },
          notes: { type: ["string", "null"], maxLength: 300 },
        },
        required: [
          "pairing_name",
          "crop",
          "treatment",
          "block",
          "substrate",
          "target_vwc_percent",
          "measurement_interval_minutes",
          "notes",
        ],
      },
    },
    visibility_roles: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "string", enum: ["admin", "researcher"] },
    },
    watering_requested: { type: "boolean" },
    questions: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 180 },
    },
  },
  required: [
    "name",
    "description",
    "mode",
    "start_date",
    "assignments",
    "visibility_roles",
    "watering_requested",
    "questions",
  ],
} as const;

export function emptyExperimentDraft(): ExperimentDraft {
  return {
    name: "",
    description: "",
    mode: "observation",
    start_date: null,
    assignments: [],
    visibility_roles: ["admin", "researcher"],
    watering_requested: false,
    questions: [],
  };
}

export function manualExperimentDraft(
  pairings: PairingRow[],
  selectedNames: Iterable<string> = [],
): ExperimentDraft {
  const selected = new Set(selectedNames);
  const assignments = pairings
    .filter((pairing) => selected.has(pairing.name))
    .map((pairing) => ({
      pairing_name: pairing.name,
      crop: null,
      treatment: null,
      block: null,
      substrate: null,
      target_vwc_percent: null,
      measurement_interval_minutes: Math.round(pairing.measurement_interval_ms / 60_000),
      notes: null,
    }));

  return {
    ...emptyExperimentDraft(),
    assignments,
  };
}
