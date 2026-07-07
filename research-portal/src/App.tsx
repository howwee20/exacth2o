import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Database,
  Download,
  ExternalLink,
  FileArchive,
  Gauge,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  Minimize2,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "./supabase";
import type { LatestState, PairingRow, SensorReading } from "./types";

const graphReadLimit = 12_000;
const pageSize = 1000;
const maxExportRowsPerSource = 100_000;
const autoRefreshMs = 15_000;
const staleAfterMs = 15 * 60 * 1000;
const maxPointsPerSeries = graphReadLimit;
const tenMinutesMs = 10 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

const importedPrefix = "balena-export-v2:%";
const livePrefix = "live-device:%";
const rememberEmailKey = "exacth2o.portal.rememberEmail";
const controlPots = new Set([41, 43, 45, 47, 49, 91, 93, 95, 97, 99]);
const droughtPots = new Set([42, 44, 46, 48, 50, 92, 94, 96, 98, 100]);

const zone2Palette = [
  "#2563eb",
  "#f97316",
  "#0891b2",
  "#dc2626",
  "#14b8a6",
  "#7c3aed",
  "#16a34a",
  "#db2777",
  "#6366f1",
  "#ca8a04",
];

const zone4Palette = [
  "#22c55e",
  "#a855f7",
  "#84cc16",
  "#0ea5e9",
  "#ea580c",
  "#2563eb",
  "#c026d3",
  "#10b981",
  "#e11d48",
  "#f59e0b",
];

type DataMode = "auto" | "live" | "snapshot" | "combined";
type EffectiveMode = Exclude<DataMode, "auto">;
type ViewMode = "group" | "traces" | "individual" | "qc";

type LoadState = {
  pairings: PairingRow[];
  latestState: LatestState | null;
  readings: SensorReading[];
  totalImportedReadings: number;
  totalLiveReadings: number;
  latestLiveReading: SensorReading | null;
  latestIngestTime: string | null;
  lastCheckedAt: string | null;
  lastNewDataAt: string | null;
  effectiveMode: EffectiveMode;
};

type ChartPoint = {
  timestampMs: number;
  value: number;
  reading: SensorReading;
};

type ChartSeries = {
  name: string;
  kind: "pot" | "group";
  zone: number;
  potNumber: number;
  treatment: Treatment;
  plantGroup: PlantGroup;
  color: string;
  points: ChartPoint[];
  rawPointCount: number;
  memberCount?: number;
};

type Treatment = "control" | "drought" | "unknown";

type PlantGroup = "maize" | "sorghum" | "unknown";

type PotPreset = "all" | "control" | "drought" | "maize" | "sorghum" | "custom";
type AuthMode = "sign-in" | "accept-invite" | "set-password";

type InviteAcceptResponse = {
  ok?: boolean;
  session?: {
    access_token?: string;
    refresh_token?: string;
  };
};

type TooltipState = {
  x: number;
  y: number;
  seriesName: string;
  seriesKind: "pot" | "group";
  color: string;
  zone: number;
  potNumber: number;
  plantGroup: PlantGroup;
  treatment: Treatment;
  point: ChartPoint;
  locked?: boolean;
};

type PotStats = {
  latestValue: number | null;
  latestAt: string | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  dryingRatePerDay: number | null;
  missingReadings: number;
  sharpDropCount: number;
  status: "live" | "stale" | "warning" | "empty";
  warning: string | null;
};

type CsvDownload = {
  url: string;
  filename: string;
  rowCount: number;
};

type PanelPosition = {
  x: number;
  y: number;
};

type PanelSize = {
  width: number;
  height: number;
};

type SettingsSection =
  | "overview"
  | "pairings"
  | "calibrations"
  | "water"
  | "groups"
  | "hardware"
  | "exports"
  | "logs"
  | "access";

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  description: string;
  group: "Live System" | "Controls" | "Data" | "Admin";
  icon: LucideIcon;
};

type BoardConfig = {
  address: string;
  resetPin: string;
};

type ControlCommandType =
  | "update_pairing"
  | "bulk_update_pairings"
  | "create_pairing"
  | "create_group"
  | "remove_group"
  | "create_calibration"
  | "delete_calibration"
  | "apply_calibration"
  | "manual_water"
  | "update_board_config"
  | "initialize_sensors"
  | "update_system_state"
  | "export_data";

type ControlCommand = {
  id: string;
  project_id: string;
  device_id: string | null;
  command_type: ControlCommandType;
  payload: Record<string, unknown>;
  status: "queued" | "accepted" | "running" | "succeeded" | "failed" | "canceled" | "expired";
  requested_at: string;
  expires_at: string;
  requires_confirmation: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
};

type ControlCommandResponse = {
  ok?: boolean;
  command?: ControlCommand;
};

type QueueControlCommand = (
  commandType: ControlCommandType,
  payload: Record<string, unknown>,
  options?: { confirm?: boolean },
) => Promise<void>;

type TimeBounds = {
  startMs: number;
  endMs: number;
};

type TimeWindow = {
  start: number;
  end: number;
};

const defaultExpandedPanelSize: PanelSize = {
  width: 300,
  height: 430,
};
const minExpandedPanelSize: PanelSize = {
  width: 190,
  height: 46,
};
const fullTimeWindow: TimeWindow = {
  start: 0,
  end: 100,
};
const minTimeWindowSpan = 3;
const portalVersion = "20260706-loading-4day-graph";
const mattProjectId = "22222222-2222-4222-8222-222222222222";
const mattDeviceId = "3100e37ee3205651fe3dd86dafd4dc0c";

const settingsNavItems: SettingsNavItem[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Live device and project state",
    group: "Live System",
    icon: Gauge,
  },
  {
    id: "pairings",
    label: "Pairings",
    description: "Pots, sensors, valves, and targets",
    group: "Controls",
    icon: SlidersHorizontal,
  },
  {
    id: "calibrations",
    label: "Calibrations",
    description: "Sensor correction workspace",
    group: "Controls",
    icon: Activity,
  },
  {
    id: "water",
    label: "Water Control",
    description: "Targets and manual watering",
    group: "Controls",
    icon: ShieldCheck,
  },
  {
    id: "groups",
    label: "Groups",
    description: "Treatments and plant groups",
    group: "Controls",
    icon: Database,
  },
  {
    id: "hardware",
    label: "Hardware",
    description: "Boards, sensors, and system actions",
    group: "Controls",
    icon: Lock,
  },
  {
    id: "exports",
    label: "Exports",
    description: "CSV and project files",
    group: "Data",
    icon: FileArchive,
  },
  {
    id: "logs",
    label: "Logs & Audit",
    description: "Errors, commands, and traceability",
    group: "Data",
    icon: CircleAlert,
  },
  {
    id: "access",
    label: "Access",
    description: "Invite-only project membership",
    group: "Admin",
    icon: CheckCircle2,
  },
];

const settingsNavGroups = Array.from(
  settingsNavItems.reduce((groups, item) => {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    return groups;
  }, new Map<SettingsNavItem["group"], SettingsNavItem[]>()),
  ([label, items]) => ({ label, items }),
);

const initialLoadState: LoadState = {
  pairings: [],
  latestState: null,
  readings: [],
  totalImportedReadings: 0,
  totalLiveReadings: 0,
  latestLiveReading: null,
  latestIngestTime: null,
  lastCheckedAt: null,
  lastNewDataAt: null,
  effectiveMode: "snapshot",
};

function portalUrl() {
  if (window.location.hostname === "exacth2o.com") {
    return `${window.location.origin}/portal`;
  }
  return `${window.location.origin}${window.location.pathname}`;
}

function inviteTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("invite") ?? params.get("token") ?? "";
}

function initialEmail() {
  const params = new URLSearchParams(window.location.search);
  return params.get("email") ?? "";
}

function initialAuthMode(): AuthMode {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const authType = params.get("type") ?? hashParams.get("type");

  if (inviteTokenFromUrl()) return "accept-invite";
  if (authType === "recovery") return "set-password";
  return "sign-in";
}

function orderedPairings(pairings: PairingRow[]) {
  return pairings.slice().sort((a, b) => {
    if (a.zone !== b.zone) return a.zone - b.zone;
    if (a.pot_number !== b.pot_number) return a.pot_number - b.pot_number;
    return a.name.localeCompare(b.name);
  });
}

function colorForPairing(pairing: PairingRow) {
  if (pairing.zone === 2) {
    return zone2Palette[Math.max(0, pairing.pot_number - 41) % zone2Palette.length];
  }
  if (pairing.zone === 4) {
    return zone4Palette[Math.max(0, pairing.pot_number - 91) % zone4Palette.length];
  }
  return "#475569";
}

function treatmentForPot(potNumber?: number | null): Treatment {
  if (typeof potNumber !== "number") return "unknown";
  if (controlPots.has(potNumber)) return "control";
  if (droughtPots.has(potNumber)) return "drought";
  return "unknown";
}

function treatmentForPairing(pairing: PairingRow): Treatment {
  return treatmentForPot(pairing.pot_number);
}

function plantGroupForPot(potNumber?: number | null): PlantGroup {
  if (typeof potNumber !== "number") return "unknown";
  if (potNumber >= 41 && potNumber <= 50) return "maize";
  if (potNumber >= 91 && potNumber <= 100) return "sorghum";
  return "unknown";
}

function plantGroupForPairing(pairing: PairingRow): PlantGroup {
  return plantGroupForPot(pairing.pot_number);
}

function treatmentLabel(treatment: Treatment) {
  if (treatment === "control") return "Control";
  if (treatment === "drought") return "Drought";
  return "Unassigned";
}

function plantGroupLabel(plantGroup: PlantGroup) {
  if (plantGroup === "maize") return "Maize";
  if (plantGroup === "sorghum") return "Sorghum";
  return "Unassigned";
}

