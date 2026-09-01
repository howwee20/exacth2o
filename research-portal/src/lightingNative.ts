export const lightingProjectId = "44444444-4444-4444-8444-444444444441";
export const lightingDeviceId = "lighting:beagle";
export const lightingMinIntensity = 10;
export const lightingMaxIntensity = 255;

export type LightingCommandStatus =
  | "queued"
  | "received"
  | "validated"
  | "applied"
  | "observed"
  | "failed"
  | "expired";

export type LightingNativeStatus = {
  project_id: string;
  device_id: string;
  bridge_ready: boolean;
  bridge_version: string | null;
  last_bridge_at: string | null;
  state_revision: number;
  requested_intensity: number;
  controller_intensity: number;
  last_nonzero_intensity: number;
  last_source: "startup" | "local" | "timeline" | "portal";
  hardware_verification: "unavailable";
  controller_process_started_at: string | null;
  remote_control_allowed: boolean;
  last_command: {
    id: string;
    intensity: number;
    status: LightingCommandStatus;
    created_at: string;
    completed_at: string | null;
    controller_intensity: number | null;
    error_message: string | null;
  } | null;
};

export function normalizeLightingIntensity(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric)) throw new Error("Intensity must be a whole number");
  if (numeric !== 0 && (numeric < lightingMinIntensity || numeric > lightingMaxIntensity)) {
    throw new Error(`Enter 0 (off) or ${lightingMinIntensity}-${lightingMaxIntensity}`);
  }
  return numeric;
}

export function lightingSourceLabel(source: LightingNativeStatus["last_source"]) {
  if (source === "portal") return "ExactH2O portal";
  if (source === "timeline") return "Local schedule";
  if (source === "local") return "Windows controller";
  return "Controller startup";
}
