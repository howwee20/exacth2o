import { expiredPortalSessionNotice, isSessionAuthorizationError } from "./authSession";
import { plantGroupForPairing, plantGroupLabel, treatmentForPairing, treatmentLabel } from "./portalPresentation";
import { type BoardConfig, type ControlCommandType, type DeviceHealthSnapshot, type DeviceRuntimeState } from "./portalTypes";
import { type PairingRow } from "./types";

export function formatDateTime(value?: string | number | null) {
  if (!value) return "none";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "none";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatSettingsTimestamp(value?: string | number | null) {
  if (!value) return "--";
  const formatted = formatDateTime(value);
  return formatted === "none" ? "--" : formatted;
}

export function supportStatusLabel(status?: string | null) {
  if (!status) return "New";
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function supportStatusTone(status?: string | null): "ok" | "warning" | "bad" | "unknown" {
  if (status === "won" || status === "closed") return "ok";
  if (status === "lost") return "bad";
  if (status === "waiting_on_customer" || status === "quoted") return "warning";
  return "unknown";
}

export function supportRequestTypeLabel(value?: string | null) {
  if (!value) return "Support";
  if (value === "docs") return "Documentation";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function supportExcerpt(value?: string | null, maxLength = 160) {
  if (!value) return "No message preview.";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

export function mailtoUrl(email: string, subject?: string | null) {
  const params = new URLSearchParams();
  if (subject) params.set("subject", `Re: ${subject}`);
  return `mailto:${email}${params.size ? `?${params.toString()}` : ""}`;
}

export function supportDetailValue(value?: string | number | null) {
  if (value == null) return "Not provided";
  const text = String(value).trim();
  return text || "Not provided";
}

export function formatHealthNumber(value?: number | null, digits = 1, suffix = "") {
  if (value == null || !Number.isFinite(value)) return "Not synced";
  return `${Number(value.toFixed(digits))}${suffix}`;
}

export function formatHealthInteger(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "Not synced";
  return Math.trunc(value).toLocaleString();
}

export function formatHealthBoolean(value?: boolean | null, trueLabel = "Yes", falseLabel = "No") {
  if (value == null) return "Not synced";
  return value ? trueLabel : falseLabel;
}

export function healthSnapshotTimestamp(snapshot: DeviceHealthSnapshot) {
  const timestamp = snapshot.captured_at ?? snapshot.created_at;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function selectHealthSnapshot(snapshots: DeviceHealthSnapshot[]) {
  return snapshots
    .filter(Boolean)
    .sort((a, b) => healthSnapshotTimestamp(b) - healthSnapshotTimestamp(a))[0] ?? null;
}

export function runtimeStateIsFresh(runtimeState?: DeviceRuntimeState | null) {
  if (!runtimeState?.state_fresh_until) return false;
  const freshUntil = Date.parse(runtimeState.state_fresh_until);
  return Number.isFinite(freshUntil) && freshUntil > Date.now();
}

export function syncedCount(value?: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : Math.trunc(value).toLocaleString();
}

export function formatTargetVwc(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not set";
  if (value <= -9999) return "Disabled";
  return `${Number(value.toFixed(1))}%`;
}

export function formatSecondsFromMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not set";
  const seconds = value / 1000;
  return `${Number(seconds.toFixed(seconds >= 10 ? 0 : 1))} sec`;
}

export function formatIntervalFromMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not set";
  const seconds = Math.round(value / 1000);
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function settingValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function boardConfigsFromPayload(payload?: Record<string, unknown> | null): BoardConfig[] {
  if (!payload) return [];
  const records = [
    payload,
    isRecord(payload.config) ? payload.config : null,
    isRecord(payload.system) ? payload.system : null,
    isRecord(payload.state) ? payload.state : null,
  ].filter((item): item is Record<string, unknown> => Boolean(item));

  for (const record of records) {
    for (const key of ["board_configurations", "boardConfigs", "board_configs", "boards"]) {
      const value = record[key];
      if (!Array.isArray(value)) continue;
      const configs = value
        .filter(isRecord)
        .map((item) => ({
          address: settingValue(item, ["address", "addr", "i2c_address", "i2cAddress"]),
          resetPin: settingValue(item, ["reset_pin", "resetPin", "reset", "pin"]),
        }))
        .filter((item) => item.address || item.resetPin);
      if (configs.length > 0) return configs;
    }
  }
  return [];
}

export function pairingCalibrationName(pairing: PairingRow) {
  const row = pairing as PairingRow & Record<string, unknown>;
  const value =
    row.calibration_name ??
    row.calibration ??
    row.calibration_label ??
    row.calibration_id;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return `Calibration ${value}`;
  return "Not synced";
}

export function pairingGroupName(pairing: PairingRow) {
  const row = pairing as PairingRow & Record<string, unknown>;
  const value =
    row.group_name ??
    row.group ??
    row.group_label ??
    row.pairing_group ??
    row.project_group;
  if (typeof value === "string" && value.trim()) return value;
  return `${plantGroupLabel(plantGroupForPairing(pairing))} ${treatmentLabel(treatmentForPairing(pairing))}`;
}

export function numberInputString(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "";
  return Number(value.toFixed(digits)).toString();
}
export function errorMessage(error: unknown) {
  if (isSessionAuthorizationError(error)) return expiredPortalSessionNotice;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Request failed. Please try again.";
}

export async function functionErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context;
    if (typeof Response !== "undefined" && context instanceof Response) {
      try {
        const body = await context.clone().json();
        if (body && typeof body.error === "string") return body.error;
      } catch {
        // Fall through to the generic error parser.
      }
    }
  }
  return errorMessage(error);
}
export function controlCommandLabel(commandType: ControlCommandType) {
  const labels: Record<ControlCommandType, string> = {
    update_pairing: "Update pairing",
    bulk_update_pairings: "Bulk update pairings",
    create_pairing: "Create pairing",
    delete_pairing: "Delete pairing",
    create_group: "Create group",
    remove_group: "Remove group",
    create_calibration: "Create calibration",
    delete_calibration: "Delete calibration",
    apply_calibration: "Apply calibration",
    manual_water: "Manual water",
    update_board_config: "Update board config",
    initialize_sensors: "Initialize sensors",
    update_system_state: "Update system state",
    export_data: "Export data",
  };
  return labels[commandType];
}