function metricValue(reading: SensorReading) {
  const value = reading.calibrated_value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

function samplePoints(points: ChartPoint[]) {
  if (points.length <= maxPointsPerSeries) return points;
  const sampled: ChartPoint[] = [];
  const stride = (points.length - 1) / (maxPointsPerSeries - 1);
  for (let index = 0; index < maxPointsPerSeries; index += 1) {
    sampled.push(points[Math.round(index * stride)]);
  }
  return sampled;
}

function chartSeries(pairings: PairingRow[], readings: SensorReading[]): ChartSeries[] {
  const grouped = new Map<string, ChartPoint[]>();

  for (const reading of readings) {
    if (!reading.pairing_name) continue;
    const value = metricValue(reading);
    if (value == null) continue;
    const timestampMs = new Date(reading.device_recorded_at).getTime();
    if (!Number.isFinite(timestampMs)) continue;

    const points = grouped.get(reading.pairing_name) ?? [];
    points.push({ timestampMs, value, reading });
    grouped.set(reading.pairing_name, points);
  }

  return pairings.map((pairing) => {
    const points = (grouped.get(pairing.name) ?? []).sort(
      (a, b) => a.timestampMs - b.timestampMs,
    );

    return {
      name: pairing.name,
      kind: "pot",
      zone: pairing.zone,
      potNumber: pairing.pot_number,
      treatment: treatmentForPairing(pairing),
      plantGroup: plantGroupForPairing(pairing),
      color: colorForPairing(pairing),
      points: samplePoints(points),
      rawPointCount: points.length,
    };
  });
}

function average(values: number[]) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPercent(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "none" : `${value.toFixed(digits)}%`;
}

function formatNumber(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "none" : value.toFixed(digits);
}

function statsForSeries(item?: ChartSeries | null): PotStats {
  if (!item || item.points.length === 0) {
    return {
      latestValue: null,
      latestAt: null,
      mean: null,
      min: null,
      max: null,
      dryingRatePerDay: null,
      missingReadings: 0,
      sharpDropCount: 0,
      status: "empty",
      warning: null,
    };
  }

  const values = item.points.map((point) => point.value);
  const first = item.points[0];
  const latest = item.points[item.points.length - 1];
  const spanMs = Math.max(1, latest.timestampMs - first.timestampMs);
  const expected = Math.max(0, Math.floor(spanMs / tenMinutesMs) + 1);
  let sharpDropCount = 0;
  let sharpDropMessage: string | null = null;

  for (let index = 1; index < item.points.length; index += 1) {
    const previous = item.points[index - 1];
    const current = item.points[index];
    const delta = current.value - previous.value;
    const elapsedMinutes = (current.timestampMs - previous.timestampMs) / 60_000;
    if (delta <= -3 && elapsedMinutes <= 45) {
      sharpDropCount += 1;
      if (!sharpDropMessage) {
        sharpDropMessage = `Sharp drop: ${previous.value.toFixed(1)}% to ${current.value.toFixed(1)}% in ${Math.max(1, Math.round(elapsedMinutes))} min`;
      }
    }
  }

  const latestAge = Date.now() - latest.timestampMs;
  const missingReadings = Math.max(0, expected - item.rawPointCount);
  const status =
    sharpDropCount > 0 || latest.value < 8 || missingReadings > 6
      ? "warning"
      : latestAge > staleAfterMs
        ? "stale"
        : "live";
  const warning =
    sharpDropMessage ??
    (latest.value < 8 ? `Low moisture: ${latest.value.toFixed(1)}% VWC` : null) ??
    (missingReadings > 6 ? `${missingReadings} estimated missing readings` : null);

  return {
    latestValue: latest.value,
    latestAt: latest.reading.device_recorded_at,
    mean: average(values),
    min: Math.min(...values),
    max: Math.max(...values),
    dryingRatePerDay: ((latest.value - first.value) / spanMs) * dayMs,
    missingReadings,
    sharpDropCount,
    status,
    warning,
  };
}

function formatDateTime(value?: string | number | null) {
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

function formatSettingsTimestamp(value?: string | number | null) {
  if (!value) return "Not synced";
  const formatted = formatDateTime(value);
  return formatted === "none" ? "Not synced" : formatted;
}

function formatTargetVwc(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not set";
  if (value <= -9999) return "Disabled";
  return `${Number(value.toFixed(1))}%`;
}

function formatSecondsFromMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not set";
  const seconds = value / 1000;
  return `${Number(seconds.toFixed(seconds >= 10 ? 0 : 1))} sec`;
}

function formatIntervalFromMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not set";
  const seconds = Math.round(value / 1000);
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function boardConfigsFromPayload(payload?: Record<string, unknown> | null): BoardConfig[] {
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

function pairingCalibrationName(pairing: PairingRow) {
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

function pairingGroupName(pairing: PairingRow) {
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

function numberInputString(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "";
  return Number(value.toFixed(digits)).toString();
}

function shortJson(value: unknown) {
  if (!value) return "No device payload synced yet.";
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 2400 ? `${json.slice(0, 2400)}\n...` : json;
  } catch {
    return "Device payload could not be rendered.";
  }
}

function axisLabel(timestampMs: number, spanMs: number) {
  const date = new Date(timestampMs);
  if (spanMs > 36 * 60 * 60 * 1000) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function newestByTime<T extends { device_recorded_at: string }>(items: T[]) {
  return (
    items.slice().sort(
      (a, b) =>
        new Date(b.device_recorded_at).getTime() -
        new Date(a.device_recorded_at).getTime(),
    )[0] ?? null
  );
}

function newestReadingTimestamp(readings: SensorReading[]) {
  const newest = newestByTime(readings);
  return newest?.device_recorded_at ?? null;
}

function resolveEffectiveMode(mode: DataMode, totalLiveReadings: number): EffectiveMode {
  if (mode === "auto") {
    return totalLiveReadings > 0 ? "live" : "snapshot";
  }
  return mode;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Request failed. Please try again.";
}

async function functionErrorMessage(error: unknown) {
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

function dedupeReadings(readings: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const reading of readings) {
    byKey.set(reading.event_id || String(reading.id), reading);
  }

  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        new Date(b.device_recorded_at).getTime() -
        new Date(a.device_recorded_at).getTime(),
    )
    .slice(0, graphReadLimit);
}

function mergeReadings(base: SensorReading[], incoming: SensorReading[]) {
  return dedupeReadings([...incoming, ...base]);
}

function dedupeReadingsForExport(readings: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const reading of readings) {
    byKey.set(reading.event_id || String(reading.id), reading);
  }

  return Array.from(byKey.values()).sort(
    (a, b) =>
      new Date(a.device_recorded_at).getTime() -
      new Date(b.device_recorded_at).getTime(),
  );
}

async function fetchAllReadingsByPrefix(prefix: string) {
  const readings: SensorReading[] = [];

  for (let from = 0; from < maxExportRowsPerSource; from += pageSize) {
    const response = await supabase
      .from("sensor_readings")
      .select("*")
      .like("event_id", prefix)
      .order("device_recorded_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (response.error) throw response.error;

    const page = (response.data ?? []) as SensorReading[];
    readings.push(...page);
    if (page.length < pageSize) break;
  }

  return readings;
}

async function fetchAllExportReadings() {
  const [importedReadings, liveReadings] = await Promise.all([
    fetchAllReadingsByPrefix(importedPrefix),
    fetchAllReadingsByPrefix(livePrefix),
  ]);

  return dedupeReadingsForExport([...importedReadings, ...liveReadings]);
}

async function fetchReadingsByPrefix(prefix: string, maxRows: number, newerThan?: string | null) {
  if (newerThan) {
    const response = await supabase
      .from("sensor_readings")
      .select("*")
      .like("event_id", prefix)
      .gt("device_recorded_at", newerThan)
      .order("device_recorded_at", { ascending: false })
      .limit(Math.min(pageSize, maxRows));

    if (response.error) throw response.error;
    return (response.data ?? []) as SensorReading[];
  }

  const pageCount = Math.ceil(maxRows / pageSize);
  const responses = await Promise.all(
    Array.from({ length: pageCount }, (_, page) =>
      supabase
        .from("sensor_readings")
        .select("*")
        .like("event_id", prefix)
        .order("device_recorded_at", { ascending: false })
        .range(page * pageSize, Math.min(maxRows, (page + 1) * pageSize) - 1),
    ),
  );

  for (const response of responses) {
    if (response.error) throw response.error;
  }

  return responses.flatMap((response) => response.data ?? []) as SensorReading[];
}

async function fetchReadingsForMode(mode: EffectiveMode, newerThan?: string | null) {
  if (mode === "live") {
    return fetchReadingsByPrefix(livePrefix, graphReadLimit, newerThan);
  }

  if (mode === "snapshot") {
    return fetchReadingsByPrefix(importedPrefix, graphReadLimit, newerThan);
  }

  const [liveReadings, importedReadings] = await Promise.all([
    fetchReadingsByPrefix(livePrefix, graphReadLimit, newerThan),
    fetchReadingsByPrefix(importedPrefix, graphReadLimit, newerThan),
  ]);

  return dedupeReadings([...liveReadings, ...importedReadings]);
}

async function countReadings(prefix: string) {
  const response = await supabase
    .from("sensor_readings")
    .select("id", { count: "exact", head: true })
    .like("event_id", prefix);
  if (response.error) throw response.error;
  return response.count ?? 0;
}

function sourceLabelForReading(reading: SensorReading) {
  if (reading.event_id.startsWith("live-device:")) return "live";
  if (reading.event_id.startsWith("balena-export-v2:")) return "snapshot";
  return "unknown";
}

function csvEscape(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function niceStep(range: number, targetTicks: number) {
  const roughStep = range / Math.max(1, targetTicks - 1);
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(roughStep, 0.1))));
  const normalized = roughStep / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

function vwcDomain(points: ChartPoint[]) {
  if (points.length === 0) {
    return {
      yMin: 0,
      yMax: 60,
      ySpan: 60,
      yTicks: [0, 15, 30, 45, 60],
    };
  }

  const values = points.map((point) => point.value);
  const rawMin = Math.max(0, Math.min(...values));
  const rawMax = Math.max(...values);
  const rawSpan = Math.max(1, rawMax - rawMin);
  const yPadding = Math.max(3, rawSpan * 0.12);
  const center = (rawMin + rawMax) / 2;
  const paddedSpan = Math.max(6, rawSpan + yPadding * 2);
  const paddedMin = Math.max(0, center - paddedSpan / 2);
  const paddedMax = Math.max(rawMax + yPadding, center + paddedSpan / 2);
  const step = niceStep(Math.max(1, paddedMax - paddedMin), 8);
  const yMin = Math.max(0, Math.floor(paddedMin / step) * step);
  const yMax = Math.max(yMin + step, Math.ceil(paddedMax / step) * step);
  const yTicks: number[] = [];

  for (let tick = yMin; tick <= yMax + step / 2; tick += step) {
    yTicks.push(Number(tick.toFixed(3)));
  }

  return {
    yMin,
    yMax,
    ySpan: Math.max(1, yMax - yMin),
    yTicks: yTicks.length >= 3 ? yTicks : [yMin, (yMin + yMax) / 2, yMax],
  };
}

function formatAxisTick(value: number) {
  return Math.abs(value - Math.round(value)) < 0.001 ? String(Math.round(value)) : value.toFixed(1);
}

function crispLine(value: number) {
  return Math.round(value) + 0.5;
}

function chartBounds(series: ChartSeries[], width: number, height: number) {
  const margin = { top: 22, right: 24, bottom: 54, left: 68 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const allPoints = series.flatMap((item) => item.points);
  const yDomain = vwcDomain(allPoints);
  const minX = allPoints.length ? Math.min(...allPoints.map((point) => point.timestampMs)) : 0;
  const maxX = allPoints.length ? Math.max(...allPoints.map((point) => point.timestampMs)) : 1;
  const spanX = Math.max(1, maxX - minX);

  const xScale = (timestampMs: number) =>
    margin.left + ((timestampMs - minX) / spanX) * plotWidth;
  const yScale = (value: number) => {
    const clamped = Math.max(yDomain.yMin, Math.min(yDomain.yMax, value));
    return margin.top + ((yDomain.yMax - clamped) / yDomain.ySpan) * plotHeight;
  };

  return {
    margin,
    plotWidth,
    plotHeight,
    ...yDomain,
    minX,
    maxX,
    spanX,
    xScale,
    yScale,
  };
}

function timeBoundsForSeries(series: ChartSeries[]): TimeBounds | null {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return null;
  return {
    startMs: Math.min(...points.map((point) => point.timestampMs)),
    endMs: Math.max(...points.map((point) => point.timestampMs)),
  };
}

function timeFromPercent(bounds: TimeBounds, percent: number) {
  const span = Math.max(1, bounds.endMs - bounds.startMs);
  return bounds.startMs + (span * percent) / 100;
}

function filterSeriesByTime(series: ChartSeries[], bounds: TimeBounds | null, window: TimeWindow) {
  if (!bounds || (window.start <= 0 && window.end >= 100)) return series;
  const startMs = timeFromPercent(bounds, window.start);
  const endMs = timeFromPercent(bounds, window.end);

  return series.map((item) => ({
    ...item,
    points: item.points.filter((point) => point.timestampMs >= startMs && point.timestampMs <= endMs),
  }));
}

function TimeRangeControl({
  bounds,
  value,
  onChange,
}: {
  bounds: TimeBounds | null;
  value: TimeWindow;
  onChange: (value: TimeWindow) => void;
}) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const start = Math.max(0, Math.min(value.start, value.end - minTimeWindowSpan));
  const end = Math.min(100, Math.max(value.end, value.start + minTimeWindowSpan));
  const isFull = start <= 0.1 && end >= 99.9;

  const percentFromClientX = useCallback((clientX: number) => {
    const slider = sliderRef.current;
    if (!slider) return null;
    const rect = slider.getBoundingClientRect();
    const inset = 12;
    const left = rect.left + inset;
    const width = Math.max(1, rect.width - inset * 2);
    return Math.max(0, Math.min(100, ((clientX - left) / width) * 100));
  }, []);

  const setEdgeFromClientX = useCallback(
    (edge: "start" | "end", clientX: number) => {
      const next = percentFromClientX(clientX);
      if (next == null) return;
      if (edge === "start") {
        onChange({
          start: Math.min(next, end - minTimeWindowSpan),
          end,
        });
        return;
      }
      onChange({
        start,
        end: Math.max(next, start + minTimeWindowSpan),
      });
    },
    [end, onChange, percentFromClientX, start],
  );

  const startDrag = useCallback(
    (edge: "start" | "end", event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      setEdgeFromClientX(edge, event.clientX);

      const move = (moveEvent: globalThis.PointerEvent) => {
        setEdgeFromClientX(edge, moveEvent.clientX);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [setEdgeFromClientX],
  );

  const startNearestDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const next = percentFromClientX(event.clientX);
      if (next == null) return;
      const edge = Math.abs(next - start) <= Math.abs(next - end) ? "start" : "end";
      startDrag(edge, event);
    },
    [end, percentFromClientX, start, startDrag],
  );

  if (!bounds) return null;
  const startMs = timeFromPercent(bounds, start);
  const endMs = timeFromPercent(bounds, end);

  return (
    <div
      className="time-range-control"
      style={{
        "--range-start": `${start}%`,
        "--range-end": `${100 - end}%`,
      } as CSSProperties}
    >
      <div className="time-range-labels">
        <span>{formatDateTime(startMs)}</span>
        <button type="button" onClick={() => onChange(fullTimeWindow)} disabled={isFull}>
          Full
        </button>
        <span>{formatDateTime(endMs)}</span>
      </div>
      <div className="time-range-slider" ref={sliderRef} onPointerDown={startNearestDrag}>
        <div className="time-range-track">
          <span />
        </div>
        <div className="time-range-handles">
          <button
            type="button"
            className="time-range-handle is-start"
            aria-label="Start time"
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag("start", event);
            }}
          />
          <button
            type="button"
            className="time-range-handle is-end"
            aria-label="End time"
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag("end", event);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function SensorCanvasChart({
  series,
  visibleNames,
  selectedName,
  viewMode,
  onSelectSeries,
  loading,
}: {
  series: ChartSeries[];
  visibleNames: Set<string>;
  selectedName: string | null;
  viewMode: ViewMode;
  onSelectSeries: (name: string) => void;
  loading: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [lockedSeriesName, setLockedSeriesName] = useState<string | null>(null);

  const visibleSeries = useMemo(
    () => series.filter((item) => visibleNames.has(item.name) && item.points.length > 0),
    [series, visibleNames],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return undefined;

    let animationFrame = 0;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(360, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);

      const bounds = chartBounds(visibleSeries, width, height);
      const { margin, plotWidth, plotHeight, minX, spanX, xScale, yScale, yTicks } = bounds;

      context.save();
      const axisFont = "500 12px Inter, Arial, sans-serif";
      const axisColor = "#64748b";

      context.lineWidth = 1;
      context.fillStyle = axisColor;
      context.font = axisFont;
      context.textAlign = "right";
      context.textBaseline = "middle";

      context.setLineDash([]);
      context.strokeStyle = "#e7edf5";
      for (const tick of yTicks) {
        const y = crispLine(yScale(tick));
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(margin.left + plotWidth, y);
        context.stroke();
        context.fillText(formatAxisTick(tick), margin.left - 10, y);
      }

      const xTickCount = width < 720 ? 4 : 5;
      context.textAlign = "center";
      context.textBaseline = "top";
      context.setLineDash([3, 6]);
      context.strokeStyle = "#edf2f7";
      for (let index = 0; index <= xTickCount; index += 1) {
        const timestamp = minX + (spanX * index) / xTickCount;
        const x = crispLine(xScale(timestamp));
        context.beginPath();
        context.moveTo(x, margin.top);
        context.lineTo(x, margin.top + plotHeight);
        context.stroke();
        context.fillText(axisLabel(timestamp, spanX), x, margin.top + plotHeight + 12);
      }

      context.setLineDash([]);
      context.strokeStyle = "#a8b3c3";
      context.beginPath();
      context.moveTo(crispLine(margin.left), margin.top);
      context.lineTo(crispLine(margin.left), margin.top + plotHeight);
      context.lineTo(margin.left + plotWidth, crispLine(margin.top + plotHeight));
      context.stroke();

      context.save();
      context.translate(18, margin.top + plotHeight / 2);
      context.rotate(-Math.PI / 2);
      context.fillStyle = axisColor;
      context.font = axisFont;
      context.textAlign = "center";
      context.fillText("VWC (%)", 0, 0);
      context.restore();

      context.beginPath();
      context.rect(margin.left, margin.top, plotWidth, plotHeight);
      context.clip();

      const visiblePotLineCount = visibleSeries.filter((item) => item.kind === "pot").length;
      const isFocusedComparison = visiblePotLineCount > 1 && visiblePotLineCount <= 6;

      for (const item of visibleSeries) {
        if (item.points.length < 2) continue;
        const selected = selectedName === item.name;
        const isSummary = item.kind === "group";
        const isQcWarning = statsForSeries(item).status === "warning";
        context.globalAlpha =
          selected ? 1 :
          isSummary ? (viewMode === "individual" ? 0.85 : 0.95) :
          viewMode === "group" ? 0.2 :
          viewMode === "qc" ? (isQcWarning ? 0.9 : 0.12) :
          isFocusedComparison ? 0.92 :
          0.84;
        context.setLineDash(item.treatment === "drought" ? [7, 5] : []);
        context.strokeStyle = item.color;
        context.lineWidth =
          selected ? (isFocusedComparison ? 3.2 : 2.4) :
          isSummary ? 3.2 :
          viewMode === "qc" && isQcWarning ? 2.8 :
          isFocusedComparison ? 2.25 :
          1.85;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        item.points.forEach((point, index) => {
          const x = xScale(point.timestampMs);
          const y = yScale(point.value);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = 1;

        const latest = item.points[item.points.length - 1];
        context.fillStyle = item.color;
        context.beginPath();
        context.arc(
          xScale(latest.timestampMs),
          yScale(latest.value),
          selected || isSummary ? 4 : 2.8,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      context.restore();

    };

    const scheduleDraw = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(wrapper);
    scheduleDraw();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [visibleSeries, selectedName, viewMode]);

  function nearestAt(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;

    if (
      x < margin.left ||
      x > margin.left + plotWidth ||
      y < margin.top ||
      y > margin.top + plotHeight
    ) {
      return null;
    }

    let nearest: TooltipState | null = null;
    let nearestDistance = Infinity;

    for (const item of visibleSeries) {
      for (const point of item.points) {
        const pointX = xScale(point.timestampMs);
        const pointY = yScale(point.value);
        const distance = Math.abs(pointX - x) * 1.4 + Math.abs(pointY - y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = {
            x: pointX,
            y: pointY,
            seriesName: item.name,
            seriesKind: item.kind,
            color: item.color,
            zone: item.zone,
            potNumber: item.potNumber,
            plantGroup: item.plantGroup,
            treatment: item.treatment,
            point,
          };
        }
      }
    }

    return nearest && nearestDistance < 48 ? nearest : null;
  }

  function pointOnSeriesAtX(event: React.MouseEvent<HTMLCanvasElement>, seriesName: string) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const item = visibleSeries.find((seriesItem) => seriesItem.name === seriesName);
    if (!item || item.points.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;

    if (
      x < margin.left ||
      x > margin.left + plotWidth ||
      y < margin.top ||
      y > margin.top + plotHeight
    ) {
      return null;
    }

    let point = item.points[0];
    let nearestDistance = Infinity;
    for (const candidate of item.points) {
      const distance = Math.abs(xScale(candidate.timestampMs) - x);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        point = candidate;
      }
    }

    return {
      x: xScale(point.timestampMs),
      y: yScale(point.value),
      seriesName: item.name,
      seriesKind: item.kind,
      color: item.color,
      zone: item.zone,
      potNumber: item.potNumber,
      plantGroup: item.plantGroup,
      treatment: item.treatment,
      point,
      locked: true,
    } satisfies TooltipState;
  }

  function updateTooltip(event: React.MouseEvent<HTMLCanvasElement>) {
    if (lockedSeriesName) {
      setTooltip(pointOnSeriesAtX(event, lockedSeriesName));
      return;
    }
    setTooltip(nearestAt(event));
  }

  function selectNearest(event: React.MouseEvent<HTMLCanvasElement>) {
    const nearest = nearestAt(event);
    if (nearest?.seriesKind === "pot") {
      setLockedSeriesName(nearest.seriesName);
      onSelectSeries(nearest.seriesName);
      setTooltip(pointOnSeriesAtX(event, nearest.seriesName) ?? nearest);
      return;
    }
    setLockedSeriesName(null);
    setTooltip(null);
  }

  return (
    <div ref={wrapperRef} className="canvas-chart">
      <canvas
        ref={canvasRef}
        onMouseDown={selectNearest}
        onMouseMove={updateTooltip}
        onClick={selectNearest}
        onMouseLeave={() => {
          if (!lockedSeriesName) setTooltip(null);
        }}
        aria-label="Soil moisture chart"
      />
      {loading && visibleSeries.length === 0 ? (
        <div className="chart-loading-overlay" aria-label="Loading readings" aria-live="polite">
          <Loader2 className="chart-loading-spinner" size={34} aria-hidden="true" />
        </div>
      ) : null}
      {tooltip ? (
        <>
          {tooltip.locked ? (
            <div
              className="chart-crosshair"
              style={{ left: tooltip.x, backgroundColor: tooltip.color }}
            />
          ) : null}
          <div
            className={`chart-tooltip ${tooltip.locked ? "is-locked" : ""}`}
            style={{
              left: Math.min(
                Math.max(tooltip.x + 14, 10),
                Math.max(10, (wrapperRef.current?.clientWidth ?? 960) - 205),
              ),
              top: Math.min(
                Math.max(tooltip.y - 72, 10),
                Math.max(10, (wrapperRef.current?.clientHeight ?? 560) - 112),
              ),
              borderColor: tooltip.color,
            }}
          >
            <strong>
              {tooltip.seriesKind === "pot"
                ? `Pot ${tooltip.potNumber}`
                : `${plantGroupLabel(tooltip.plantGroup)} ${treatmentLabel(tooltip.treatment)}`}
            </strong>
            <span>{formatDateTime(tooltip.point.timestampMs)}</span>
            {tooltip.seriesKind === "pot" ? (
              <span>{plantGroupLabel(tooltip.plantGroup)} / {treatmentLabel(tooltip.treatment)}</span>
            ) : (
              <span>{plantGroupLabel(tooltip.plantGroup)} / {treatmentLabel(tooltip.treatment)} median</span>
            )}
            <b>{tooltip.point.value.toFixed(1)}% VWC</b>
          </div>
          {tooltip.locked ? (
            <div
              className="chart-lock-dot"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                borderColor: tooltip.color,
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function controlCommandLabel(commandType: ControlCommandType) {
  const labels: Record<ControlCommandType, string> = {
    update_pairing: "Update pairing",
    bulk_update_pairings: "Bulk update pairings",
    create_pairing: "Create pairing",
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

function commandPayloadSummary(command: ControlCommand) {
  const payload = command.payload ?? {};
  if (command.command_type === "bulk_update_pairings" || command.command_type === "manual_water") {
    const pairings = Array.isArray(payload.pairing_names) ? payload.pairing_names.length : 0;
    return `${pairings} pairings`;
  }
  if (command.command_type === "create_pairing") return String(payload.name ?? "New pairing");
  if (command.command_type === "create_group" || command.command_type === "remove_group") {
    return String(payload.group_name ?? "Group");
  }
  if (command.command_type === "create_calibration") return String(payload.name ?? "Calibration");
  if (command.command_type === "apply_calibration" || command.command_type === "delete_calibration") {
    return String(payload.calibration_name ?? "Calibration");
  }
  if (command.command_type === "update_board_config") {
    const boards = Array.isArray(payload.boards) ? payload.boards.length : 0;
    return `${boards} boards`;
  }
  if (command.command_type === "update_system_state") return String(payload.state ?? "System state");
  if (command.command_type === "export_data") return String(payload.data_type ?? "Export");
  return "Queued request";
}

function commandStatusText(command: ControlCommand) {
  if (command.error) return command.error;
  if (command.status === "queued") return `Queued ${formatSettingsTimestamp(command.requested_at)}`;
  if (command.status === "accepted") return "Accepted by device bridge";
  if (command.status === "running") return "Running on device";
  if (command.status === "succeeded") return "Applied";
  if (command.status === "failed") return "Failed";
  if (command.status === "expired") return "Expired";
  return "Canceled";
}

type PortalSettingsPanelProps = {
  open: boolean;
  activeSection: SettingsSection;
  data: LoadState;
  pairings: PairingRow[];
  visiblePotCount: number;
  csvDownload: CsvDownload | null;
  exportingCsv: boolean;
  controlBusy: boolean;
  controlNotice: string | null;
  controlError: string | null;
  recentCommands: ControlCommand[];
  onClose: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onPrepareCsvDownload: () => void;
  onDownloadPairingsCsv: () => void;
  onRefreshCommands: () => void;
  onQueueCommand: QueueControlCommand;
};

function PortalSettingsPanel({
  open,
  activeSection,
  data,
  pairings,
  visiblePotCount,
  csvDownload,
  exportingCsv,
  controlBusy,
  controlNotice,
  controlError,
  recentCommands,
  onClose,
  onSectionChange,
  onPrepareCsvDownload,
  onDownloadPairingsCsv,
  onRefreshCommands,
  onQueueCommand,
}: PortalSettingsPanelProps) {
  const activeItem = settingsNavItems.find((item) => item.id === activeSection) ?? settingsNavItems[0];
  const boardConfigs = boardConfigsFromPayload(data.latestState?.latest_payload);
  const uniqueSensors = new Set(pairings.map((pairing) => pairing.sensor_key).filter(Boolean));
  const uniqueValves = new Set(pairings.map((pairing) => pairing.valve_key).filter(Boolean));
  const syncedCalibrations = Array.from(new Set(pairings.map(pairingCalibrationName)))
    .filter((label) => label !== "Not synced");
  const projectGroups = Array.from(
    pairings.reduce((groups, pairing) => {
      const label = pairingGroupName(pairing);
      groups.set(label, [...(groups.get(label) ?? []), pairing]);
      return groups;
    }, new Map<string, PairingRow[]>()),
    ([label, groupPairings]) => ({ label, pairings: groupPairings }),
  );
  const groupOptions = [
    { value: "all", label: "All pairings", pairings },
    ...projectGroups.map((group) => ({
      value: group.label,
      label: group.label,
      pairings: group.pairings,
    })),
  ];
  const [bulkGroup, setBulkGroup] = useState("all");
  const [bulkTarget, setBulkTarget] = useState("20");
  const [bulkOpenSeconds, setBulkOpenSeconds] = useState("5");
  const [bulkIntervalSeconds, setBulkIntervalSeconds] = useState("600");
  const [singlePairingName, setSinglePairingName] = useState(pairings[0]?.name ?? "");
  const [singleTarget, setSingleTarget] = useState(pairings[0] ? numberInputString(pairings[0].wtc_percent_limit) : "20");
  const [singleOpenSeconds, setSingleOpenSeconds] = useState(
    pairings[0] ? numberInputString(pairings[0].valve_open_time_ms / 1000) : "5",
  );
  const [singleIntervalSeconds, setSingleIntervalSeconds] = useState(
    pairings[0] ? numberInputString(pairings[0].measurement_interval_ms / 1000, 0) : "600",
  );
  const [newPairingName, setNewPairingName] = useState("");
  const [newPairingSensor, setNewPairingSensor] = useState("");
  const [newPairingValve, setNewPairingValve] = useState("");
  const [newPairingGroup, setNewPairingGroup] = useState("Matt's 20 pots");
  const [newPairingTarget, setNewPairingTarget] = useState("20");
  const [manualGroup, setManualGroup] = useState("all");
  const [manualSeconds, setManualSeconds] = useState("5");
  const [groupName, setGroupName] = useState("");
  const [removeGroupName, setRemoveGroupName] = useState(projectGroups[0]?.label ?? "");
  const [calibrationName, setCalibrationName] = useState("Corrected Calibration (+10)");
  const [calibrationFunction, setCalibrationFunction] = useState("f(x) = 110.68 - 0.1289x + 0.00004x^2");
  const [calibrationMode, setCalibrationMode] = useState("manual");
  const [applyCalibrationName, setApplyCalibrationName] = useState(syncedCalibrations[0] ?? "Corrected Calibration (+10)");
  const [applyCalibrationGroup, setApplyCalibrationGroup] = useState("all");
  const [boardAddresses, setBoardAddresses] = useState(
    boardConfigs.length ? boardConfigs.map((config) => config.address).join(", ") : "0x20, 0x24, 0x26",
  );
  const [boardResetPin, setBoardResetPin] = useState("16");
  const [destructiveConfirm, setDestructiveConfirm] = useState(false);
  const [exportDataType, setExportDataType] = useState("readings");
  const selectedPairing = pairings.find((pairing) => pairing.name === singlePairingName) ?? pairings[0] ?? null;

  useEffect(() => {
    if (!open || pairings.length === 0) return;
    setSinglePairingName((current) => (
      current && pairings.some((pairing) => pairing.name === current) ? current : pairings[0].name
    ));
  }, [open, pairings]);

  useEffect(() => {
    if (!open || !selectedPairing) return;
    setSingleTarget(numberInputString(selectedPairing.wtc_percent_limit));
    setSingleOpenSeconds(numberInputString(selectedPairing.valve_open_time_ms / 1000));
    setSingleIntervalSeconds(numberInputString(selectedPairing.measurement_interval_ms / 1000, 0));
  }, [open, selectedPairing]);

  if (!open) return null;

  function pairingsForGroup(groupValue: string) {
    return groupOptions.find((group) => group.value === groupValue)?.pairings ?? [];
  }

  function pairingNamesForGroup(groupValue: string) {
    return pairingsForGroup(groupValue).map((pairing) => pairing.name);
  }

  function parseNumber(value: string) {
    return Number(value.trim());
  }

  async function submitBulkPairingUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("bulk_update_pairings", {
      pairing_names: pairingNamesForGroup(bulkGroup),
      target_vwc: parseNumber(bulkTarget),
      open_time_seconds: parseNumber(bulkOpenSeconds),
      measurement_interval_seconds: parseNumber(bulkIntervalSeconds),
    });
  }

  async function submitSinglePairingUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("update_pairing", {
      pairing_name: selectedPairing?.name ?? singlePairingName,
      target_vwc: parseNumber(singleTarget),
      open_time_seconds: parseNumber(singleOpenSeconds),
      measurement_interval_seconds: parseNumber(singleIntervalSeconds),
    });
  }

  async function submitCreatePairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("create_pairing", {
      name: newPairingName,
      sensor_key: newPairingSensor,
      valve_key: newPairingValve,
      group_name: newPairingGroup,
      target_vwc: parseNumber(newPairingTarget),
      open_time_seconds: parseNumber(bulkOpenSeconds),
      measurement_interval_seconds: parseNumber(bulkIntervalSeconds),
    });
  }

  async function submitManualWater(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("manual_water", {
      pairing_names: pairingNamesForGroup(manualGroup),
      duration_seconds: parseNumber(manualSeconds),
    });
  }

  async function submitCreateGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("create_group", {
      group_name: groupName,
    });
  }

  async function submitRemoveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("remove_group", {
      group_name: removeGroupName || groupName,
    }, { confirm: true });
  }

  async function submitCalibration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("create_calibration", {
      name: calibrationName,
      mode: calibrationMode,
      function_text: calibrationFunction,
    });
  }

  async function submitApplyCalibration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("apply_calibration", {
      calibration_name: applyCalibrationName,
      pairing_names: pairingNamesForGroup(applyCalibrationGroup),
    });
  }

  async function deleteCalibration(name: string) {
    await onQueueCommand("delete_calibration", {
      calibration_name: name,
    }, { confirm: true });
  }

  async function submitBoardConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const boards = boardAddresses
      .split(/[,\n]/)
      .map((address) => address.trim())
      .filter(Boolean)
      .map((address) => ({
        address,
        reset_pin: parseNumber(boardResetPin),
      }));
    await onQueueCommand("update_board_config", { boards }, { confirm: true });
  }

  async function queueSystemState(state: "running" | "stopped") {
    await onQueueCommand("update_system_state", {
      state,
      reason: state === "stopped" ? "Portal stop request" : "Portal start request",
    }, { confirm: destructiveConfirm || state === "running" });
  }

  async function queueInitializeSensors() {
    await onQueueCommand("initialize_sensors", {
      reason: "Portal initialize sensors request",
    }, { confirm: destructiveConfirm });
  }

  async function queueExportData() {
    await onQueueCommand("export_data", {
      data_type: exportDataType,
    });
  }

  const commandStatusPanel = (
    <>
      {controlNotice ? (
        <div className="settings-callout is-success">
          <CheckCircle2 size={18} />
          <div>
            <strong>{controlNotice}</strong>
            <p>The request is queued. Device execution is handled by the protected backend bridge.</p>
          </div>
        </div>
      ) : null}
      {controlError ? (
        <div className="settings-callout is-error">
          <AlertTriangle size={18} />
          <div>
            <strong>Control request was not queued.</strong>
            <p>{controlError}</p>
          </div>
        </div>
      ) : null}
    </>
  );

  const renderSection = () => {
    if (activeSection === "overview") {
      return (
        <>
          <div className="settings-grid">
            <section className="settings-card">
              <h3>System Snapshot</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Device status</span>
                  <strong>{data.latestState?.health_status ?? "Not synced"}</strong>
                </div>
                <div className="settings-row">
                  <span>Device ID</span>
                  <strong>{data.latestState?.device_id ?? "Not synced"}</strong>
                </div>
                <div className="settings-row">
                  <span>Last device state</span>
                  <strong>{formatSettingsTimestamp(data.latestState?.updated_at)}</strong>
                </div>
                <div className="settings-row">
                  <span>Latest ingest</span>
                  <strong>{formatSettingsTimestamp(data.latestIngestTime)}</strong>
                </div>
              </div>
            </section>
            <section className="settings-card">
              <h3>Project Data</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Configured pairings</span>
                  <strong>{pairings.length}</strong>
                </div>
                <div className="settings-row">
                  <span>Visible on chart</span>
                  <strong>{visiblePotCount}</strong>
                </div>
                <div className="settings-row">
                  <span>Live rows</span>
                  <strong>{data.totalLiveReadings.toLocaleString()}</strong>
                </div>
                <div className="settings-row">
                  <span>Snapshot rows</span>
                  <strong>{data.totalImportedReadings.toLocaleString()}</strong>
                </div>
              </div>
            </section>
          </div>
          <div className="settings-callout">
            <ShieldCheck size={18} />
            <div>
              <strong>Controls are queued before they touch the device.</strong>
              <p>Portal requests are authenticated, validated, and audited before a device-side executor can apply them to the live controller.</p>
            </div>
          </div>
          {commandStatusPanel}
        </>
      );
    }

    if (activeSection === "pairings") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Edit One Pairing</h3>
              <form className="settings-form" onSubmit={submitSinglePairingUpdate}>
                <label>
                  Pairing
                  <select value={singlePairingName} onChange={(event) => setSinglePairingName(event.target.value)} required>
                    {pairings.map((pairing) => (
                      <option value={pairing.name} key={pairing.id}>
                        Pot {pairing.pot_number} · {pairing.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-field-grid">
                  <label>
                    VWC %
                    <input type="number" min="0" max="80" step="0.1" value={singleTarget} onChange={(event) => setSingleTarget(event.target.value)} required />
                  </label>
                  <label>
                    Open sec
                    <input type="number" min="1" max="120" step="1" value={singleOpenSeconds} onChange={(event) => setSingleOpenSeconds(event.target.value)} required />
                  </label>
                  <label>
                    Interval sec
                    <input type="number" min="30" max="3600" step="30" value={singleIntervalSeconds} onChange={(event) => setSingleIntervalSeconds(event.target.value)} required />
                  </label>
                </div>
                <button type="submit" className="settings-primary-button" disabled={controlBusy || !selectedPairing}>
                  Queue pairing update
                </button>
              </form>
            </section>
            <section className="settings-card">
              <h3>Bulk Edit Targets</h3>
              <form className="settings-form" onSubmit={submitBulkPairingUpdate}>
                <label>
                  Group
                  <select value={bulkGroup} onChange={(event) => setBulkGroup(event.target.value)}>
                    {groupOptions.map((group) => (
                      <option value={group.value} key={group.value}>
                        {group.label} ({group.pairings.length})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-field-grid">
                  <label>
                    VWC %
                    <input type="number" min="0" max="80" step="0.1" value={bulkTarget} onChange={(event) => setBulkTarget(event.target.value)} required />
                  </label>
                  <label>
                    Open sec
                    <input type="number" min="1" max="120" step="1" value={bulkOpenSeconds} onChange={(event) => setBulkOpenSeconds(event.target.value)} required />
                  </label>
                  <label>
                    Interval sec
                    <input type="number" min="30" max="3600" step="30" value={bulkIntervalSeconds} onChange={(event) => setBulkIntervalSeconds(event.target.value)} required />
                  </label>
                </div>
                <button type="submit" className="settings-primary-button" disabled={controlBusy || pairingsForGroup(bulkGroup).length === 0}>
                  Queue bulk update
                </button>
              </form>
            </section>
            <section className="settings-card">
              <h3>Create Pairing</h3>
              <form className="settings-form" onSubmit={submitCreatePairing}>
                <div className="settings-field-grid is-two">
                  <label>
                    Name
                    <input value={newPairingName} onChange={(event) => setNewPairingName(event.target.value)} placeholder="Zone4-Pot101" required />
                  </label>
                  <label>
                    Group
                    <input value={newPairingGroup} onChange={(event) => setNewPairingGroup(event.target.value)} placeholder="Matt's 20 pots" required />
                  </label>
                </div>
                <div className="settings-field-grid is-two">
                  <label>
                    Sensor
                    <input value={newPairingSensor} onChange={(event) => setNewPairingSensor(event.target.value)} placeholder="D30GQN2E:y" required />
                  </label>
                  <label>
                    Valve
                    <input value={newPairingValve} onChange={(event) => setNewPairingValve(event.target.value)} placeholder="0x20:49" required />
                  </label>
                </div>
                <label>
                  Initial VWC %
                  <input type="number" min="0" max="80" step="0.1" value={newPairingTarget} onChange={(event) => setNewPairingTarget(event.target.value)} required />
                </label>
                <button type="submit" className="settings-secondary-button" disabled={controlBusy}>
                  Queue pairing
                </button>
              </form>
            </section>
          </div>
          <div className="settings-toolbar">
            <p>Current pot, sensor, valve, target, open-time, and measurement interval state synced from the portal project tables.</p>
            <button type="button" className="settings-secondary-button" onClick={onDownloadPairingsCsv}>
              <Download size={14} />
              Pairings CSV
            </button>
          </div>
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Pot</th>
                  <th>Sensor</th>
                  <th>Valve</th>
                  <th>Group</th>
                  <th>Target</th>
                  <th>Open</th>
                  <th>Interval</th>
                </tr>
              </thead>
              <tbody>
                {pairings.map((pairing) => (
                  <tr key={pairing.id}>
                    <td>
                      <b>{pairing.pot_number}</b>
                      <span>{pairing.name}</span>
                    </td>
                    <td>{pairing.sensor_key}</td>
                    <td>{pairing.valve_key}</td>
                    <td>{pairingGroupName(pairing)}</td>
                    <td>{formatTargetVwc(pairing.wtc_percent_limit)}</td>
                    <td>{formatSecondsFromMs(pairing.valve_open_time_ms)}</td>
                    <td>{formatIntervalFromMs(pairing.measurement_interval_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      );
    }

    if (activeSection === "calibrations") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Synced Calibration State</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Calibrations visible to portal</span>
                  <strong>{syncedCalibrations.length || "Not synced"}</strong>
                </div>
                <div className="settings-row">
                  <span>Applied pairings</span>
                  <strong>{syncedCalibrations.length ? pairings.length : "Not synced"}</strong>
                </div>
              </div>
            </section>
            <section className="settings-card">
              <h3>Calibration Builder</h3>
              <form className="settings-form" onSubmit={submitCalibration}>
                <label>
                  Calibration name
                  <input value={calibrationName} onChange={(event) => setCalibrationName(event.target.value)} required />
                </label>
                <label>
                  Fit type
                  <select value={calibrationMode} onChange={(event) => setCalibrationMode(event.target.value)}>
                    <option value="manual">Manual function</option>
                    <option value="linear">1st degree (linear)</option>
                    <option value="polynomial">3rd degree polynomial</option>
                  </select>
                </label>
                <label>
                  Function
                  <input value={calibrationFunction} onChange={(event) => setCalibrationFunction(event.target.value)} required />
                </label>
                <button type="submit" className="settings-primary-button" disabled={controlBusy}>
                  Queue calibration
                </button>
              </form>
            </section>
          </div>
          <section className="settings-card">
            <h3>Apply Calibration</h3>
            <form className="settings-form settings-inline-form" onSubmit={submitApplyCalibration}>
              <label>
                Calibration
                <input value={applyCalibrationName} onChange={(event) => setApplyCalibrationName(event.target.value)} required />
              </label>
              <label>
                Group
                <select value={applyCalibrationGroup} onChange={(event) => setApplyCalibrationGroup(event.target.value)}>
                  {groupOptions.map((group) => (
                    <option value={group.value} key={group.value}>
                      {group.label} ({group.pairings.length})
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="settings-secondary-button" disabled={controlBusy}>
                Queue apply
              </button>
            </form>
          </section>
          <div className="settings-list">
            {(syncedCalibrations.length ? syncedCalibrations : ["Calibration details are not synced into Supabase yet."]).map((label) => (
              <div className="settings-list-row" key={label}>
                <span>{label}</span>
                {syncedCalibrations.length ? (
                  <button type="button" className="settings-danger-button" onClick={() => void deleteCalibration(label)} disabled={controlBusy}>
                    Delete
                  </button>
                ) : (
                  <em>Backend bridge needed</em>
                )}
              </div>
            ))}
          </div>
        </>
      );
    }

    if (activeSection === "water") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Current Targets</h3>
              <div className="settings-rows">
                {projectGroups.map((group) => {
                  const targets = Array.from(new Set(group.pairings.map((pairing) => formatTargetVwc(pairing.wtc_percent_limit))));
                  return (
                    <div className="settings-row" key={group.label}>
                      <span>{group.label}</span>
                      <strong>{targets.join(", ")}</strong>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="settings-card">
              <h3>Manual Watering</h3>
              <form className="settings-form" onSubmit={submitManualWater}>
                <label>
                  Group
                  <select value={manualGroup} onChange={(event) => setManualGroup(event.target.value)}>
                    {groupOptions.map((group) => (
                      <option value={group.value} key={group.value}>
                        {group.label} ({group.pairings.length})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Duration seconds
                  <input type="number" min="1" max="60" step="1" value={manualSeconds} onChange={(event) => setManualSeconds(event.target.value)} required />
                </label>
                <button type="submit" className="settings-primary-button" disabled={controlBusy || pairingsForGroup(manualGroup).length === 0}>
                  Queue manual water
                </button>
              </form>
            </section>
          </div>
          <div className="settings-callout is-warning">
            <CircleAlert size={18} />
            <div>
              <strong>Manual watering is treated as a live-control command.</strong>
              <p>The portal queues the request with your user ID; the device bridge must apply it and write the result back.</p>
            </div>
          </div>
        </>
      );
    }

    if (activeSection === "groups") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Create Group</h3>
              <form className="settings-form" onSubmit={submitCreateGroup}>
                <label>
                  Group name
                  <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Matt drought rows" required />
                </label>
                <button type="submit" className="settings-primary-button" disabled={controlBusy}>
                  Queue group
                </button>
              </form>
            </section>
            <section className="settings-card">
              <h3>Remove Group</h3>
              <form className="settings-form" onSubmit={submitRemoveGroup}>
                <label>
                  Group
                  <select value={removeGroupName} onChange={(event) => setRemoveGroupName(event.target.value)}>
                    <option value="">Type custom group above</option>
                    {groupOptions.filter((group) => group.value !== "all").map((group) => (
                      <option value={group.label} key={group.value}>{group.label}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="settings-danger-button" disabled={controlBusy || (!removeGroupName && !groupName)}>
                  Queue remove
                </button>
              </form>
            </section>
          </div>
          <div className="settings-grid">
            {projectGroups.map((group) => (
              <section className="settings-card" key={group.label}>
                <h3>{group.label}</h3>
                <div className="settings-rows">
                  <div className="settings-row">
                    <span>Pots</span>
                    <strong>{group.pairings.map((pairing) => pairing.pot_number).join(", ")}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Count</span>
                    <strong>{group.pairings.length}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Targets</span>
                    <strong>{Array.from(new Set(group.pairings.map((pairing) => formatTargetVwc(pairing.wtc_percent_limit)))).join(", ")}</strong>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </>
      );
    }

    if (activeSection === "hardware") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Hardware Snapshot</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Sensors</span>
                  <strong>{uniqueSensors.size || "Not synced"}</strong>
                </div>
                <div className="settings-row">
                  <span>Valves</span>
                  <strong>{uniqueValves.size || "Not synced"}</strong>
                </div>
                <div className="settings-row">
                  <span>Boards</span>
                  <strong>{boardConfigs.length || "Not synced"}</strong>
                </div>
              </div>
            </section>
            <section className="settings-card">
              <h3>Protected System Actions</h3>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={destructiveConfirm}
                  onChange={(event) => setDestructiveConfirm(event.target.checked)}
                />
                <span>I understand this is a live system command.</span>
              </label>
              <div className="settings-action-stack">
                <button type="button" onClick={() => void queueSystemState("running")} disabled={controlBusy}>
                  <CheckCircle2 size={14} /> Queue start system
                </button>
                <button type="button" onClick={() => void queueInitializeSensors()} disabled={controlBusy || !destructiveConfirm}>
                  <AlertTriangle size={14} /> Queue initialize sensors
                </button>
                <button type="button" onClick={() => void queueSystemState("stopped")} disabled={controlBusy || !destructiveConfirm}>
                  <AlertTriangle size={14} /> Queue stop system
                </button>
              </div>
            </section>
          </div>
          <section className="settings-card">
            <h3>Board Configuration</h3>
            <form className="settings-form settings-inline-form" onSubmit={submitBoardConfig}>
              <label>
                Board addresses
                <input value={boardAddresses} onChange={(event) => setBoardAddresses(event.target.value)} placeholder="0x20, 0x24, 0x26" required />
              </label>
              <label>
                Reset pin
                <input type="number" min="0" max="40" step="1" value={boardResetPin} onChange={(event) => setBoardResetPin(event.target.value)} required />
              </label>
              <button type="submit" className="settings-danger-button" disabled={controlBusy || !destructiveConfirm}>
                Queue board update
              </button>
            </form>
          </section>
          <div className="settings-list">
            {(boardConfigs.length ? boardConfigs : [{ address: "Not synced", resetPin: "Not synced" }]).map((config, index) => (
              <div className="settings-list-row" key={`${config.address}-${index}`}>
                <span>Board {index + 1}</span>
                <em>Address {config.address} · Reset pin {config.resetPin}</em>
              </div>
            ))}
          </div>
        </>
      );
    }

    if (activeSection === "exports") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Readings Export</h3>
              <p className="settings-muted">Downloads all project readings currently accessible to your account.</p>
              <button type="button" className="settings-secondary-button" onClick={onPrepareCsvDownload} disabled={exportingCsv}>
                <Download size={14} />
                {exportingCsv ? "Preparing..." : "Prepare readings CSV"}
              </button>
              {csvDownload ? (
                <a className="settings-download-link" href={csvDownload.url} download={csvDownload.filename}>
                  Download {csvDownload.rowCount.toLocaleString()} rows
                </a>
              ) : null}
            </section>
            <section className="settings-card">
              <h3>Configuration Export</h3>
              <p className="settings-muted">Pairings export is available now. Device-side exports can be queued for the controller bridge.</p>
              <button type="button" className="settings-secondary-button" onClick={onDownloadPairingsCsv}>
                <Download size={14} />
                Download pairings CSV
              </button>
              <div className="settings-inline-form">
                <label>
                  Data type
                  <select value={exportDataType} onChange={(event) => setExportDataType(event.target.value)}>
                    <option value="groups">Groups</option>
                    <option value="sensors">Sensors</option>
                    <option value="valves">Valves</option>
                    <option value="pairings">Pairings</option>
                    <option value="calibrations">Calibrations</option>
                    <option value="rules">Rules</option>
                    <option value="logs">Logs</option>
                    <option value="errors">Errors</option>
                    <option value="audit">Audit</option>
                    <option value="readings">Readings</option>
                  </select>
                </label>
                <button type="button" className="settings-secondary-button" onClick={() => void queueExportData()} disabled={controlBusy}>
                  Queue export
                </button>
              </div>
            </section>
          </div>
        </>
      );
    }

    if (activeSection === "logs") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-callout">
            <Database size={18} />
            <div>
              <strong>Audit trail</strong>
              <p>Calibration, pairing edit, valve command, export, and system-action requests are written to command and audit tables.</p>
            </div>
          </div>
          <section className="settings-card">
            <div className="settings-card-head">
              <h3>Recent Commands</h3>
              <button type="button" className="settings-secondary-button" onClick={onRefreshCommands}>
                Refresh
              </button>
            </div>
            <div className="settings-table-wrap">
              <table className="settings-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Scope</th>
                    <th>Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCommands.length ? recentCommands.map((command) => (
                    <tr key={command.id}>
                      <td>{controlCommandLabel(command.command_type)}</td>
                      <td>{command.status}</td>
                      <td>{commandPayloadSummary(command)}</td>
                      <td>{commandStatusText(command)}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4}>No control commands synced yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <pre className="settings-json-preview">{shortJson(data.latestState?.latest_payload)}</pre>
        </>
      );
    }

    return (
      <div className="settings-grid">
        <section className="settings-card">
          <h3>Invite-only Access</h3>
          <p className="settings-muted">Portal data remains protected by project membership and Supabase RLS. Public signup should not grant experiment access.</p>
          <div className="settings-rows">
            <div className="settings-row">
              <span>Project access</span>
              <strong>Membership required</strong>
            </div>
            <div className="settings-row">
              <span>Control access</span>
              <strong>Admin/operator role needed</strong>
            </div>
          </div>
        </section>
        <section className="settings-card">
          <h3>Control Permissions</h3>
          <p className="settings-muted">Owner/admin members can queue control commands. Viewer/member accounts can keep read-only dashboard access.</p>
        </section>
      </div>
    );
  };

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Portal settings">
      <section className="settings-modal">
        <aside className="settings-sidebar" aria-label="Settings sections">
          <button type="button" className="settings-back-button" onClick={onClose}>
            <X size={16} />
            Back to portal
          </button>
          <div className="settings-search" aria-hidden="true">
            <Search size={15} />
            <span>Search settings...</span>
          </div>
          <nav>
            {settingsNavGroups.map((group) => (
              <div className="settings-sidebar-group" key={group.label}>
                <p className="settings-sidebar-group-label">{group.label}</p>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={item.id === activeSection ? "is-active" : ""}
                      onClick={() => onSectionChange(item.id)}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>
        <section className="settings-content">
          <header className="settings-content-header">
            <div>
              <p>{activeItem.description}</p>
              <h2>{activeItem.label}</h2>
            </div>
            <button type="button" className="settings-close-button" onClick={onClose} aria-label="Close settings">
              <X size={18} />
            </button>
          </header>
          <div className="settings-section-body">{renderSection()}</div>
        </section>
      </section>
    </div>
  );
}

export default function App() {
  const [email, setEmail] = useState(() => initialEmail());
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>(() => initialAuthMode());
  const [inviteToken] = useState(() => inviteTokenFromUrl());
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [csvDownload, setCsvDownload] = useState<CsvDownload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<DataMode>("auto");
  const [potPreset, setPotPreset] = useState<PotPreset>("all");
  const [hiddenPots, setHiddenPots] = useState<Set<string>>(() => new Set());
  const [selectedSeriesName, setSelectedSeriesName] = useState<string | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(fullTimeWindow);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize>(defaultExpandedPanelSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview");
  const [controlBusy, setControlBusy] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [recentCommands, setRecentCommands] = useState<ControlCommand[]>([]);
  const [data, setData] = useState<LoadState>(initialLoadState);

  const dataRef = useRef(data);
  const loadTokenRef = useRef(0);
  const dashboardMainRef = useRef<HTMLElement | null>(null);
  const controlPanelRef = useRef<HTMLElement | null>(null);
  const panelDragOffsetRef = useRef<PanelPosition | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  const sortedPairings = useMemo(() => orderedPairings(data.pairings), [data.pairings]);
  const pairingByName = useMemo(
    () => new Map(sortedPairings.map((pairing) => [pairing.name, pairing])),
    [sortedPairings],
  );
  const series = useMemo(() => chartSeries(sortedPairings, data.readings), [sortedPairings, data.readings]);
  const seriesByName = useMemo(() => new Map(series.map((item) => [item.name, item])), [series]);
  const chartDisplaySeries = useMemo(() => {
    return series.slice().sort((a, b) => {
      if (a.name === selectedSeriesName) return 1;
      if (b.name === selectedSeriesName) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [series, selectedSeriesName]);
  const timeBounds = useMemo(() => timeBoundsForSeries(series), [series]);
  const timeFilteredSeries = useMemo(
    () => filterSeriesByTime(chartDisplaySeries, timeBounds, timeWindow),
    [chartDisplaySeries, timeBounds, timeWindow],
  );
  const visibleNames = useMemo(
    () => new Set(series.filter((item) => !hiddenPots.has(item.name)).map((item) => item.name)),
    [series, hiddenPots],
  );

  const visiblePotCount = series.filter(
    (item) => visibleNames.has(item.name) && item.rawPointCount > 0,
  ).length;

  const refresh = useCallback(
    async ({ incremental }: { incremental: boolean }) => {
      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      setError(null);
      setLoading(!incremental);
      setRefreshing(incremental);

      try {
        const [
          pairings,
          latestState,
          totalImportedReadings,
          totalLiveReadings,
          latestLiveReadings,
        ] = await Promise.all([
          supabase.from("pairings").select("*").limit(1000),
          supabase.from("latest_device_state").select("*").limit(1).maybeSingle(),
          countReadings(importedPrefix),
          countReadings(livePrefix),
          supabase
            .from("sensor_readings")
            .select("*")
            .like("event_id", livePrefix)
            .order("device_recorded_at", { ascending: false })
            .limit(1),
        ]);

        for (const result of [pairings, latestState, latestLiveReadings]) {
          if (result.error) throw result.error;
        }

        const previous = dataRef.current;
        const effectiveMode = resolveEffectiveMode(selectedMode, totalLiveReadings);
        const canIncrement = incremental && previous.effectiveMode === effectiveMode;
        const newerThan = canIncrement ? newestReadingTimestamp(previous.readings) : null;
        const incomingReadings = await fetchReadingsForMode(effectiveMode, newerThan);
        const nowIso = new Date().toISOString();

        if (token !== loadTokenRef.current) return;

        setData((current) => {
          const sameMode = current.effectiveMode === effectiveMode;
          const base = incremental && sameMode ? current.readings : [];
          const readings = mergeReadings(base, incomingReadings);
          const hasNewRows = incomingReadings.length > 0;

          return {
            pairings: pairings.data ?? [],
            latestState: latestState.data ?? null,
            readings,
            totalImportedReadings,
            totalLiveReadings,
            latestLiveReading: latestLiveReadings.data?.[0] ?? null,
            latestIngestTime:
              latestLiveReadings.data?.[0]?.server_received_at ??
              latestState.data?.updated_at ??
              null,
            lastCheckedAt: nowIso,
            lastNewDataAt: hasNewRows ? nowIso : current.lastNewDataAt ?? (readings.length ? nowIso : null),
            effectiveMode,
          };
        });
      } catch (err) {
        if (token === loadTokenRef.current) {
          setError(errorMessage(err));
        }
      } finally {
        if (token === loadTokenRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [selectedMode],
  );

  const loadRecentCommands = useCallback(async () => {
    try {
      const response = await supabase
        .from("project_control_commands")
        .select("id, project_id, device_id, command_type, payload, status, requested_at, expires_at, requires_confirmation, result, error")
        .eq("project_id", mattProjectId)
        .order("requested_at", { ascending: false })
        .limit(20);

      if (response.error) throw response.error;
      setRecentCommands((response.data ?? []) as ControlCommand[]);
    } catch {
      setRecentCommands([]);
    }
  }, []);

  const queueControlCommand = useCallback<QueueControlCommand>(
    async (commandType, payload, options) => {
      setControlBusy(true);
      setControlNotice(null);
      setControlError(null);

      try {
        const response = await supabase.functions.invoke<ControlCommandResponse>("create-control-command", {
          body: {
            project_id: mattProjectId,
            device_id: dataRef.current.latestState?.device_id ?? mattDeviceId,
            command_type: commandType,
            payload,
            confirm: options?.confirm === true,
          },
        });

        if (response.error) {
          throw new Error(await functionErrorMessage(response.error));
        }

        setControlNotice(`${controlCommandLabel(commandType)} queued`);
        await loadRecentCommands();
      } catch (err) {
        setControlError(errorMessage(err));
      } finally {
        setControlBusy(false);
      }
    },
    [loadRecentCommands],
  );

  useEffect(() => {
    if (!settingsOpen || !sessionReady) return;
    void loadRecentCommands();
  }, [loadRecentCommands, sessionReady, settingsOpen]);

  async function signIn(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setLoginError(null);
    setAuthNotice(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (signInError) {
      setLoginError(errorMessage(signInError));
      return;
    }
    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }
    setSessionReady(true);
  }

  async function acceptInvite(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setLoginError(null);
    setAuthNotice(null);

    if (!inviteToken) {
      setLoading(false);
      setLoginError("Use a valid invite link to create an account.");
      return;
    }

    if (password.length < 8) {
      setLoading(false);
      setLoginError("Use at least 8 characters.");
      return;
    }

    const { data: inviteData, error: inviteError } =
      await supabase.functions.invoke<InviteAcceptResponse>("accept-invite", {
        body: {
          token: inviteToken,
          email,
          password,
        },
      });

    if (inviteError) {
      setLoading(false);
      setLoginError(await functionErrorMessage(inviteError));
      return;
    }

    const session = inviteData?.session;
    if (!session?.access_token || !session.refresh_token) {
      setLoading(false);
      setLoginError("Invite accepted, but sign-in did not complete.");
      return;
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });

    setLoading(false);

    if (sessionError) {
      setLoginError(errorMessage(sessionError));
      return;
    }

    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }

    window.history.replaceState(null, "", portalUrl());
    setPassword("");
    setSessionReady(true);
  }

  async function setAccountPassword(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setLoginError(null);
    setAuthNotice(null);

    if (password.length < 8) {
      setLoading(false);
      setLoginError("Use at least 8 characters.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setLoginError(errorMessage(updateError));
      return;
    }

    window.history.replaceState(null, "", portalUrl());
    setPassword("");
    setSessionReady(true);
  }

  function switchAuthMode(nextMode: AuthMode) {
    setAuthMode(nextMode);
    setLoginError(null);
    setAuthNotice(null);
    if (nextMode !== "set-password") {
      window.history.replaceState(
        null,
        "",
        portalUrl(),
      );
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setError(null);
    setLoginError(null);
    setSessionReady(false);
    setData(initialLoadState);
    dataRef.current = initialLoadState;
  }

  function selectPot(name: string) {
    setSelectedSeriesName(name);
  }

  function applyPotPreset(preset: Exclude<PotPreset, "custom">) {
    setPotPreset(preset);
    setHiddenPots(() => {
      if (preset === "all") return new Set();
      const hidden = new Set<string>();
      for (const pairing of sortedPairings) {
        const treatment = treatmentForPairing(pairing);
        const plantGroup = plantGroupForPairing(pairing);
        if (preset === "control" && treatment !== "control") hidden.add(pairing.name);
        if (preset === "drought" && treatment !== "drought") hidden.add(pairing.name);
        if (preset === "maize" && plantGroup !== "maize") hidden.add(pairing.name);
        if (preset === "sorghum" && plantGroup !== "sorghum") hidden.add(pairing.name);
      }
      return hidden;
    });
  }

  function togglePot(name: string) {
    setPotPreset("custom");
    setSelectedSeriesName(name);
    setHiddenPots((current) => {
      const allNames = sortedPairings.map((pairing) => pairing.name);
      const visibleCount = allNames.filter((pairingName) => !current.has(pairingName)).length;

      if (visibleCount === allNames.length) {
        return new Set(allNames.filter((pairingName) => pairingName !== name));
      }

      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else if (visibleCount > 1) {
        next.add(name);
      }
      return next;
    });
  }

  function setGroupVisibility(pairings: PairingRow[], visible: boolean) {
    setPotPreset("custom");
    setHiddenPots((current) => {
      const next = new Set(current);
      for (const pairing of pairings) {
        if (visible) next.delete(pairing.name);
        else next.add(pairing.name);
      }
      return next;
    });
  }

  function startPanelDrag(event: PointerEvent<HTMLElement>) {
    if (!graphExpanded || !dashboardMainRef.current || !controlPanelRef.current) return;
    const containerRect = dashboardMainRef.current.getBoundingClientRect();
    const panelRect = controlPanelRef.current.getBoundingClientRect();
    const dragOffset = {
      x: event.clientX - panelRect.left,
      y: event.clientY - panelRect.top,
    };
    panelDragOffsetRef.current = dragOffset;
    setPanelPosition({
      x: panelRect.left - containerRect.left,
      y: panelRect.top - containerRect.top,
    });

    const movePanel = (moveEvent: globalThis.PointerEvent) => {
      if (!dashboardMainRef.current || !controlPanelRef.current) return;
      const currentContainerRect = dashboardMainRef.current.getBoundingClientRect();
      const currentPanelRect = controlPanelRef.current.getBoundingClientRect();
      const nextX = moveEvent.clientX - currentContainerRect.left - dragOffset.x;
      const nextY = moveEvent.clientY - currentContainerRect.top - dragOffset.y;
      setPanelPosition({
        x: Math.max(8, Math.min(nextX, currentContainerRect.width - currentPanelRect.width - 8)),
        y: Math.max(8, Math.min(nextY, currentContainerRect.height - currentPanelRect.height - 8)),
      });
    };

    const stopPanel = () => {
      panelDragOffsetRef.current = null;
      window.removeEventListener("pointermove", movePanel);
      window.removeEventListener("pointerup", stopPanel);
      window.removeEventListener("pointercancel", stopPanel);
    };

    window.addEventListener("pointermove", movePanel);
    window.addEventListener("pointerup", stopPanel);
    window.addEventListener("pointercancel", stopPanel);
  }

  function startPanelResize(event: PointerEvent<HTMLElement>) {
    if (!graphExpanded || !dashboardMainRef.current || !controlPanelRef.current) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const containerRect = dashboardMainRef.current.getBoundingClientRect();
    const panelRect = controlPanelRef.current.getBoundingClientRect();
    const startPanelX = panelRect.left - containerRect.left;
    const startPanelY = panelRect.top - containerRect.top;
    const maxWidth = Math.max(minExpandedPanelSize.width, containerRect.width - 16);
    const maxHeight = Math.max(minExpandedPanelSize.height, containerRect.height - 16);

    const resizePanel = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = panelRect.width + moveEvent.clientX - startX;
      const nextHeight = panelRect.height + moveEvent.clientY - startY;
      const width = Math.max(minExpandedPanelSize.width, Math.min(nextWidth, maxWidth));
      const height = Math.max(minExpandedPanelSize.height, Math.min(nextHeight, maxHeight));
      setPanelSize({
        width,
        height,
      });
      setPanelPosition({
        x: Math.max(8, Math.min(startPanelX, containerRect.width - width - 8)),
        y: Math.max(8, Math.min(startPanelY, containerRect.height - height - 8)),
      });
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", resizePanel);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", resizePanel);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function toggleExpandedGraph() {
    setGraphExpanded((expanded) => !expanded);
  }

  async function prepareCsvDownload() {
    setExportingCsv(true);
    setCsvDownload(null);
    setError(null);

    try {
      const readings = await fetchAllExportReadings();
      const headers = [
        "source",
        "event_id",
        "pairing_name",
        "plant_group",
        "treatment",
        "zone",
        "pot_number",
        "sensor_key",
        "device_recorded_at",
        "server_received_at",
        "calibrated_vwc",
        "raw_value",
        "temperature",
        "electrical_conductivity",
      ];
      const rows = readings.map((reading) => {
        const pairing = pairingByName.get(reading.pairing_name);
        return [
          sourceLabelForReading(reading),
          reading.event_id,
          reading.pairing_name,
          pairing ? plantGroupLabel(plantGroupForPairing(pairing)) : "",
          pairing ? treatmentLabel(treatmentForPairing(pairing)) : "",
          pairing?.zone ?? "",
          pairing?.pot_number ?? "",
          reading.sensor_key,
          reading.device_recorded_at,
          reading.server_received_at,
          reading.calibrated_value,
          reading.raw_value,
          reading.temperature,
          reading.electrical_conductivity,
        ].map(csvEscape).join(",");
      });
      const csv = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      setCsvDownload({
        url,
        filename: `exacth2o-readings-all-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: readings.length,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExportingCsv(false);
    }
  }

  function downloadPairingsCsv() {
    const headers = [
      "name",
      "zone",
      "pot_number",
      "plant_group",
      "treatment",
      "sensor_key",
      "valve_key",
      "target_vwc",
      "valve_open_seconds",
      "measurement_interval_seconds",
      "calibration",
    ];
    const rows = sortedPairings.map((pairing) => [
      pairing.name,
      pairing.zone,
      pairing.pot_number,
      plantGroupLabel(plantGroupForPairing(pairing)),
      treatmentLabel(treatmentForPairing(pairing)),
      pairing.sensor_key,
      pairing.valve_key,
      formatTargetVwc(pairing.wtc_percent_limit),
      Number((pairing.valve_open_time_ms / 1000).toFixed(3)),
      Number((pairing.measurement_interval_ms / 1000).toFixed(3)),
      pairingCalibrationName(pairing),
    ].map(csvEscape).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `exacth2o-pairings-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  useEffect(() => {
    return () => {
      if (csvDownload) URL.revokeObjectURL(csvDownload.url);
    };
  }, [csvDownload]);

  useEffect(() => {
    const rememberedEmail = window.localStorage.getItem(rememberEmailKey);
    if (rememberedEmail) {
      setEmail(rememberedEmail);
      setRememberDevice(true);
    }
    supabase.auth.getSession().then(({ data: sessionData }) => {
      if (authMode === "set-password" || authMode === "accept-invite") return;
      setSessionReady(Boolean(sessionData.session));
    });
  }, [authMode]);

  useEffect(() => {
    if (!sessionReady) return;
    void refresh({ incremental: false });
  }, [sessionReady, selectedMode, refresh]);

  useEffect(() => {
    if (!sessionReady) return undefined;
    const intervalId = window.setInterval(() => {
      void refresh({ incremental: true });
    }, autoRefreshMs);
    return () => window.clearInterval(intervalId);
  }, [sessionReady, refresh]);

  useEffect(() => {
    if (!sessionReady) return undefined;

    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh({ incremental: true });
      }, 750);
    };

    const shouldRefreshForEvent = (eventId: unknown) => {
      if (typeof eventId !== "string") return false;
      if (selectedMode === "combined" || selectedMode === "auto") return true;
      if (selectedMode === "live") return eventId.startsWith("live-device:");
      return eventId.startsWith("balena-export-v2:");
    };

    const channel = supabase
      .channel("exacth2o-dashboard-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sensor_readings" },
        (payload) => {
          if (shouldRefreshForEvent(payload.new?.event_id)) {
            scheduleRefresh();
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "latest_device_state" },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [sessionReady, selectedMode, refresh]);

  if (!sessionReady) {
    const isInviteAccept = authMode === "accept-invite";
    const isPasswordSetup = authMode === "set-password";
    const authTitle = isPasswordSetup ? "Set Password" : isInviteAccept ? "Accept Invite" : "Sign In";
    const authNote = isPasswordSetup
      ? "Choose a password for this exactH2O account."
      : isInviteAccept
        ? "Use the invited email and choose a password."
        : "Use your exactH2O account.";
    const authSubmitText = loading
      ? isPasswordSetup
        ? "Saving..."
        : isInviteAccept
          ? "Accepting..."
          : "Signing in..."
      : isPasswordSetup
        ? "Save Password"
        : isInviteAccept
          ? "Accept Invite"
          : "Open Dashboard";

    return (
      <main className="portal-login-shell">
        <header className="portal-topbar">
          <a href="/" className="portal-logo">
            exact<span>H</span>2<span>O</span>
          </a>
          <div className="portal-top-links">
            <a href="/support">Support</a>
          </div>
        </header>

        <section className="portal-login-panel" aria-label="Portal sign in">
          <div className="portal-login-card">
            <h2>{authTitle}</h2>
            <p className="portal-login-note">{authNote}</p>

            <form onSubmit={isPasswordSetup ? setAccountPassword : isInviteAccept ? acceptInvite : signIn}>
              {!isPasswordSetup ? (
                <div className="portal-form-group">
                  <label htmlFor="portalEmail">Email</label>
                  <input
                    id="portalEmail"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="username"
                    required
                  />
                </div>
              ) : null}
              <div className="portal-form-group">
                <label htmlFor="portalPassword">Password</label>
                <input
                  id="portalPassword"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isInviteAccept || isPasswordSetup ? "new-password" : "current-password"}
                  required
                />
              </div>
              <div className="portal-form-row">
                {!isPasswordSetup ? (
                  <label className="portal-check">
                    <input
                      type="checkbox"
                      name="remember"
                      checked={rememberDevice}
                      onChange={(event) => setRememberDevice(event.target.checked)}
                    />
                    <span>Remember</span>
                  </label>
                ) : (
                  <span />
                )}
                {isInviteAccept || isPasswordSetup ? (
                  <button
                    className="portal-inline-action"
                    type="button"
                    onClick={() => switchAuthMode("sign-in")}
                  >
                    Sign in
                  </button>
                ) : (
                  <span />
                )}
              </div>
              <button
                className="portal-submit-btn"
                type="submit"
                disabled={loading || (!isPasswordSetup && !email) || !password}
              >
                {authSubmitText}
              </button>
              {authNotice ? <p className="portal-success-line">{authNotice}</p> : null}
              {loginError ? <p className="portal-error-line">{loginError}</p> : null}
            </form>

            <div className="portal-support-line">
              Need access? Ask for an invite or contact{" "}
              <a href="mailto:bslbinod@gmail.com">bslbinod@gmail.com</a>.
            </div>
          </div>
        </section>
      </main>
    );
  }

  const groupedPairings = {
    zone2: sortedPairings.filter((pairing) => pairing.zone === 2),
    zone4: sortedPairings.filter((pairing) => pairing.zone === 4),
  };
  const controlPanelStyle: CSSProperties | undefined = graphExpanded
    ? {
        width: panelSize.width,
        height: panelSize.height,
        ...(panelPosition
          ? { left: panelPosition.x, top: panelPosition.y, right: "auto" }
          : {}),
      }
    : undefined;
  const csvControl = csvDownload ? (
    <a
      className="csv-button is-ready"
      href={csvDownload.url}
      download={csvDownload.filename}
      target="_blank"
      rel="noreferrer"
      title={`${csvDownload.rowCount.toLocaleString()} rows ready`}
    >
      <Download size={14} />
      CSV
    </a>
  ) : (
    <button
      className="csv-button"
      type="button"
      title="Prepare clean CSV"
      onClick={prepareCsvDownload}
      disabled={exportingCsv}
    >
      <Download size={14} />
      {exportingCsv ? "..." : "CSV"}
    </button>
  );

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <a className="dashboard-logo" href="/" aria-label="exactH2O home">
          exactH2O
        </a>
        <div className="header-actions">
          <a className="header-action site-link" href="/" aria-label="Website" title="Website">
            <ExternalLink size={15} />
            Site
          </a>
        </div>
      </header>

      <div className="portal-corner-actions" aria-label="Portal account actions">
        <button
          className="header-action"
          type="button"
          aria-label="Portal settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon size={15} />
          Settings
        </button>
        <button className="header-action icon-only" type="button" aria-label="Sign out" title="Sign out" onClick={signOut}>
          <LogOut size={17} />
        </button>
      </div>

      <PortalSettingsPanel
        open={settingsOpen}
        activeSection={settingsSection}
        data={data}
        pairings={sortedPairings}
        visiblePotCount={visiblePotCount}
        csvDownload={csvDownload}
        exportingCsv={exportingCsv}
        controlBusy={controlBusy}
        controlNotice={controlNotice}
        controlError={controlError}
        recentCommands={recentCommands}
        onClose={() => setSettingsOpen(false)}
        onSectionChange={setSettingsSection}
        onPrepareCsvDownload={prepareCsvDownload}
        onDownloadPairingsCsv={downloadPairingsCsv}
        onRefreshCommands={loadRecentCommands}
        onQueueCommand={queueControlCommand}
      />

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <section
        ref={dashboardMainRef}
        className={`dashboard-main ${graphExpanded ? "is-expanded" : ""}`}
      >
        <section className="chart-card">
          <div className="chart-tools">
            <button
              className="expand-button"
              type="button"
              aria-label={graphExpanded ? "Close expanded graph" : "Expand graph"}
              title={graphExpanded ? "Close" : "Expand"}
              onClick={toggleExpandedGraph}
            >
              {graphExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>

          <section className="chart-panel-main" aria-label="All plants chart">
            <SensorCanvasChart
              series={timeFilteredSeries}
              visibleNames={visibleNames}
              selectedName={selectedSeriesName}
              viewMode="traces"
              onSelectSeries={selectPot}
              loading={loading}
            />
          </section>
          <div className="chart-bottom-controls">
            <div className="chart-export-control">{csvControl}</div>
            <TimeRangeControl
              bounds={timeBounds}
              value={timeWindow}
              onChange={setTimeWindow}
            />
          </div>
        </section>

        <aside
          ref={controlPanelRef}
          className="control-panel"
          style={controlPanelStyle}
        >
          <section>
            {graphExpanded ? (
              <div
                className="control-heading"
                onPointerDown={startPanelDrag}
                aria-label="Move controls"
              >
                <span />
              </div>
            ) : null}
            <div className="preset-buttons research-presets">
              <button
                type="button"
                className={`preset-filter preset-all ${potPreset === "all" ? "is-selected" : ""}`}
                onClick={() => applyPotPreset("all")}
              >
                All
              </button>
              <button
                type="button"
                className={`preset-filter preset-control ${potPreset === "control" ? "is-selected" : ""}`}
                onClick={() => applyPotPreset("control")}
              >
                Control
              </button>
              <button
                type="button"
                className={`preset-filter preset-drought ${potPreset === "drought" ? "is-selected" : ""}`}
                onClick={() => applyPotPreset("drought")}
              >
                Drought
              </button>
              <button
                type="button"
                className={`preset-filter preset-maize ${potPreset === "maize" ? "is-selected" : ""}`}
                onClick={() => applyPotPreset("maize")}
              >
                Maize
              </button>
              <button
                type="button"
                className={`preset-filter preset-sorghum ${potPreset === "sorghum" ? "is-selected" : ""}`}
                onClick={() => applyPotPreset("sorghum")}
              >
                Sorghum
              </button>
            </div>
          </section>

          {[
            ["Maize", groupedPairings.zone2],
            ["Sorghum", groupedPairings.zone4],
          ].map(([label, pairings]) => {
            const groupPairings = pairings as PairingRow[];
            const allVisible = groupPairings.every((pairing) => !hiddenPots.has(pairing.name));
            return (
              <section className="pot-group" key={label as string}>
                <div className="pot-group-head">
                  <h3>{label as string}</h3>
                  <button
                    type="button"
                    className={`group-toggle ${allVisible ? "is-on" : ""}`}
                    aria-label={`${allVisible ? "Hide" : "Show"} all ${label as string} pots`}
                    title={allVisible ? "Hide all" : "Show all"}
                    onClick={() => setGroupVisibility(groupPairings, !allVisible)}
                  >
                    <span />
                  </button>
                </div>
                <div>
                  {groupPairings.map((pairing) => {
                    const visible = !hiddenPots.has(pairing.name);
                    const latestValue = statsForSeries(seriesByName.get(pairing.name)).latestValue;
                    return (
                      <button
                        key={pairing.name}
                        type="button"
                        className={`pot-toggle ${visible ? "is-on" : ""} ${selectedSeriesName === pairing.name ? "is-selected-pot" : ""}`}
                        onClick={() => togglePot(pairing.name)}
                        aria-label={`Pot ${pairing.pot_number}, ${formatPercent(latestValue)}`}
                      >
                        <span className="color-dot" style={{ background: colorForPairing(pairing) }} />
                        <span className="pot-reading">
                          <b>{pairing.pot_number}</b>
                          <strong>{formatPercent(latestValue)}</strong>
                        </span>
                        <em className={`treatment-dot ${treatmentForPairing(pairing)}`}>
                          {treatmentForPairing(pairing) === "control" ? "C" : "D"}
                        </em>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {graphExpanded ? (
            <button
              type="button"
              className="panel-resize-grip"
              aria-label="Resize controls"
              title="Resize"
              onPointerDown={startPanelResize}
            />
          ) : null}
        </aside>
      </section>
    </main>
  );
}
