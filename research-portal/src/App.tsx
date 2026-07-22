import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Database,
  Download,
  FileArchive,
  Gauge,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Maximize2,
  MessageSquare,
  Minimize2,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "./supabase";
import exactH2OLogo from "./assets/exacth2o-logo.jpeg";
import {
  expiredPortalSessionNotice,
  isSessionAuthorizationError,
} from "./authSession";
import {
  booleanMarker,
  dedupeReadings,
  healthEvidenceValue,
  isIgnoredDiagnosticReading,
  isIgnoredDiagnosticValveEvent,
  mergeReadings,
  pairingsFromDeviceConfigState,
  resolveEffectiveMode,
  sumKnownCounts,
  visibleExperimentPairings,
  type DataMode,
  type EffectiveMode,
} from "./portalData";
import {
  hasExperimentSettingsAccess,
  hasProjectDataReadAccess,
  hasRdSystemAdminAccess,
  parsePortalRole,
  type PortalRole,
} from "./portalAccess";
import { withSupabaseTimeout } from "./supabaseTimeout";
import {
  interpolateOverlayValue,
  overlayTimeBounds,
  partitionOverlayMarkers,
} from "./wateringOverlay";
import {
  advanceCurrentBootUptime,
  reconstructCurrentBootUptime,
  restartOutagePresentation,
} from "./healthUptime";
import {
  softwareTermsCompany,
  softwareTermsIntro,
  softwareTermsSections,
  softwareTermsVersion,
  supportEmail,
} from "./softwareTerms";
import type { LatestState, PairingRow, SensorReading, ValveEvent } from "./types";
import { ResponseCurveLab } from "./ResponseCurveLab";
import { loadRdLabAccess, loadRdLabSnapshot } from "./rdClient";
import { mergeRdHistoryPage } from "./rdPagination";
import type { RdLabSnapshot } from "./rdTypes";
import {
  isObservationOnlyExperiment,
  latestExperimentReading,
  pairingBelongsToExperiment,
  pairingsForExperiment,
  portalExperimentById,
  portalExperiments,
  type ExperimentId,
} from "./experimentRegistry";
import { colorForPotNumber } from "./potColors";

const graphReadLimit = 12_000;
const pageSize = 1000;
const readingSelectColumns =
  "id,event_id,pairing_name,sensor_key,raw_value,calibrated_value,temperature,electrical_conductivity,device_recorded_at,server_received_at";
const healthSnapshotSelectColumns =
  "id,project_id,device_id,device_name,source,captured_at,owner_checked_at,status_endpoint_ok,history_endpoint_ok,status_http_status,status_elapsed_ms,history_samples,overall_status,api_status,pi_online,public_url_reachable,ethernet_link,ethernet_ip,gateway_ping_ms,undervoltage,cpu_temp_c,uptime_seconds,sensors_expected,sensors_current,sensors_stale,sensors_missing,missing_sensors,stale_sensors,last_sensor_reading_at,watering_last_event,watering_last_event_at,watering_events_last_24h,scheduler_jobs_loaded,active_alerts,known_issues,ingest_complete,created_at";
const autoRefreshMs = 5 * 60_000;
const healthSnapshotPollMs = 5 * 60_000;
const supabaseQueryTimeoutMs = 12_000;
const portalAccessTimeoutMs = 8_000;
const supportPollMs = 2 * 60_000;
const incrementalCursorOverlapMs = 2 * 60_000;
const fullReconciliationEveryPolls = 72;
const healthChartWindowHours = 8;
const staleAfterMs = 15 * 60 * 1000;
const maxPointsPerSeries = graphReadLimit;
const tenMinutesMs = 10 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const wateringEventDedupeBucketMs = 60 * 1000;
const wateringHistoryMs = 7 * dayMs;
const maxValveEventRows = 2_000;
const incrementalValveEventRows = 250;
const wateringOverlayMaxSampleSpanMs = 30 * 60 * 1000;

const importedPrefix = "balena-export-v2:%";
const livePrefix = "live-device:%";
const rememberEmailKey = "exacth2o.portal.rememberEmail";
const controlPots = new Set([41, 43, 45, 47, 49, 91, 93, 95, 97, 99]);
const droughtPots = new Set([42, 44, 46, 48, 50, 92, 94, 96, 98, 100]);

type ViewMode = "group" | "traces" | "individual" | "qc";
type ExperimentGraphMode = "vwc" | "watering" | "overlay";

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

type WateringOverlayMarker = {
  event: HealthWateringEvent;
  series: ChartSeries;
  timestampMs: number;
  value: number | null;
  exactValue: boolean;
  before: ChartPoint | null;
  after: ChartPoint | null;
};

type WateringOverlayTooltip = WateringOverlayMarker & {
  x: number;
  y: number;
  locked?: boolean;
};

type Treatment = "control" | "drought" | "unknown";

type PlantGroup = "maize" | "sorghum" | "unknown";

type PotPreset = "all" | "control" | "drought" | "maize" | "sorghum" | "custom";
type AuthMode = "sign-in" | "accept-invite" | "set-password";
type PortalView = "home" | "experiment" | "health" | "support" | "rd";
type RdAccessStatus = "unknown" | "allowed" | "denied";

type PortalAccess = {
  role: PortalRole;
  email: string | null;
} | null;

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
  | "exports";

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

const adminOnlyControlCommandTypes = new Set<ControlCommandType>([
  "update_board_config",
  "initialize_sensors",
]);

type ControlCommand = {
  id: string;
  client_request_id: string;
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

type DeviceHealthSnapshot = {
  id: string;
  project_id: string;
  device_id: string;
  device_name: string;
  source: string;
  captured_at: string;
  owner_checked_at: string | null;
  status_endpoint_ok: boolean | null;
  history_endpoint_ok: boolean | null;
  status_http_status: number | null;
  status_elapsed_ms: number | null;
  history_samples: number | null;
  overall_status: string | null;
  api_status: string | null;
  pi_online: boolean | null;
  public_url_reachable: boolean | null;
  ethernet_link: boolean | null;
  ethernet_ip: string | null;
  gateway_ping_ms: number | null;
  undervoltage: boolean | null;
  cpu_temp_c: number | null;
  uptime_seconds: number | null;
  sensors_expected: number | null;
  sensors_current: number | null;
  sensors_stale: number | null;
  sensors_missing: number | null;
  missing_sensors: unknown[] | null;
  stale_sensors: unknown[] | null;
  last_sensor_reading_at: string | null;
  watering_last_event: string | null;
  watering_last_event_at: string | null;
  watering_events_last_24h: number | null;
  scheduler_jobs_loaded: number | null;
  active_alerts: unknown[] | null;
  known_issues: unknown[] | null;
  ingest_complete: boolean;
  raw_status: Record<string, unknown> | null;
  raw_health: Record<string, unknown> | null;
  raw_history: Record<string, unknown> | null;
  created_at: string;
};

type DeviceRuntimeState = {
  project_id: string;
  device_id: string;
  device_name: string;
  source: string;
  controller_state: string;
  controller_state_raw: string | null;
  controller_state_updated_at: string | null;
  state_observed_at: string;
  state_fresh_until: string | null;
  owner_checked_at: string | null;
  overall_status: string | null;
  api_status: string | null;
  pi_online: boolean | null;
  public_url_reachable: boolean | null;
  watering_enabled: boolean | null;
  watering_disabled: unknown[] | null;
  watering_last_event: string | null;
  watering_last_event_at: string | null;
  watering_events_last_24h: number | null;
  scheduler_jobs_loaded: number | null;
  sensors_expected: number | null;
  sensors_current: number | null;
  sensors_stale: number | null;
  sensors_missing: number | null;
  last_sensor_reading_at: string | null;
  config_hash: string | null;
  raw_status: Record<string, unknown> | null;
  raw_health: Record<string, unknown> | null;
  raw_system: Record<string, unknown> | null;
  updated_at: string;
};

type DeviceConfigState = {
  project_id: string;
  device_id: string;
  device_name: string;
  source: string;
  observed_at: string;
  pairings: unknown[] | null;
  calibrations: unknown[] | null;
  board_config: unknown[] | null;
  sensors: unknown[] | null;
  valves: unknown[] | null;
  groups: unknown[] | null;
  pairing_count: number | null;
  calibration_count: number | null;
  board_count: number | null;
  sensor_count: number | null;
  valve_count: number | null;
  group_count: number | null;
  config_hash: string | null;
  endpoint_status: Record<string, unknown> | null;
  raw_config: Record<string, unknown> | null;
  updated_at: string;
};

type SupportStatus = "new" | "open" | "waiting_on_customer" | "quoted" | "won" | "lost" | "closed";

type QuoteRequestRow = {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string | null;
  name: string;
  email: string;
  phone: string | null;
  organization: string | null;
  application: string;
  timeline: string | null;
  message: string;
  source_url: string | null;
  referrer: string | null;
  notification_email: string | null;
  notification_status: string | null;
  notification_error: string | null;
  status: SupportStatus | null;
  priority: string | null;
};

type SupportThreadRow = {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  source: "email" | "form" | "quote" | "portal" | "other";
  status: SupportStatus;
  priority: "low" | "normal" | "high" | "urgent";
  request_type: "support" | "quote" | "demo" | "docs" | "training" | "billing" | "install" | "other";
  subject: string;
  customer_name: string | null;
  customer_email: string;
  customer_phone: string | null;
  customer_organization: string | null;
  quote_request_id: string | null;
  last_message_preview: string | null;
  last_message_from_email: string | null;
  last_message_subject: string | null;
  metadata: Record<string, unknown> | null;
};

type SupportMessageRow = {
  id: string;
  thread_id: string;
  project_id: string;
  created_at: string;
  direction: "inbound" | "outbound" | "internal" | "system";
  channel: "email" | "form" | "portal" | "system";
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  metadata: Record<string, unknown> | null;
};

type SalesSupportData = {
  quotes: QuoteRequestRow[];
  threads: SupportThreadRow[];
  messages: SupportMessageRow[];
};

type TimeBounds = {
  startMs: number;
  endMs: number;
};

type TimeWindow = {
  start: number;
  end: number;
};

type RefreshOptions = {
  incremental: boolean;
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
const mattProjectId = "22222222-2222-4222-8222-222222222222";
const mattDeviceId = "3100e37ee3205651fe3dd86dafd4dc0c";

const settingsNavItems: SettingsNavItem[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Live state",
    group: "Live System",
    icon: Gauge,
  },
  {
    id: "pairings",
    label: "Pairings",
    description: "Pots and targets",
    group: "Controls",
    icon: SlidersHorizontal,
  },
  {
    id: "calibrations",
    label: "Calibrations",
    description: "Sensor calibration",
    group: "Controls",
    icon: Activity,
  },
  {
    id: "water",
    label: "Water Control",
    description: "Watering",
    group: "Controls",
    icon: ShieldCheck,
  },
  {
    id: "groups",
    label: "Groups",
    description: "Plant groups",
    group: "Controls",
    icon: Database,
  },
  {
    id: "hardware",
    label: "Hardware",
    description: "Boards and sensors",
    group: "Controls",
    icon: Lock,
  },
  {
    id: "exports",
    label: "Exports",
    description: "Files",
    group: "Data",
    icon: FileArchive,
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

const initialSalesSupportData: SalesSupportData = {
  quotes: [],
  threads: [],
  messages: [],
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
  return colorForPotNumber(pairing.pot_number);
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
  if (!value) return "--";
  const formatted = formatDateTime(value);
  return formatted === "none" ? "--" : formatted;
}

function supportStatusLabel(status?: string | null) {
  if (!status) return "New";
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function supportStatusTone(status?: string | null): "ok" | "warning" | "bad" | "unknown" {
  if (status === "won" || status === "closed") return "ok";
  if (status === "lost") return "bad";
  if (status === "waiting_on_customer" || status === "quoted") return "warning";
  return "unknown";
}

function supportRequestTypeLabel(value?: string | null) {
  if (!value) return "Support";
  if (value === "docs") return "Documentation";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function supportExcerpt(value?: string | null, maxLength = 160) {
  if (!value) return "No message preview.";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function mailtoUrl(email: string, subject?: string | null) {
  const params = new URLSearchParams();
  if (subject) params.set("subject", `Re: ${subject}`);
  return `mailto:${email}${params.size ? `?${params.toString()}` : ""}`;
}

function supportDetailValue(value?: string | number | null) {
  if (value == null) return "Not provided";
  const text = String(value).trim();
  return text || "Not provided";
}

function formatHealthNumber(value?: number | null, digits = 1, suffix = "") {
  if (value == null || !Number.isFinite(value)) return "Not synced";
  return `${Number(value.toFixed(digits))}${suffix}`;
}

function formatHealthInteger(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "Not synced";
  return Math.trunc(value).toLocaleString();
}

function formatHealthBoolean(value?: boolean | null, trueLabel = "Yes", falseLabel = "No") {
  if (value == null) return "Not synced";
  return value ? trueLabel : falseLabel;
}

function healthStatusLabel(snapshot?: DeviceHealthSnapshot | null) {
  if (!snapshot) return "No snapshot";
  return snapshot.overall_status || (snapshot.status_endpoint_ok ? "OK" : "Unreachable");
}

function healthTone(snapshot?: DeviceHealthSnapshot | null): "ok" | "warning" | "bad" | "unknown" {
  if (!snapshot) return "unknown";
  const status = healthStatusLabel(snapshot).toLowerCase();
  if (!snapshot.status_endpoint_ok || status.includes("critical") || status.includes("down") || status.includes("fail")) {
    return "bad";
  }
  if (
    status.includes("warning") ||
    status.includes("degraded") ||
    status.includes("stale") ||
    (snapshot.sensors_stale ?? 0) > 0 ||
    (snapshot.sensors_missing ?? 0) > 0
  ) {
    return "warning";
  }
  return "ok";
}

function healthSnapshotTimestamp(snapshot: DeviceHealthSnapshot) {
  const timestamp = snapshot.captured_at ?? snapshot.created_at;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
}

function selectHealthSnapshot(snapshots: DeviceHealthSnapshot[]) {
  return snapshots
    .filter(Boolean)
    .sort((a, b) => healthSnapshotTimestamp(b) - healthSnapshotTimestamp(a))[0] ?? null;
}

function healthStatusText(snapshot?: DeviceHealthSnapshot | null) {
  const label = healthStatusLabel(snapshot);
  return label.toUpperCase() === "OK" ? "OK" : label;
}

function runtimeStateIsFresh(runtimeState?: DeviceRuntimeState | null) {
  if (!runtimeState?.state_fresh_until) return false;
  const freshUntil = Date.parse(runtimeState.state_fresh_until);
  return Number.isFinite(freshUntil) && freshUntil > Date.now();
}

function controllerStateLabel(runtimeState?: DeviceRuntimeState | null) {
  const state = runtimeState?.controller_state?.trim();
  if (!state) return "Not synced";
  const label = state.toUpperCase();
  return runtimeStateIsFresh(runtimeState) ? label : `STALE (${label})`;
}

function configHashLabel(configState?: DeviceConfigState | null) {
  const hash = configState?.config_hash?.trim();
  return hash ? hash.slice(0, 10) : "Not synced";
}

function syncedCount(value?: number | null) {
  return value == null || !Number.isFinite(value) ? "Not synced" : Math.trunc(value).toLocaleString();
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

function incrementalReadingCursor(readings: SensorReading[]) {
  const timestamps = readings
    .map((reading) => Date.parse(reading.server_received_at))
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps) - incrementalCursorOverlapMs).toISOString();
}

function errorMessage(error: unknown) {
  if (isSessionAuthorizationError(error)) return expiredPortalSessionNotice;
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

function readingExportKey(reading: SensorReading) {
  if (!reading.pairing_name || !reading.sensor_key || !reading.device_recorded_at) {
    return reading.event_id || String(reading.id);
  }

  return [
    reading.pairing_name,
    reading.sensor_key,
    reading.device_recorded_at,
    reading.calibrated_value ?? "",
    reading.raw_value ?? "",
    reading.temperature ?? "",
    reading.electrical_conductivity ?? "",
  ].join("\u001f");
}

function exportSourcePriority(reading: SensorReading) {
  if (reading.event_id.startsWith("live-device:")) return 2;
  if (reading.event_id.startsWith("balena-export-v2:")) return 1;
  return 0;
}

function dedupeReadingsForExport(readings: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const reading of readings) {
    const key = readingExportKey(reading) || reading.event_id || String(reading.id);
    const existing = byKey.get(key);
    if (!existing || exportSourcePriority(reading) > exportSourcePriority(existing)) {
      byKey.set(key, reading);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) =>
      new Date(a.device_recorded_at).getTime() -
      new Date(b.device_recorded_at).getTime(),
  );
}

async function fetchReadingsPageByPrefix(
  prefix: string,
  limit: number,
  options: {
    newerThan?: string | null;
    before?: { timestamp: string; id: number } | null;
  } = {},
) {
  const orderColumn = options.newerThan ? "server_received_at" : "device_recorded_at";
  let query = supabase
    .from("sensor_readings")
    .select(readingSelectColumns)
    .eq("project_id", mattProjectId)
    .eq("device_id", mattDeviceId)
    .like("event_id", prefix)
    .order(orderColumn, { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(limit, pageSize));

  const { newerThan, before } = options;
  if (newerThan) {
    query = query.gte("server_received_at", newerThan);
  }
  if (before) {
    query = query.or(
      `${orderColumn}.lt.${before.timestamp},and(${orderColumn}.eq.${before.timestamp},id.lt.${before.id})`,
    );
  }

  const response = await withSupabaseTimeout(query, supabaseQueryTimeoutMs, "Sensor readings");
  if (response.error) throw response.error;
  return (response.data ?? []) as SensorReading[];
}

async function fetchReadingsByPrefix(
  prefix: string,
  maxRows: number,
  newerThan?: string | null,
  onBatch?: (batch: SensorReading[]) => void,
) {
  const readings: SensorReading[] = [];
  let before: { timestamp: string; id: number } | null = null;
  const orderColumn = newerThan ? "server_received_at" : "device_recorded_at";

  while (readings.length < maxRows) {
    const batchLimit = Math.min(pageSize, maxRows - readings.length);
    const rawBatch = await fetchReadingsPageByPrefix(
      prefix,
      batchLimit,
      { newerThan, before },
    );
    if (rawBatch.length === 0) break;

    const visibleBatch = rawBatch
      .filter((reading) => !isIgnoredDiagnosticReading(reading))
      .slice(0, maxRows - readings.length);
    readings.push(...visibleBatch);
    onBatch?.(visibleBatch);

    const lastRow = rawBatch[rawBatch.length - 1];
    const timestamp = lastRow?.[orderColumn];
    const id = Number(lastRow?.id);
    const nextBefore = typeof timestamp === "string" && Number.isFinite(id)
      ? { timestamp, id }
      : null;
    if (!nextBefore || (before?.timestamp === nextBefore.timestamp && before.id === nextBefore.id)) break;
    before = nextBefore;
    if (rawBatch.length < batchLimit) break;
  }

  return readings;
}

async function fetchReadingsForMode(
  mode: EffectiveMode,
  newerThan?: string | null,
  onBatch?: (batch: SensorReading[]) => void,
) {
  if (mode === "live") {
    return fetchReadingsByPrefix(livePrefix, graphReadLimit, newerThan, onBatch);
  }

  if (mode === "snapshot") {
    return fetchReadingsByPrefix(importedPrefix, graphReadLimit, newerThan, onBatch);
  }

  const [liveReadings, importedReadings] = await Promise.all([
    fetchReadingsByPrefix(livePrefix, graphReadLimit, newerThan, onBatch),
    fetchReadingsByPrefix(importedPrefix, graphReadLimit, newerThan, onBatch),
  ]);

  return dedupeReadings([...liveReadings, ...importedReadings]);
}

function loadedReadingCounts(readings: SensorReading[]) {
  return readings.reduce(
    (counts, reading) => {
      if (reading.event_id.startsWith("live-device:")) counts.live += 1;
      if (reading.event_id.startsWith("balena-export-v2:")) counts.imported += 1;
      return counts;
    },
    { imported: 0, live: 0 },
  );
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

function chartBounds(
  series: ChartSeries[],
  width: number,
  height: number,
  xDomain: TimeBounds | null = null,
) {
  const margin = { top: 22, right: 24, bottom: 54, left: 68 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const allPoints = series.flatMap((item) => item.points);
  const yDomain = vwcDomain(allPoints);
  const domainIsValid = xDomain && xDomain.endMs > xDomain.startMs;
  const minX = domainIsValid
    ? xDomain.startMs
    : allPoints.length ? Math.min(...allPoints.map((point) => point.timestampMs)) : 0;
  const maxX = domainIsValid
    ? xDomain.endMs
    : allPoints.length ? Math.max(...allPoints.map((point) => point.timestampMs)) : 1;
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
    points: (() => {
      const firstInside = item.points.findIndex((point) => point.timestampMs >= startMs);
      if (firstInside < 0) return item.points.slice(-1);
      const firstAfter = item.points.findIndex((point) => point.timestampMs > endMs);
      const from = Math.max(0, firstInside - 1);
      const to = firstAfter < 0 ? item.points.length : Math.min(item.points.length, firstAfter + 1);
      return item.points.slice(from, to);
    })(),
  }));
}

function wateringOverlaySeriesForEvent(
  event: HealthWateringEvent,
  series: ChartSeries[],
) {
  const pairingName = healthString(event.pairingName);
  if (pairingName) {
    const matchingName = series.find((item) => item.kind === "pot" && item.name === pairingName);
    if (matchingName) return matchingName;
  }
  const potNumber = healthNumber(event.physicalPot);
  return potNumber == null
    ? null
    : series.find((item) => item.kind === "pot" && item.potNumber === Math.trunc(potNumber)) ?? null;
}

function buildWateringOverlayMarkers(
  events: HealthWateringEvent[],
  series: ChartSeries[],
  xDomain: TimeBounds | null,
) {
  if (!xDomain) return [];
  return events.flatMap((event): WateringOverlayMarker[] => {
    const timestampMs = healthTimestampMs(event.t);
    if (timestampMs == null || timestampMs < xDomain.startMs || timestampMs > xDomain.endMs) return [];
    const matchingSeries = wateringOverlaySeriesForEvent(event, series);
    if (!matchingSeries) return [];
    const interpolation = interpolateOverlayValue(
      matchingSeries.points,
      timestampMs,
      wateringOverlayMaxSampleSpanMs,
    );
    return [{
      event,
      series: matchingSeries,
      timestampMs,
      value: interpolation?.value ?? null,
      exactValue: interpolation?.exact ?? false,
      before: interpolation?.before ?? null,
      after: interpolation?.after ?? null,
    }];
  });
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
  xDomain = null,
  wateringEvents = [],
}: {
  series: ChartSeries[];
  visibleNames: Set<string>;
  selectedName: string | null;
  viewMode: ViewMode;
  onSelectSeries: (name: string) => void;
  loading: boolean;
  xDomain?: TimeBounds | null;
  wateringEvents?: HealthWateringEvent[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [wateringTooltip, setWateringTooltip] = useState<WateringOverlayTooltip | null>(null);
  const [lockedSeriesName, setLockedSeriesName] = useState<string | null>(null);

  const visibleSeries = useMemo(
    () => series.filter((item) => visibleNames.has(item.name) && item.points.length > 0),
    [series, visibleNames],
  );
  const allWateringMarkers = useMemo(
    () => buildWateringOverlayMarkers(wateringEvents, visibleSeries, xDomain),
    [visibleSeries, wateringEvents, xDomain],
  );
  const { visible: wateringMarkers, omittedCount: omittedWateringMarkerCount } = useMemo(
    () => partitionOverlayMarkers(allWateringMarkers),
    [allWateringMarkers],
  );

  useEffect(() => {
    if (tooltip && !visibleSeries.some((item) => item.name === tooltip.seriesName)) {
      setTooltip(null);
    }
    if (lockedSeriesName && !visibleSeries.some((item) => item.name === lockedSeriesName)) {
      setLockedSeriesName(null);
    }
  }, [lockedSeriesName, tooltip, visibleSeries]);

  useEffect(() => {
    if (!wateringEvents.length) setWateringTooltip(null);
  }, [wateringEvents.length]);

  useEffect(() => {
    if (!wateringTooltip) return;
    const stillVisible = wateringMarkers.some((marker) =>
      marker.timestampMs === wateringTooltip.timestampMs &&
      marker.series.name === wateringTooltip.series.name
    );
    if (!stillVisible) setWateringTooltip(null);
  }, [wateringMarkers, wateringTooltip]);

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

      const bounds = chartBounds(visibleSeries, width, height, xDomain);
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

      for (const marker of wateringMarkers) {
        const x = xScale(marker.timestampMs);
        const y = yScale(marker.value);
        const selected = selectedName === marker.series.name;
        const markerColor = marker.series.treatment === "drought" ? "#f97316" : "#2563eb";
        context.globalAlpha = selected || visiblePotLineCount <= 6 ? 0.98 : 0.72;
        context.setLineDash([]);
        context.strokeStyle = markerColor;
        context.fillStyle = "rgba(255, 255, 255, 0.96)";
        context.lineWidth = selected ? 2.8 : 2.2;
        context.beginPath();
        context.arc(x, y, selected ? 5.2 : 4.4, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.beginPath();
        context.moveTo(x, y - (selected ? 6.5 : 5.7));
        context.lineTo(x, y - (selected ? 10 : 8.7));
        context.stroke();
        context.globalAlpha = 1;
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
  }, [visibleSeries, selectedName, viewMode, wateringMarkers, xDomain]);

  function nearestAt(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height, xDomain);
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

  function nearestWateringAt(
    event: React.MouseEvent<HTMLCanvasElement>,
  ): WateringOverlayTooltip | null {
    const canvas = canvasRef.current;
    if (!canvas || !wateringMarkers.length) return null;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height, xDomain);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;
    if (
      mouseX < margin.left ||
      mouseX > margin.left + plotWidth ||
      mouseY < margin.top ||
      mouseY > margin.top + plotHeight
    ) {
      return null;
    }

    let nearest: WateringOverlayTooltip | null = null;
    let nearestDistance = Infinity;
    for (const marker of wateringMarkers) {
      const x = xScale(marker.timestampMs);
      const y = yScale(marker.value);
      const distance = Math.hypot(x - mouseX, y - mouseY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { ...marker, x, y };
      }
    }
    return nearestDistance <= 14 ? nearest : null;
  }

  function pointOnSeriesAtX(event: React.MouseEvent<HTMLCanvasElement>, seriesName: string) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const item = visibleSeries.find((seriesItem) => seriesItem.name === seriesName);
    if (!item || item.points.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height, xDomain);
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
    if (wateringTooltip?.locked) return;
    const watering = nearestWateringAt(event);
    if (watering) {
      setWateringTooltip(watering);
      setTooltip(null);
      return;
    }
    setWateringTooltip(null);
    if (lockedSeriesName) {
      setTooltip(pointOnSeriesAtX(event, lockedSeriesName));
      return;
    }
    setTooltip(nearestAt(event));
  }

  function selectNearest(event: React.MouseEvent<HTMLCanvasElement>) {
    const watering = nearestWateringAt(event);
    if (watering) {
      setLockedSeriesName(watering.series.name);
      onSelectSeries(watering.series.name);
      setTooltip(null);
      setWateringTooltip({ ...watering, locked: true });
      return;
    }
    const nearest = nearestAt(event);
    if (nearest?.seriesKind === "pot") {
      setLockedSeriesName(nearest.seriesName);
      onSelectSeries(nearest.seriesName);
      setTooltip(pointOnSeriesAtX(event, nearest.seriesName) ?? nearest);
      setWateringTooltip(null);
      return;
    }
    setLockedSeriesName(null);
    setTooltip(null);
    setWateringTooltip(null);
  }

  return (
    <div ref={wrapperRef} className="canvas-chart">
      <canvas
        ref={canvasRef}
        onMouseDown={selectNearest}
        onMouseMove={updateTooltip}
        onClick={selectNearest}
        onMouseLeave={() => {
          if (!lockedSeriesName) {
            setTooltip(null);
            setWateringTooltip(null);
          }
        }}
        aria-label={wateringEvents.length ? "VWC with watering events chart" : "Soil moisture chart"}
      />
      {wateringEvents.length ? (
        <div className="watering-overlay-legend" aria-label="Watering overlay legend">
          <span><i />Water event</span>
          <span>{wateringMarkers.length} shown</span>
          {omittedWateringMarkerCount > 0 ? (
            <span className="is-omitted">
              {omittedWateringMarkerCount} water {omittedWateringMarkerCount === 1 ? "event" : "events"} omitted—no nearby VWC sample
            </span>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <div className="chart-loading-overlay" aria-label="Loading readings" aria-live="polite">
          <Loader2 className="chart-loading-spinner" size={34} aria-hidden="true" />
        </div>
      ) : null}
      {wateringTooltip ? (
        <>
          <div
            className="chart-crosshair is-watering"
            style={{
              left: wateringTooltip.x,
              backgroundColor: wateringTooltip.series.treatment === "drought" ? "#f97316" : "#2563eb",
            }}
          />
          <div
            className={`chart-tooltip is-watering ${wateringTooltip.locked ? "is-locked" : ""}`}
            style={{
              left: Math.min(
                Math.max(wateringTooltip.x + 14, 10),
                Math.max(10, (wrapperRef.current?.clientWidth ?? 960) - 235),
              ),
              top: Math.min(
                Math.max(wateringTooltip.y - 98, 10),
                Math.max(10, (wrapperRef.current?.clientHeight ?? 560) - 164),
              ),
              borderColor: wateringTooltip.series.treatment === "drought" ? "#f97316" : "#2563eb",
            }}
          >
            <strong>Pot {wateringTooltip.series.potNumber} watered</strong>
            <span>{formatDateTime(wateringTooltip.timestampMs)}</span>
            <span>{healthNumber(wateringTooltip.event.valveOpenTimeMs) == null
              ? "Duration not reported"
              : `${Math.round(healthNumber(wateringTooltip.event.valveOpenTimeMs) as number) / 1000} sec`}</span>
            {wateringTooltip.value == null ? (
              <b>VWC unavailable near event</b>
            ) : (
              <b>{wateringTooltip.value.toFixed(1)}% VWC {wateringTooltip.exactValue ? "measured" : "on displayed line"}</b>
            )}
            {wateringTooltip.before && wateringTooltip.after && !wateringTooltip.exactValue ? (
              <small>
                Samples: {formatDateTime(wateringTooltip.before.timestampMs)} ({wateringTooltip.before.value.toFixed(1)}%) and {formatDateTime(wateringTooltip.after.timestampMs)} ({wateringTooltip.after.value.toFixed(1)}%)
              </small>
            ) : null}
          </div>
          <div
            className="chart-lock-dot is-watering"
            style={{
              left: wateringTooltip.x,
              top: wateringTooltip.y,
              borderColor: wateringTooltip.series.treatment === "drought" ? "#f97316" : "#2563eb",
            }}
          />
        </>
      ) : tooltip ? (
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

type PortalSettingsPanelProps = {
  open: boolean;
  portalRole: PortalRole;
  activeSection: SettingsSection;
  data: LoadState;
  runtimeState: DeviceRuntimeState | null;
  configState: DeviceConfigState | null;
  pairings: PairingRow[];
  visiblePotCount: number;
  csvDownload: CsvDownload | null;
  csvError: string | null;
  exportingCsv: boolean;
  controlBusy: boolean;
  controlNotice: string | null;
  controlError: string | null;
  onClose: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onPrepareCsvDownload: () => void;
  onDownloadPairingsCsv: () => void;
  onQueueCommand: QueueControlCommand;
  onSignOut: () => void;
};

function PortalSettingsPanel({
  open,
  portalRole,
  activeSection,
  data,
  runtimeState,
  configState,
  pairings,
  visiblePotCount,
  csvDownload,
  csvError,
  exportingCsv,
  controlBusy,
  controlNotice,
  controlError,
  onClose,
  onSectionChange,
  onPrepareCsvDownload,
  onDownloadPairingsCsv,
  onQueueCommand,
  onSignOut,
}: PortalSettingsPanelProps) {
  const isAdmin = portalRole === "admin";
  const activeItem = settingsNavItems.find((item) => item.id === activeSection) ?? settingsNavItems[0];
  const boardConfigs = boardConfigsFromPayload(data.latestState?.latest_payload);
  const mirroredBoardCount = configState?.board_count ?? boardConfigs.length;
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
  const csvReady = data.readings.length > 0;

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
    }, { confirm: true });
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
          </div>
        </div>
      ) : null}
      {controlError ? (
        <div className="settings-callout is-error">
          <AlertTriangle size={18} />
          <div>
            <strong>Request failed.</strong>
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
                  <strong>{data.latestState?.health_status ?? "--"}</strong>
                </div>
                <div className="settings-row">
                  <span>Controller state</span>
                  <strong>{controllerStateLabel(runtimeState)}</strong>
                </div>
                <div className="settings-row">
                  <span>Device ID</span>
                  <strong>{data.latestState?.device_id ?? "--"}</strong>
                </div>
                <div className="settings-row">
                  <span>State observed</span>
                  <strong>{formatSettingsTimestamp(runtimeState?.state_observed_at ?? data.latestState?.updated_at)}</strong>
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
            <section className="settings-card">
              <h3>Controller Mirror</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Public URL</span>
                  <strong>{formatHealthBoolean(runtimeStateIsFresh(runtimeState) ? runtimeState?.public_url_reachable : null, "Reachable", "Down")}</strong>
                </div>
                <div className="settings-row">
                  <span>Watering</span>
                  <strong>{formatHealthBoolean(runtimeStateIsFresh(runtimeState) ? runtimeState?.watering_enabled : null, "Enabled", "Disabled")}</strong>
                </div>
                <div className="settings-row">
                  <span>Jobs loaded</span>
                  <strong>{syncedCount(runtimeStateIsFresh(runtimeState) ? runtimeState?.scheduler_jobs_loaded : null)}</strong>
                </div>
                <div className="settings-row">
                  <span>Runtime sync</span>
                  <strong>{formatSettingsTimestamp(runtimeState?.updated_at)}</strong>
                </div>
              </div>
            </section>
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
                  Set pairing
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
                  Set group targets
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
                  Create pairing
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
                  <strong>{syncedCalibrations.length || "--"}</strong>
                </div>
                <div className="settings-row">
                  <span>Applied pairings</span>
                  <strong>{syncedCalibrations.length ? pairings.length : "--"}</strong>
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
                  Create calibration
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
                Apply calibration
              </button>
            </form>
          </section>
          <div className="settings-list">
            {(syncedCalibrations.length ? syncedCalibrations : ["No calibration data"]).map((label) => (
              <div className="settings-list-row" key={label}>
                <span>{label}</span>
                {syncedCalibrations.length ? (
                  <button type="button" className="settings-danger-button" onClick={() => void deleteCalibration(label)} disabled={controlBusy}>
                    Delete
                  </button>
                ) : (
                  <em>--</em>
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
                <button type="submit" className="settings-primary-button" disabled title="Manual watering requires the physical valve fail-safe check">
                  Manual watering locked
                </button>
              </form>
              <p className="settings-muted">Targets and automatic watering settings are live. A bounded manual pulse unlocks only after the physical valve-close check.</p>
            </section>
            <section className="settings-card">
              <h3>Experiment State</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Controller</span>
                  <strong>{controllerStateLabel(runtimeState)}</strong>
                </div>
                <div className="settings-row">
                  <span>Observed</span>
                  <strong>{formatSettingsTimestamp(runtimeState?.state_observed_at)}</strong>
                </div>
              </div>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={destructiveConfirm}
                  onChange={(event) => setDestructiveConfirm(event.target.checked)}
                />
                <span>Confirm experiment stop</span>
              </label>
              <div className="settings-action-stack">
                <button type="button" onClick={() => void queueSystemState("running")} disabled={controlBusy}>
                  <CheckCircle2 size={14} /> Start experiment
                </button>
                <button type="button" onClick={() => void queueSystemState("stopped")} disabled={controlBusy || !destructiveConfirm}>
                  <AlertTriangle size={14} /> Stop experiment
                </button>
              </div>
            </section>
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
                  Create group
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
                  Remove group
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
              <h3>Hardware</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Sensors</span>
                  <strong>{uniqueSensors.size || "--"}</strong>
                </div>
                <div className="settings-row">
                  <span>Valves</span>
                  <strong>{uniqueValves.size || "--"}</strong>
                </div>
                <div className="settings-row">
                  <span>Boards</span>
                  <strong>{mirroredBoardCount || "--"}</strong>
                </div>
              </div>
            </section>
            <section className="settings-card">
              <h3>Config Sync</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Pairings</span>
                  <strong>{syncedCount(configState?.pairing_count ?? pairings.length)}</strong>
                </div>
                <div className="settings-row">
                  <span>Calibrations</span>
                  <strong>{syncedCount(configState?.calibration_count)}</strong>
                </div>
                <div className="settings-row">
                  <span>Sensors / valves</span>
                  <strong>{syncedCount(configState?.sensor_count)} / {syncedCount(configState?.valve_count)}</strong>
                </div>
                <div className="settings-row">
                  <span>Groups</span>
                  <strong>{syncedCount(configState?.group_count)}</strong>
                </div>
                <div className="settings-row">
                  <span>Config hash</span>
                  <strong>{configHashLabel(configState)}</strong>
                </div>
                <div className="settings-row">
                  <span>Config observed</span>
                  <strong>{formatSettingsTimestamp(configState?.observed_at)}</strong>
                </div>
              </div>
            </section>
            {isAdmin ? <section className="settings-card">
              <h3>Protected Operations</h3>
              <p className="settings-muted">Sensor initialization, board addresses, reset pins, credentials, firmware, and recovery stay administrator-only.</p>
              <button type="button" disabled>
                <Lock size={14} /> Sensor initialization locked
              </button>
            </section> : null}
          </div>
          {isAdmin ? <section className="settings-card">
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
                Update board
              </button>
            </form>
          </section> : null}
          <div className="settings-list">
            {(boardConfigs.length ? boardConfigs : [{ address: "--", resetPin: "--" }]).map((config, index) => (
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
              <p className="settings-muted">Downloads the clean readings currently loaded in the portal.</p>
              <button type="button" className="settings-secondary-button" onClick={onPrepareCsvDownload} disabled={exportingCsv || !csvReady}>
                <Download size={14} />
                {exportingCsv ? "Preparing..." : "Prepare readings CSV"}
              </button>
              {csvError ? <p className="settings-error-line">{csvError}</p> : null}
              {csvDownload ? (
                <a className="settings-download-link" href={csvDownload.url} download={csvDownload.filename}>
                  Download {csvDownload.rowCount.toLocaleString()} rows
                </a>
              ) : null}
            </section>
            <section className="settings-card">
              <h3>Configuration Export</h3>
              <p className="settings-muted">Download pairings or export device data.</p>
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
                  Export data
                </button>
              </div>
            </section>
          </div>
        </>
      );
    }

    return null;
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
          <div className="settings-account-actions">
            <button type="button" className="settings-sign-out-button" onClick={onSignOut}>
              <LogOut size={16} />
              Sign out
            </button>
          </div>
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

function PortalStatusPill({ snapshot }: { snapshot?: DeviceHealthSnapshot | null }) {
  const tone = healthTone(snapshot);
  return (
    <span className={`portal-status-pill is-${tone}`}>
      {healthStatusText(snapshot)}
    </span>
  );
}

function ExperimentLaunchCards({
  data,
  onOpenExperiment,
}: {
  data: LoadState;
  onOpenExperiment: (experimentId: ExperimentId) => void;
}) {
  return (
    <div className="portal-experiment-stack" aria-label="Experiments">
      {portalExperiments.map((experiment) => {
        const pairings = pairingsForExperiment(data.pairings, experiment);
        const latestReading = latestExperimentReading(data.readings, experiment);
        const activeCount = pairings.length;
        const expectedCount = experiment.pairingNames.length;
        const observationOnly = isObservationOnlyExperiment(experiment);

        return (
          <button
            type="button"
            className={`portal-launch-card is-experiment ${observationOnly ? "is-observation" : ""}`}
            key={experiment.id}
            onClick={() => onOpenExperiment(experiment.id)}
          >
            <span className="portal-launch-top">
              <span className="portal-launch-icon">
                <Activity size={20} />
              </span>
            </span>
            <span className="portal-launch-copy">
              <span className="portal-launch-title">{experiment.name}</span>
              <strong>{activeCount} / {expectedCount} pots</strong>
              <em>{experiment.shortDescription}</em>
              <em>Updated {formatSettingsTimestamp(latestReading?.device_recorded_at ?? data.latestIngestTime)}</em>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PortalResearcherHome({
  data,
  onOpenExperiment,
}: {
  data: LoadState;
  onOpenExperiment: (experimentId: ExperimentId) => void;
}) {
  return (
    <section className="portal-admin-main" aria-label="Research experiments">
      <div className="portal-launch-grid">
        <ExperimentLaunchCards data={data} onOpenExperiment={onOpenExperiment} />
      </div>
    </section>
  );
}

function PortalAdminHome({
  data,
  healthSnapshot,
  healthLoading,
  salesSupportData,
  salesSupportLoading,
  rdAccessAllowed,
  onOpenExperiment,
  onOpenHealth,
  onOpenSupport,
  onOpenRd,
}: {
  data: LoadState;
  healthSnapshot: DeviceHealthSnapshot | null;
  healthLoading: boolean;
  salesSupportData: SalesSupportData;
  salesSupportLoading: boolean;
  rdAccessAllowed: boolean;
  onOpenExperiment: (experimentId: ExperimentId) => void;
  onOpenHealth: () => void;
  onOpenSupport: () => void;
  onOpenRd: () => void;
}) {
  const healthUpdated = healthSnapshot?.captured_at ?? healthSnapshot?.created_at ?? null;
  const supportThreads = salesSupportData.threads.filter((item) => item.request_type !== "quote" && item.source !== "quote");
  const openSupportCount = supportThreads.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost").length;
  const newSupportCount = supportThreads.filter((item) => item.status === "new").length;
  const quoteCount = salesSupportData.quotes.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost").length;
  const supportUpdated = supportThreads
    .map((item) => item.last_message_at ?? item.updated_at ?? item.created_at)
    .concat(salesSupportData.quotes.map((item) => item.updated_at ?? item.created_at))
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
  const sensorLine = healthSnapshot
    ? `${formatHealthInteger(healthSnapshot.sensors_current)} / ${formatHealthInteger(healthSnapshot.sensors_expected)} sensors`
    : "No health snapshot";

  return (
    <section className="portal-admin-main" aria-label="Portal sections">
      <div className="portal-launch-grid">
        <div className="portal-experiment-column">
          <ExperimentLaunchCards data={data} onOpenExperiment={onOpenExperiment} />

          <span className="portal-health-link" aria-hidden="true">
            <span className="portal-health-link-arm is-left" />
            <span className="portal-health-link-drop" />
          </span>

          <button type="button" className="portal-launch-card is-health" onClick={onOpenHealth}>
            <span className="portal-launch-top">
              <span className="portal-launch-icon">
                <Server size={18} />
              </span>
              <PortalStatusPill snapshot={healthSnapshot} />
            </span>
            <span className="portal-launch-copy">
              <span className="portal-launch-title">System Health</span>
              <strong>{healthLoading && !healthSnapshot ? "Loading..." : sensorLine}</strong>
              <em>Updated {formatSettingsTimestamp(healthUpdated)}</em>
            </span>
            <span className="portal-launch-action">
              Open <ArrowRight size={14} />
            </span>
          </button>
        </div>

        <div className="portal-business-stack">
          <button type="button" className="portal-launch-card is-support" onClick={onOpenSupport}>
            <span className="portal-launch-top">
              <span className="portal-launch-icon">
                <Mail size={20} />
              </span>
              <span className={`portal-status-pill ${newSupportCount ? "is-warning" : "is-ok"}`}>
                {newSupportCount ? "NEW" : "READY"}
              </span>
            </span>
            <span className="portal-launch-copy">
              <span className="portal-launch-title">Sales &amp; Support</span>
              <strong>{salesSupportLoading ? "Loading..." : `${newSupportCount} new · ${openSupportCount + quoteCount} open`}</strong>
              <em>Updated {formatSettingsTimestamp(supportUpdated)}</em>
            </span>
            <span className="portal-launch-action">
              Open <ArrowRight size={14} />
            </span>
          </button>

          {rdAccessAllowed ? (
            <button type="button" className="portal-launch-card is-rd" onClick={onOpenRd}>
              <span className="portal-status-pill">LIVE MODEL</span>
              <span className="portal-launch-title">R&amp;D · Response Curve Model</span>
              <span className="portal-launch-action">Open Lab</span>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SupportStatusPill({ status }: { status?: string | null }) {
  return (
    <span className={`portal-status-pill is-${supportStatusTone(status)}`}>
      {supportStatusLabel(status)}
    </span>
  );
}

type SupportSelectedDetail = {
  title: string;
  subtitle: string;
  messageLabel: string;
  message: string;
  replyHref: string;
  rows: Array<{ label: string; value: string }>;
};

function SalesSupportDetailDrawer({
  detail,
  onClose,
}: {
  detail: SupportSelectedDetail | null;
  onClose: () => void;
}) {
  if (!detail) return null;

  return (
    <>
      <button
        type="button"
        className="health-detail-scrim"
        aria-label="Close selected sales support detail"
        onClick={onClose}
      />
      <aside className="health-selected-detail support-selected-detail" aria-label="Sales support detail">
        <header>
          <div>
            <p>{detail.subtitle}</p>
            <h2>{detail.title}</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <div className="health-selected-detail-rows">
          {detail.rows.map((row, index) => (
            <div className="health-selected-detail-row" key={`${row.label}-${index}`}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
        <section className="support-detail-message">
          <h3>{detail.messageLabel}</h3>
          <p>{detail.message}</p>
        </section>
        <a className="settings-primary-button support-detail-reply" href={detail.replyHref}>
          <Mail size={15} />
          Reply
        </a>
      </aside>
    </>
  );
}

function SalesSupportView({
  data,
  loading,
  error,
  onBackHome,
}: {
  data: SalesSupportData;
  loading: boolean;
  error: string | null;
  onBackHome: () => void;
}) {
  const [selectedDetail, setSelectedDetail] = useState<SupportSelectedDetail | null>(null);
  const supportThreads = data.threads.filter((item) => item.request_type !== "quote" && item.source !== "quote");
  const messagesByThread = useMemo(() => {
    const messages = new Map<string, SupportMessageRow>();
    data.messages
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .forEach((message) => {
        if (!messages.has(message.thread_id)) messages.set(message.thread_id, message);
      });
    return messages;
  }, [data.messages]);
  const openQuotes = data.quotes.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost");
  const openThreads = supportThreads.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost");
  const newItems = [
    ...data.quotes.filter((item) => (item.status ?? "new") === "new"),
    ...supportThreads.filter((item) => item.status === "new"),
  ];
  const latestUpdated = [
    ...data.quotes.map((item) => item.updated_at ?? item.created_at),
    ...supportThreads.map((item) => item.last_message_at ?? item.updated_at ?? item.created_at),
  ]
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  function selectQuote(quote: QuoteRequestRow) {
    setSelectedDetail({
      title: quote.application,
      subtitle: "Quote Request",
      messageLabel: "Project Details",
      message: supportDetailValue(quote.message),
      replyHref: mailtoUrl(quote.email, `exactH2O quote: ${quote.application}`),
      rows: [
        { label: "Customer", value: supportDetailValue(quote.name) },
        { label: "Email", value: supportDetailValue(quote.email) },
        { label: "Phone", value: supportDetailValue(quote.phone) },
        { label: "Organization", value: supportDetailValue(quote.organization) },
        { label: "Application", value: supportDetailValue(quote.application) },
        { label: "Timeline", value: supportDetailValue(quote.timeline) },
        { label: "Submitted", value: formatSettingsTimestamp(quote.created_at) },
        { label: "Updated", value: formatSettingsTimestamp(quote.updated_at) },
        { label: "Status", value: supportStatusLabel(quote.status ?? "new") },
        { label: "Priority", value: supportStatusLabel(quote.priority ?? "normal") },
      ],
    });
  }

  function selectThread(thread: SupportThreadRow) {
    const message = messagesByThread.get(thread.id);
    setSelectedDetail({
      title: thread.subject,
      subtitle: "Support Request",
      messageLabel: "Message",
      message: supportDetailValue(message?.body_text ?? thread.last_message_preview),
      replyHref: mailtoUrl(thread.customer_email, thread.subject),
      rows: [
        { label: "Customer", value: supportDetailValue(thread.customer_name) },
        { label: "Email", value: supportDetailValue(thread.customer_email) },
        { label: "Phone", value: supportDetailValue(thread.customer_phone) },
        { label: "Organization", value: supportDetailValue(thread.customer_organization) },
        { label: "Type", value: supportRequestTypeLabel(thread.request_type) },
        { label: "Source", value: supportStatusLabel(thread.source) },
        { label: "Status", value: supportStatusLabel(thread.status) },
        { label: "Priority", value: supportStatusLabel(thread.priority) },
        { label: "Created", value: formatSettingsTimestamp(thread.created_at) },
        { label: "Last message", value: formatSettingsTimestamp(thread.last_message_at) },
        { label: "Last from", value: supportDetailValue(thread.last_message_from_email ?? message?.from_email) },
        { label: "Message subject", value: supportDetailValue(message?.subject ?? thread.last_message_subject) },
        { label: "Thread ID", value: thread.id },
      ],
    });
  }

  return (
    <section className="sales-support-main" aria-label="Sales and support">
      <SalesSupportDetailDrawer detail={selectedDetail} onClose={() => setSelectedDetail(null)} />
      <button type="button" className="support-back-button" onClick={onBackHome}>
        <ArrowLeft size={15} />
        Home
      </button>
      <header className="support-hero">
        <div>
          <p>Sales &amp; Support</p>
          <h1>{newItems.length} new</h1>
        </div>
        {loading ? (
          <Loader2 className="chart-loading-spinner" size={22} aria-label="Loading support queue" />
        ) : null}
      </header>

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <div className="support-summary-grid">
        <HealthMiniFact label="Open quotes" value={String(openQuotes.length)} />
        <HealthMiniFact label="Open support" value={String(openThreads.length)} />
        <HealthMiniFact label="New items" value={String(newItems.length)} />
        <HealthMiniFact label="Last update" value={formatSettingsTimestamp(latestUpdated)} />
      </div>

      <div className="support-queue-grid">
        <section className="support-panel">
          <header>
            <div>
              <p>Sales</p>
              <h2>Quote Requests</h2>
            </div>
            <span>{data.quotes.length}</span>
          </header>
          <div className="support-list">
            {data.quotes.length ? data.quotes.map((quote) => (
              <article className="support-item" key={quote.id}>
                <div
                  className="support-item-main support-item-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => selectQuote(quote)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectQuote(quote);
                    }
                  }}
                >
                  <div className="support-item-title">
                    <strong>{quote.application}</strong>
                    <SupportStatusPill status={quote.status ?? "new"} />
                  </div>
                  <p>{supportExcerpt(quote.message)}</p>
                  <dl>
                    <div>
                      <dt>Customer</dt>
                      <dd>{quote.name} · {quote.email}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>{quote.organization || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Submitted</dt>
                      <dd>{formatSettingsTimestamp(quote.created_at)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="support-item-actions">
                  <button type="button" className="settings-secondary-button" onClick={() => selectQuote(quote)}>
                    <Search size={14} />
                    Details
                  </button>
                  <a className="settings-secondary-button" href={mailtoUrl(quote.email, `exactH2O quote: ${quote.application}`)}>
                    <Mail size={14} />
                    Reply
                  </a>
                </div>
              </article>
            )) : (
              <div className="support-empty">No quote requests yet.</div>
            )}
          </div>
        </section>

        <section className="support-panel">
          <header>
            <div>
              <p>Inbox</p>
              <h2>Support Emails</h2>
            </div>
            <span>{supportThreads.length}</span>
          </header>
          <div className="support-list">
            {supportThreads.length ? supportThreads.map((thread) => (
              <article className="support-item" key={thread.id}>
                <div
                  className="support-item-main support-item-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => selectThread(thread)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectThread(thread);
                    }
                  }}
                >
                  <div className="support-item-title">
                    <strong>{thread.subject}</strong>
                    <SupportStatusPill status={thread.status} />
                  </div>
                  <p>
                    {thread.last_message_preview
                      ? supportExcerpt(thread.last_message_preview)
                      : `${supportRequestTypeLabel(thread.request_type)} · ${thread.source === "email" ? "Email" : "Website"}`}
                  </p>
                  <dl>
                    <div>
                      <dt>Customer</dt>
                      <dd>{thread.customer_name ? `${thread.customer_name} · ` : ""}{thread.customer_email}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>{thread.customer_organization || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Last message</dt>
                      <dd>{formatSettingsTimestamp(thread.last_message_at)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="support-item-actions">
                  <button type="button" className="settings-secondary-button" onClick={() => selectThread(thread)}>
                    <Search size={14} />
                    Details
                  </button>
                  <a className="settings-secondary-button" href={mailtoUrl(thread.customer_email, thread.subject)}>
                    <MessageSquare size={14} />
                    Reply
                  </a>
                </div>
              </article>
            )) : (
              <div className="support-empty">No support emails captured yet.</div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

type HealthChartPoint = {
  t: number;
  iso: string;
  value: number | null;
};

type HealthChartWindow = {
  startMs: number;
  endMs: number;
  maxOffset: number;
};

type HealthChartSeries = {
  label: string;
  tone: "primary" | "secondary" | "warning" | "danger";
  points: HealthChartPoint[];
};

type HealthSelectedDetail = {
  title: string;
  rows: Array<{ label: string; value: string }>;
};

type HealthHistoryRecord = Record<string, unknown> & {
  t?: string;
};

type HealthWateringEvent = Record<string, unknown> & {
  t?: string;
  pairing?: string;
  pairingName?: string;
  originalPairing?: string;
  physicalPot?: number;
  valveOpenTimeMs?: number;
  sensor?: string;
  valve?: string;
};

function healthRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function healthNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function healthString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function healthBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function healthTimestampMs(value: unknown): number | null {
  const textValue = healthString(value);
  if (!textValue) return null;
  const ms = Date.parse(textValue);
  return Number.isFinite(ms) ? ms : null;
}

function healthDurationText(secondsValue: unknown) {
  const seconds = healthNumber(secondsValue);
  if (seconds == null) return "--";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours) return `uptime ${hours}h ${minutes}m`;
  if (minutes) return `uptime ${minutes}m`;
  return `uptime ${rounded}s`;
}

function healthCompactDuration(msValue: number | null) {
  if (msValue == null || !Number.isFinite(msValue)) return "--";
  const seconds = Math.max(0, Math.round(msValue / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

function healthHistoryRecords(
  snapshot: DeviceHealthSnapshot | null,
  snapshots: DeviceHealthSnapshot[] = [],
): HealthHistoryRecord[] {
  const records = snapshot?.raw_history?.records;
  if (Array.isArray(records) && records.length > 0) {
    return records
      .map((record) => healthRecord(record) as HealthHistoryRecord)
      .filter((record) => healthTimestampMs(record.t) != null)
      .sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0));
  }

  return snapshots
    .map((item) => ({
      t: item.captured_at ?? item.created_at,
      uptimeSeconds: item.uptime_seconds,
      ethUp: item.ethernet_link,
      cpuTempC: item.cpu_temp_c,
      undervoltage: item.undervoltage,
      undervoltageOccurred: null,
      staleOrMissingSensors:
        item.sensors_stale == null || item.sensors_missing == null
          ? null
          : item.sensors_stale + item.sensors_missing,
      sensorRows: item.sensors_current,
    }))
    .filter((record) => healthTimestampMs(record.t) != null)
    .sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0));
}

function healthRecentRecords(records: HealthHistoryRecord[], hours: number) {
  if (records.length < 3) return records;
  const last = healthTimestampMs(records[records.length - 1]?.t);
  if (last == null) return records;
  const start = last - hours * 60 * 60 * 1000;
  const recent = records.filter((record) => {
    const time = healthTimestampMs(record.t);
    return time != null && time >= start;
  });
  return recent.length >= 3 ? recent : records;
}

function healthChartPoint(record: HealthHistoryRecord, key: string, fallback: number | null = null): HealthChartPoint {
  const time = healthTimestampMs(record.t) ?? Date.now();
  return {
    t: time,
    iso: healthString(record.t) ?? new Date(time).toISOString(),
    value: healthNumber(record[key]) ?? fallback,
  };
}

function healthChartWindow(times: number[], offset: number, windowHours = healthChartWindowHours): HealthChartWindow {
  const spanMs = windowHours * 60 * 60 * 1000;
  const validTimes = times.filter((time) => Number.isFinite(time)).sort((a, b) => a - b);
  const now = Date.now();

  if (!validTimes.length) {
    return {
      startMs: now - spanMs,
      endMs: now,
      maxOffset: 0,
    };
  }

  const first = validTimes[0];
  const last = validTimes[validTimes.length - 1];
  if (last <= first || last - first <= spanMs) {
    return {
      startMs: first,
      endMs: Math.max(first + 1, last),
      maxOffset: 0,
    };
  }

  const maxOffset = Math.max(0, Math.ceil((last - first) / spanMs) - 1);
  const safeOffset = Math.max(0, Math.min(offset, maxOffset));
  let endMs = last - safeOffset * spanMs;
  let startMs = endMs - spanMs;

  if (startMs < first) {
    startMs = first;
    endMs = Math.min(last, first + spanMs);
  }

  return {
    startMs,
    endMs: Math.max(startMs + 1, endMs),
    maxOffset,
  };
}

function HealthChartControls({
  windowOffset,
  maxOffset,
  onChange,
}: {
  windowOffset: number;
  maxOffset: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="health-chart-controls" aria-label="Chart time window">
      <button
        type="button"
        aria-label="Older samples"
        title="Older samples"
        disabled={windowOffset >= maxOffset}
        onClick={() => onChange(Math.min(maxOffset, windowOffset + 1))}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        type="button"
        aria-label="Newer samples"
        title="Newer samples"
        disabled={windowOffset <= 0}
        onClick={() => onChange(Math.max(0, windowOffset - 1))}
      >
        <ArrowRight size={14} />
      </button>
      <button
        type="button"
        className="health-chart-reset"
        disabled={windowOffset === 0}
        onClick={() => onChange(0)}
      >
        Reset
      </button>
    </div>
  );
}

function healthOwnerValue(
  snapshot: DeviceHealthSnapshot | null,
  runtimeState: DeviceRuntimeState | null,
  key: string,
) {
  return healthEvidenceValue({
    snapshotStatus: snapshot?.raw_status,
    snapshotHealth: snapshot?.raw_health,
    runtimeStatus: runtimeState?.raw_status,
    runtimeHealth: runtimeState?.raw_health,
    runtimeFresh: runtimeStateIsFresh(runtimeState),
  }, key);
}

function currentUptimeSeconds(
  snapshot: DeviceHealthSnapshot | null,
  runtimeState: DeviceRuntimeState | null,
  records: HealthHistoryRecord[],
) {
  return (
    healthNumber(healthOwnerValue(snapshot, runtimeState, "current_uptime_seconds")) ??
    healthNumber(healthOwnerValue(snapshot, runtimeState, "uptime_seconds")) ??
    snapshot?.uptime_seconds ??
    healthNumber(records[records.length - 1]?.uptimeSeconds)
  );
}

function currentHealthObservation(
  snapshot: DeviceHealthSnapshot | null,
  runtimeState: DeviceRuntimeState | null,
  uptimeSeconds: number | null,
): HealthHistoryRecord | null {
  if (!runtimeStateIsFresh(runtimeState) || !runtimeState?.state_observed_at) return null;
  const staleOrMissingSensors = sumKnownCounts(
    runtimeState.sensors_stale ?? snapshot?.sensors_stale,
    runtimeState.sensors_missing ?? snapshot?.sensors_missing,
  );
  return {
    t: runtimeState.state_observed_at,
    uptimeSeconds,
    ethUp:
      healthBoolean(healthOwnerValue(snapshot, runtimeState, "ethernet_link")) ??
      snapshot?.ethernet_link ??
      null,
    cpuTempC:
      healthNumber(healthOwnerValue(snapshot, runtimeState, "cpu_temp_c")) ??
      snapshot?.cpu_temp_c ??
      null,
    undervoltage:
      healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_current")) ??
      snapshot?.undervoltage ??
      null,
    undervoltageOccurred: healthBoolean(
      healthOwnerValue(snapshot, runtimeState, "undervoltage_occurred"),
    ),
    staleOrMissingSensors,
    sensorRows: runtimeState.sensors_current ?? snapshot?.sensors_current ?? null,
  };
}

function mergeHealthObservation(
  records: HealthHistoryRecord[],
  observation: HealthHistoryRecord | null,
) {
  if (!observation || healthTimestampMs(observation.t) == null) return records;
  const byTimestamp = new Map<number, HealthHistoryRecord>();
  records.forEach((record) => {
    const timestamp = healthTimestampMs(record.t);
    if (timestamp != null) byTimestamp.set(timestamp, record);
  });
  const observationTimestamp = healthTimestampMs(observation.t) as number;
  byTimestamp.set(observationTimestamp, {
    ...(byTimestamp.get(observationTimestamp) ?? {}),
    ...observation,
  });
  return Array.from(byTimestamp.entries())
    .sort(([left], [right]) => left - right)
    .map(([, record]) => record);
}

function restartEvents(records: HealthHistoryRecord[]) {
  const events: Array<{ t: string; detectedAt: string; previous: string; uptimeSeconds: number; previousUptimeSeconds: number }> = [];
  let previous: HealthHistoryRecord | null = null;
  records.forEach((record) => {
    const uptime = healthNumber(record.uptimeSeconds);
    const previousUptime = previous ? healthNumber(previous.uptimeSeconds) : null;
    const recordTime = healthTimestampMs(record.t);
    if (previous && previousUptime != null && uptime != null && uptime + 90 < previousUptime && recordTime != null) {
      const bootMs = recordTime - uptime * 1000;
      events.push({
        t: new Date(bootMs).toISOString(),
        detectedAt: healthString(record.t) ?? new Date(recordTime).toISOString(),
        previous: healthString(previous.t) ?? "",
        uptimeSeconds: uptime,
        previousUptimeSeconds: previousUptime,
      });
    }
    previous = record;
  });
  return events;
}

function monitoringGaps(records: HealthHistoryRecord[], sampleIntervalSeconds = 300) {
  const thresholdMs = Math.max(8 * 60 * 1000, sampleIntervalSeconds * 2.25 * 1000);
  const gaps: Array<{ start: string; end: string; durationMs: number }> = [];
  records.forEach((record, index) => {
    if (!index) return;
    const previous = records[index - 1];
    const start = healthTimestampMs(previous.t);
    const end = healthTimestampMs(record.t);
    if (start == null || end == null) return;
    const durationMs = end - start;
    if (durationMs > thresholdMs) {
      gaps.push({
        start: healthString(previous.t) ?? new Date(start).toISOString(),
        end: healthString(record.t) ?? new Date(end).toISOString(),
        durationMs,
      });
    }
  });
  return gaps;
}

function wateringEventPhysicalKey(event: HealthWateringEvent) {
  const timeMs = healthTimestampMs(event.t);
  if (timeMs == null) return null;

  const record = event as Record<string, unknown>;
  const sourceSensorId =
    healthNumber(record.source_sensor_id) ??
    healthNumber(record.sourceSensorId) ??
    healthNumber(record.sensor_id) ??
    healthNumber(record.sensorId);
  const sourceValveId =
    healthNumber(record.source_valve_id) ??
    healthNumber(record.sourceValveId) ??
    healthNumber(record.valve_id) ??
    healthNumber(record.valveId);
  const sourcePair = sourcePairKey(sourceSensorId, sourceValveId);
  const pot =
    healthNumber(event.physicalPot) ??
    healthNumber(record.physical_pot) ??
    healthNumber(record.pot_number) ??
    healthNumber(record.pot);
  const valve =
    normalizedWateringToken(event.valve) ||
    normalizedWateringToken(record.valve_key) ||
    normalizedWateringToken(record.valveKey) ||
    normalizedWateringToken(record.valve_id) ||
    normalizedWateringToken(record.valveId);
  const pairing =
    normalizedWateringToken(event.pairing) ||
    normalizedWateringToken(event.pairingName) ||
    normalizedWateringToken(record.pairing_name) ||
    normalizedWateringToken(record.pairingName) ||
    normalizedWateringToken(record.name);
  const identity =
    pot != null ? `pot:${Math.trunc(pot)}` :
    sourcePair ? `pair:${sourcePair}` :
    sourceValveId != null ? `source-valve:${Math.trunc(sourceValveId)}` :
    valve ? `valve:${valve}` :
    pairing ? `pairing:${pairing}` :
    null;
  if (!identity) return null;

  const duration =
    healthNumber(event.valveOpenTimeMs) ??
    healthNumber(record.valve_open_time_ms) ??
    healthNumber(record.duration_ms) ??
    healthNumber(record.durationMs);
  const action = normalizedWateringToken(record.action) || "open";
  const timeBucket = Math.floor(timeMs / wateringEventDedupeBucketMs);
  const durationBucket = duration == null ? "unknown-duration" : String(Math.round(duration / 1000));

  return `${timeBucket}:${identity}:${action}:${durationBucket}`;
}

function dedupeWateringEvents(events: HealthWateringEvent[]) {
  const seen = new Set<string>();
  return events
    .filter((event) => healthTimestampMs(event.t) != null)
    .filter((event) => {
      const record = event as Record<string, unknown>;
      const key = wateringEventPhysicalKey(event) ??
        healthFirstEventText(record, ["event_id", "eventId", "id"]) ??
        `${event.t}-${healthString(event.pairing) ?? wateringEventLabel(event)}-${healthFirstEventText(record, ["valve", "valve_key", "valveKey"]) ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0));
}

function pairingLabel(pairing: PairingRow) {
  return `Pot ${pairing.pot_number}`;
}

function wateringAxisLabel(pairing: PairingRow) {
  const treatment = treatmentForPairing(pairing);
  const shortTreatment =
    treatment === "control" ? "C" :
    treatment === "drought" ? "D" :
    "";
  return shortTreatment ? `${pairingLabel(pairing)} ${shortTreatment}` : pairingLabel(pairing);
}

type WateringPairingIndex = {
  byLabel: Map<string, PairingRow>;
  bySourcePair: Map<string, PairingRow>;
  bySensorId: Map<string, PairingRow>;
  byValveId: Map<string, PairingRow>;
  bySensorKey: Map<string, PairingRow>;
  byValveKey: Map<string, PairingRow>;
  byPot: Map<number, PairingRow>;
};

function normalizedWateringToken(value: unknown) {
  const text = healthEventText(value);
  return text ? text.trim().replace(/;+$/g, "").trim().toLowerCase() : "";
}

function sourcePairKey(sensorId: unknown, valveId: unknown) {
  const sensorNumber = healthNumber(sensorId);
  const valveNumber = healthNumber(valveId);
  if (sensorNumber == null || valveNumber == null) return null;
  return `${Math.trunc(sensorNumber)}-${Math.trunc(valveNumber)}`;
}

function sourcePairKeyFromText(value: unknown) {
  const text = healthEventText(value);
  if (!text) return null;
  const match = text.match(/(?:^|[^\d])(\d+)\s*-\s*(\d+)\s*;?(?=$|[^\d])/);
  if (!match) return null;
  return sourcePairKey(match[1], match[2]);
}

function hardwareKeyVariants(value: unknown) {
  const token = normalizedWateringToken(value);
  if (!token) return [];
  const variants = new Set([token]);
  const parts = token.split(":");
  if (parts.length >= 2) {
    variants.add(parts.slice(-2).join(":"));
  }
  return Array.from(variants);
}

function addPairingLookup(map: Map<string, PairingRow>, key: unknown, pairing: PairingRow) {
  const token = normalizedWateringToken(key);
  if (token) map.set(token, pairing);
}

function addPairingHardwareLookup(map: Map<string, PairingRow>, key: unknown, pairing: PairingRow) {
  for (const variant of hardwareKeyVariants(key)) {
    map.set(variant, pairing);
  }
}

function buildWateringPairingIndex(pairings: PairingRow[]): WateringPairingIndex {
  const index: WateringPairingIndex = {
    byLabel: new Map(),
    bySourcePair: new Map(),
    bySensorId: new Map(),
    byValveId: new Map(),
    bySensorKey: new Map(),
    byValveKey: new Map(),
    byPot: new Map(),
  };

  pairings.forEach((pairing) => {
    addPairingLookup(index.byLabel, pairing.name, pairing);
    addPairingLookup(index.byLabel, pairingLabel(pairing), pairing);
    addPairingLookup(index.byLabel, String(pairing.pot_number), pairing);
    addPairingHardwareLookup(index.bySensorKey, pairing.sensor_key, pairing);
    addPairingHardwareLookup(index.byValveKey, pairing.valve_key, pairing);
    index.byPot.set(pairing.pot_number, pairing);

    const sensorId = healthNumber(pairing.source_sensor_id);
    const valveId = healthNumber(pairing.source_valve_id);
    const pairKey = sourcePairKey(sensorId, valveId);
    if (pairKey) index.bySourcePair.set(pairKey, pairing);
    if (sensorId != null) index.bySensorId.set(String(Math.trunc(sensorId)), pairing);
    if (valveId != null) index.byValveId.set(String(Math.trunc(valveId)), pairing);
  });

  return index;
}

function resolveWateringEventPairing(event: HealthWateringEvent, index: WateringPairingIndex) {
  const record = event as Record<string, unknown>;
  const pot = healthNumber(event.physicalPot ?? record.physical_pot ?? record.pot_number ?? record.pot);
  if (pot != null) {
    const pairing = index.byPot.get(Math.trunc(pot));
    if (pairing) return pairing;
  }

  const textCandidates = [
    event.pairing,
    event.pairingName,
    record.pairing_name,
    record.pairingName,
    record.name,
    record.label,
    record.pot,
    record.valve,
    record.valve_key,
    record.valveKey,
    record.valve_id,
    record.valveId,
    record.sensor,
    record.sensor_key,
    record.sensorKey,
    record.sensor_id,
    record.sensorId,
    record.id,
    record.event_id,
    record.eventId,
  ];

  for (const value of textCandidates) {
    const sourcePair = sourcePairKeyFromText(value);
    if (sourcePair && index.bySourcePair.has(sourcePair)) return index.bySourcePair.get(sourcePair);

    const token = normalizedWateringToken(value);
    if (token && index.byLabel.has(token)) return index.byLabel.get(token);
  }

  const sourceSensorId =
    healthNumber(record.source_sensor_id) ??
    healthNumber(record.sourceSensorId) ??
    healthNumber(record.sensor_id) ??
    healthNumber(record.sensorId);
  const sourceValveId =
    healthNumber(record.source_valve_id) ??
    healthNumber(record.sourceValveId) ??
    healthNumber(record.valve_id) ??
    healthNumber(record.valveId);
  const pairKey = sourcePairKey(sourceSensorId, sourceValveId);
  if (pairKey && index.bySourcePair.has(pairKey)) return index.bySourcePair.get(pairKey);
  if (sourceValveId != null) {
    const pairing = index.byValveId.get(String(Math.trunc(sourceValveId)));
    if (pairing) return pairing;
  }
  if (sourceSensorId != null) {
    const pairing = index.bySensorId.get(String(Math.trunc(sourceSensorId)));
    if (pairing) return pairing;
  }

  for (const value of [record.valve, record.valve_key, record.valveKey, event.valve]) {
    for (const variant of hardwareKeyVariants(value)) {
      const pairing = index.byValveKey.get(variant);
      if (pairing) return pairing;
    }
  }
  for (const value of [record.sensor, record.sensor_key, record.sensorKey, event.sensor]) {
    for (const variant of hardwareKeyVariants(value)) {
      const pairing = index.bySensorKey.get(variant);
      if (pairing) return pairing;
    }
  }

  return null;
}

function withResolvedWateringPairing(event: HealthWateringEvent, pairing: PairingRow): HealthWateringEvent {
  return {
    ...event,
    originalPairing: event.originalPairing ?? event.pairing,
    pairing: pairingLabel(pairing),
    pairingName: pairing.name,
    physicalPot: pairing.pot_number,
    valveOpenTimeMs: event.valveOpenTimeMs ?? pairing.valve_open_time_ms,
    sensor: pairing.sensor_key,
    valve: pairing.valve_key,
    source_sensor_id: pairing.source_sensor_id,
    source_valve_id: pairing.source_valve_id,
  };
}

function resolveHealthWateringEvents(events: HealthWateringEvent[], pairings: PairingRow[]) {
  const index = buildWateringPairingIndex(pairings);
  return dedupeWateringEvents(events
    .map((event) => {
      const pairing = resolveWateringEventPairing(event, index);
      return pairing ? withResolvedWateringPairing(event, pairing) : null;
    })
    .filter((event): event is HealthWateringEvent => event != null));
}

function valveEventsToHealthWateringEvents(events: ValveEvent[], pairings: PairingRow[]) {
  const pairingByNameLocal = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  const pairingByValve = new Map(pairings.map((pairing) => [pairing.valve_key, pairing]));

  return dedupeWateringEvents(events
    .filter((event) => event.action === "open")
    .filter((event) => !isIgnoredDiagnosticValveEvent(event))
    .map((event) => {
      const pairing = pairingByNameLocal.get(event.pairing_name) ?? pairingByValve.get(event.valve_key);
      return {
        ...event,
        id: event.event_id ?? event.id,
        t: event.device_recorded_at ?? event.server_received_at,
        pairing: event.pairing_name || pairing?.name,
        physicalPot: pairing?.pot_number,
        valveOpenTimeMs: event.duration_ms ?? pairing?.valve_open_time_ms,
        sensor: pairing?.sensor_key,
        valve: event.valve_key,
      } satisfies HealthWateringEvent;
    }));
}

function valveEventTimestampMs(event: ValveEvent) {
  const timestamp = Date.parse(event.device_recorded_at ?? event.server_received_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeValveEventRows(current: ValveEvent[], incoming: ValveEvent[]) {
  const cutoff = Date.now() - wateringHistoryMs;
  const byEvent = new Map<string, ValveEvent>();
  [...current, ...incoming].forEach((event) => {
    if (!event.event_id || valveEventTimestampMs(event) < cutoff || isIgnoredDiagnosticValveEvent(event)) return;
    byEvent.set(event.event_id, event);
  });
  return Array.from(byEvent.values())
    .sort((left, right) => valveEventTimestampMs(right) - valveEventTimestampMs(left))
    .slice(0, maxValveEventRows);
}

function wateringEventsLastDay(events: HealthWateringEvent[]) {
  const since = Date.now() - dayMs;
  return events.filter((event) => {
    const time = healthTimestampMs(event.t);
    return time != null && time >= since;
  });
}

function recentWateringEvents(events: HealthWateringEvent[], hours: number, maxFallback = 40) {
  if (!events.length) return [];
  const last = healthTimestampMs(events[events.length - 1]?.t);
  if (last == null) return events.slice(-maxFallback);
  const recent = events.filter((event) => {
    const time = healthTimestampMs(event.t);
    return time != null && time >= last - hours * 60 * 60 * 1000;
  });
  return recent.length ? recent : events.slice(-maxFallback);
}

function wateringEventLabel(event: HealthWateringEvent) {
  const pot = healthNumber(event.physicalPot);
  if (pot != null) return `Pot ${Math.trunc(pot)}`;
  const pairing = healthString(event.pairing);
  const match = pairing?.match(/Pot\\s*(\\d+)/i);
  if (match) return `Pot ${match[1]}`;
  return pairing ?? "Event";
}

function healthDateWithAge(value: string | null | undefined) {
  if (!value) return "Not synced";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return formatSettingsTimestamp(value);
  const ageMinutesValue = Math.max(0, Math.round((Date.now() - ms) / 60000));
  const age =
    ageMinutesValue < 1 ? "now" :
    ageMinutesValue < 60 ? `${ageMinutesValue}m ago` :
    `${Math.floor(ageMinutesValue / 60)}h ${ageMinutesValue % 60}m ago`;
  return `${formatSettingsTimestamp(value)} (${age})`;
}

function healthAgeText(value: string | null | undefined) {
  if (!value) return "Not synced";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "Not synced";
  const ageMinutesValue = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (ageMinutesValue < 1) return "now";
  if (ageMinutesValue < 60) return `${ageMinutesValue}m ago`;
  return `${Math.floor(ageMinutesValue / 60)}h ${ageMinutesValue % 60}m ago`;
}

function formatHealthDetailValue(value: number | null | undefined, unit = "") {
  if (value == null || !Number.isFinite(value)) return "No value";
  const rounded = Math.abs(value - Math.round(value)) < 0.001 ? String(Math.round(value)) : String(Number(value.toFixed(2)));
  return unit ? `${rounded}${unit}` : rounded;
}

function healthEventText(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function healthFirstEventText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = healthEventText(record[key]);
    if (value) return value;
  }
  return null;
}

function healthFirstText(record: Record<string, unknown>, keys: string[]) {
  return healthFirstEventText(record, keys) ?? "Not synced";
}

function HealthSelectedDetailDrawer({
  detail,
  onClose,
}: {
  detail: HealthSelectedDetail | null;
  onClose: () => void;
}) {
  if (!detail) return null;

  return (
    <>
      <button
        type="button"
        className="health-detail-scrim"
        aria-label="Close selected detail"
        onClick={onClose}
      />
      <aside className="health-selected-detail" aria-label="Selected detail">
        <header>
          <div>
            <p>Selected Detail</p>
            <h2>{detail.title}</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <div className="health-selected-detail-rows">
          {detail.rows.map((row) => (
            <div className="health-selected-detail-row" key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

function HealthMiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="health-mini-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HealthPanel({
  title,
  detail,
  badge,
  badgeTone = "ok",
  children,
}: {
  title: string;
  detail: string;
  badge?: string;
  badgeTone?: "ok" | "warning" | "bad" | "unknown";
  children: ReactNode;
}) {
  return (
    <section className="health-evidence-panel">
      <div className="health-evidence-head">
        <div>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
        {badge ? <span className={`portal-status-pill is-${badgeTone}`}>{badge}</span> : null}
      </div>
      {children}
    </section>
  );
}

function HealthTrendChart({
  series,
  yMin = 0,
  yMax,
  yTitle,
  unit = "",
  onSelectDetail,
}: {
  series: HealthChartSeries[];
  yMin?: number;
  yMax?: number;
  yTitle: string;
  unit?: string;
  onSelectDetail?: (detail: HealthSelectedDetail) => void;
}) {
  const [windowOffset, setWindowOffset] = useState(0);
  const width = 760;
  const height = 210;
  const padLeft = 56;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 36;
  const allTimes = series.flatMap((item) => item.points.map((point) => point.t));
  const windowInfo = useMemo(
    () => healthChartWindow(allTimes, windowOffset),
    [allTimes, windowOffset],
  );
  const visibleSeries = useMemo(
    () => series.map((item) => ({
      ...item,
      points: item.points.filter((point) => point.t >= windowInfo.startMs && point.t <= windowInfo.endMs),
    })),
    [series, windowInfo.endMs, windowInfo.startMs],
  );
  const allPoints = visibleSeries.flatMap((item) => item.points).filter((point) => point.value != null);
  const values = allPoints.map((point) => point.value as number);
  const minTime = windowInfo.startMs;
  const maxTime = windowInfo.endMs;
  const computedMax = Math.max(yMax ?? Math.max(yMin + 1, ...values, 1), yMin + 1);
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const xFor = (time: number) => padLeft + ((time - minTime) / Math.max(maxTime - minTime, 1)) * plotWidth;
  const yFor = (value: number) => height - padBottom - ((value - yMin) / Math.max(computedMax - yMin, 1)) * plotHeight;
  const linePath = (points: HealthChartPoint[]) => points
    .filter((point) => point.value != null)
    .map((point) => `${Math.max(padLeft, Math.min(width - padRight, xFor(point.t))).toFixed(1)},${Math.max(padTop, Math.min(height - padBottom, yFor(point.value as number))).toFixed(1)}`)
    .join(" ");
  const midValue = yMin + (computedMax - yMin) / 2;
  const axisValue = (value: number) => unit ? `${Math.round(value)}${unit}` : Number.isInteger(value) ? String(value) : value.toFixed(1);

  useEffect(() => {
    if (windowOffset > windowInfo.maxOffset) {
      setWindowOffset(windowInfo.maxOffset);
    }
  }, [windowInfo.maxOffset, windowOffset]);

  return (
    <div className="portal-health-chart">
      <HealthChartControls
        windowOffset={windowOffset}
        maxOffset={windowInfo.maxOffset}
        onChange={setWindowOffset}
      />
      <div className="health-chart-legend">
        {series.map((item) => (
          <span key={item.label}><i className={item.tone} />{item.label}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={yTitle}>
        <line x1={padLeft} y1={padTop} x2={width - padRight} y2={padTop} className="health-chart-grid" />
        <line x1={padLeft} y1={padTop + plotHeight / 2} x2={width - padRight} y2={padTop + plotHeight / 2} className="health-chart-grid" />
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} className="health-chart-axis" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="health-chart-axis" />
        <text x={padLeft - 9} y={padTop + 4} textAnchor="end" className="health-chart-axis-text">{axisValue(computedMax)}</text>
        <text x={padLeft - 9} y={padTop + plotHeight / 2 + 4} textAnchor="end" className="health-chart-axis-text">{axisValue(midValue)}</text>
        <text x={padLeft - 9} y={height - padBottom + 4} textAnchor="end" className="health-chart-axis-text">{axisValue(yMin)}</text>
        <text x={padLeft} y={16} className="health-chart-axis-title">{yTitle}</text>
        {visibleSeries.map((item) => (
          <polyline key={item.label} points={linePath(item.points)} className={`health-chart-line is-${item.tone}`} />
        ))}
        {visibleSeries.flatMap((item) => item.points
          .filter((point, index, points) => point.value != null && (index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 48)) === 0))
          .map((point) => {
            const openDetail = () => {
              onSelectDetail?.({
                title: item.label,
                rows: [
                  { label: "Value", value: formatHealthDetailValue(point.value, unit) },
                  { label: "Sample time", value: formatSettingsTimestamp(point.iso) },
                  { label: "Series", value: item.label },
                ],
              });
            };
            return (
              <circle
                key={`${item.label}-${point.iso}`}
                cx={Math.max(padLeft, Math.min(width - padRight, xFor(point.t)))}
                cy={Math.max(padTop, Math.min(height - padBottom, yFor(point.value as number)))}
                r={3}
                className={`health-chart-dot is-${item.tone}`}
                role="button"
                tabIndex={0}
                onClick={openDetail}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openDetail();
                  }
                }}
              >
                <title>{`${item.label}: ${point.value} at ${formatSettingsTimestamp(point.iso)}`}</title>
              </circle>
            );
          }))}
        <text x={padLeft} y={height - 12} className="health-chart-axis-text">{formatSettingsTimestamp(new Date(minTime).toISOString())}</text>
        <text x={(padLeft + width - padRight) / 2} y={height - 12} textAnchor="middle" className="health-chart-axis-text">{formatSettingsTimestamp(new Date((minTime + maxTime) / 2).toISOString())}</text>
        <text x={width - padRight} y={height - 12} textAnchor="end" className="health-chart-axis-text">{formatSettingsTimestamp(new Date(maxTime).toISOString())}</text>
        {!values.length ? <text x={width / 2} y={height / 2} textAnchor="middle" className="health-chart-empty">No samples yet</text> : null}
      </svg>
    </div>
  );
}

function HealthWateringChart({
  events,
  pairings,
  onSelectDetail,
}: {
  events: HealthWateringEvent[];
  pairings: PairingRow[];
  onSelectDetail?: (detail: HealthSelectedDetail) => void;
}) {
  const [windowOffset, setWindowOffset] = useState(0);
  // A wider viewBox prevents the row chart from ballooning vertically on wide
  // desktop canvases while leaving the VWC chart geometry entirely untouched.
  const width = 1040;
  const pairingIndex = useMemo(() => buildWateringPairingIndex(pairings), [pairings]);
  const rowLabels = useMemo(() => {
    return pairings.map((pairing) => ({
      key: pairingLabel(pairing),
      label: wateringAxisLabel(pairing),
    }));
  }, [pairings]);
  const height = Math.max(240, Math.min(520, 76 + Math.max(rowLabels.length, 1) * 19));
  const padLeft = 84;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 36;
  const times = events.map((event) => healthTimestampMs(event.t)).filter((value): value is number => value != null);
  const windowInfo = useMemo(
    () => healthChartWindow(times, windowOffset),
    [times, windowOffset],
  );
  const minTime = windowInfo.startMs;
  const maxTime = windowInfo.endMs;
  const labels = rowLabels.length ? rowLabels : [{ key: "Valve", label: "Valve" }];
  const labelIndex = new Map(labels.map((row, index) => [row.key, index]));
  const visibleEvents = events.filter((event) => {
    const time = healthTimestampMs(event.t);
    const label = wateringEventLabel(event);
    return time != null && labelIndex.has(label) && time >= windowInfo.startMs && time <= windowInfo.endMs;
  });
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const xFor = (time: number) => padLeft + ((time - minTime) / Math.max(maxTime - minTime, 1)) * plotWidth;
  const yFor = (label: string) => labels.length === 1
    ? padTop + plotHeight / 2
    : padTop + ((labelIndex.get(label) ?? 0) / Math.max(labels.length - 1, 1)) * plotHeight;
  const tickRows = labels.length <= 24
    ? labels
    : Array.from(new Set([labels[0], labels[Math.floor(labels.length / 2)], labels[labels.length - 1]].filter(Boolean)));

  useEffect(() => {
    if (windowOffset > windowInfo.maxOffset) {
      setWindowOffset(windowInfo.maxOffset);
    }
  }, [windowInfo.maxOffset, windowOffset]);

  return (
    <div className="portal-health-chart">
      <HealthChartControls
        windowOffset={windowOffset}
        maxOffset={windowInfo.maxOffset}
        onChange={setWindowOffset}
      />
      <div className="health-chart-legend">
        <span><i className="primary" />Valve fire</span>
        <span><i className="control" />Control</span>
        <span><i className="drought" />Drought</span>
        <span><i className="secondary" />{visibleEvents.length} shown</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Watering events by sensor or pot">
        {tickRows.map((row) => (
          <g key={row.key}>
            <line x1={padLeft} y1={yFor(row.key)} x2={width - padRight} y2={yFor(row.key)} className="health-chart-grid" />
            <text x={padLeft - 8} y={yFor(row.key) + 4} textAnchor="end" className="health-chart-axis-text">{row.label}</text>
          </g>
        ))}
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} className="health-chart-axis" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="health-chart-axis" />
        <text x={padLeft} y={16} className="health-chart-axis-title">Watering events</text>
        {visibleEvents.map((event) => {
          const time = healthTimestampMs(event.t) ?? minTime;
          const label = wateringEventLabel(event);
          const duration = healthNumber(event.valveOpenTimeMs);
          const eventRecord = event as Record<string, unknown>;
          const durationText = duration == null ? "--" : `${Math.round(duration / 1000)} sec`;
          const pairingName = event.pairingName ?? healthString(event.pairing) ?? label;
          const pairing = resolveWateringEventPairing(event, pairingIndex);
          const treatment = pairing ? treatmentForPairing(pairing) : "unknown";
          const plantGroup = pairing ? plantGroupForPairing(pairing) : "unknown";
          const openDetail = () => {
            onSelectDetail?.({
              title: label,
              rows: [
                { label: "Event", value: "Valve opened" },
                { label: "Time", value: formatSettingsTimestamp(event.t) },
                { label: "Age", value: healthAgeText(event.t) },
                { label: "Pot", value: label },
                { label: "Plant", value: plantGroupLabel(plantGroup) },
                { label: "Treatment", value: treatmentLabel(treatment) },
                { label: "Pairing", value: pairingName },
                { label: "Sensor", value: event.sensor ?? healthFirstText(eventRecord, ["sensor", "sensorKey", "sensor_key", "sensorId", "sensor_id"]) },
                { label: "Valve", value: event.valve ?? healthFirstText(eventRecord, ["valve", "valveKey", "valve_key", "valveId", "valve_id"]) },
                { label: "Duration", value: durationText },
              ],
            });
          };
          return (
            <circle
              key={`${event.id ?? event.t}-${label}-${event.t}`}
              cx={xFor(time)}
              cy={yFor(label)}
              r={4.4}
              className={`watering-event-dot is-${treatment}`}
              role="button"
              tabIndex={0}
              onClick={openDetail}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                  keyboardEvent.preventDefault();
                  openDetail();
                }
              }}
            >
              <title>{`${label} opened ${formatSettingsTimestamp(event.t)}${duration == null ? "" : ` for ${Math.round(duration / 1000)} sec`}`}</title>
            </circle>
          );
        })}
        {!visibleEvents.length ? <text x={width / 2} y={height / 2} textAnchor="middle" className="health-chart-empty">No valve fires in this window</text> : null}
        <text x={padLeft} y={height - 12} className="health-chart-axis-text">{formatSettingsTimestamp(new Date(minTime).toISOString())}</text>
        <text x={(padLeft + width - padRight) / 2} y={height - 12} textAnchor="middle" className="health-chart-axis-text">{formatSettingsTimestamp(new Date((minTime + maxTime) / 2).toISOString())}</text>
        <text x={width - padRight} y={height - 12} textAnchor="end" className="health-chart-axis-text">{formatSettingsTimestamp(new Date(maxTime).toISOString())}</text>
      </svg>
    </div>
  );
}

function wateringEventMatchesPairings(event: HealthWateringEvent, pairings: PairingRow[]) {
  const visibleLabels = new Set(pairings.map(pairingLabel));
  return visibleLabels.has(wateringEventLabel(event));
}

function ResearchWateringActivity({
  events,
  pairings,
  onSelectDetail,
}: {
  events: HealthWateringEvent[];
  pairings: PairingRow[];
  onSelectDetail: (detail: HealthSelectedDetail) => void;
}) {
  const visibleEvents = useMemo(
    () => events.filter((event) => wateringEventMatchesPairings(event, pairings)),
    [events, pairings],
  );
  const visibleEvents24h = wateringEventsLastDay(visibleEvents);
  const latestWatering = visibleEvents[visibleEvents.length - 1] ?? null;
  const latestWateringTime = latestWatering ? formatSettingsTimestamp(latestWatering.t) : "none";
  const shownWateringEvents = recentWateringEvents(visibleEvents, 8);

  return (
    <section className="research-watering-activity" aria-label="Watering activity">
      <div className="health-mini-grid research-watering-summary">
        <HealthMiniFact label="24h fires" value={formatHealthInteger(visibleEvents24h.length)} />
        <HealthMiniFact label="Latest fire" value={latestWateringTime} />
        <HealthMiniFact label="Visible pots" value={String(pairings.length)} />
        <HealthMiniFact label="Event rows" value={String(visibleEvents.length)} />
      </div>
      <HealthWateringChart
        events={visibleEvents}
        pairings={pairings}
        onSelectDetail={onSelectDetail}
      />
      {shownWateringEvents.length ? (
        <div className="health-event-list research-watering-list">
          {shownWateringEvents.slice().reverse().slice(0, 8).map((event) => {
            const duration = healthNumber(event.valveOpenTimeMs);
            return (
              <div
                className="health-event-row"
                key={`${event.id ?? event.t}-${event.pairing ?? wateringEventLabel(event)}-${event.t}`}
              >
                <strong>{wateringEventLabel(event)}</strong>
                <span>{formatSettingsTimestamp(event.t)}</span>
                <em>{duration == null ? "--" : `${Math.round(duration / 1000)} sec`}</em>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function SystemHealthView({
  snapshot,
  history,
  runtimeState,
  error,
  onBackHome,
}: {
  snapshot: DeviceHealthSnapshot | null;
  history: DeviceHealthSnapshot[];
  runtimeState: DeviceRuntimeState | null;
  error: string | null;
  onBackHome: () => void;
}) {
  const [selectedDetail, setSelectedDetail] = useState<HealthSelectedDetail | null>(null);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const rawRecords = healthHistoryRecords(snapshot, history);
  const synchronizedUptime = currentUptimeSeconds(snapshot, runtimeState, rawRecords);
  const runtimeFresh = runtimeStateIsFresh(runtimeState);
  const uptimeObservedAt = runtimeFresh
    ? runtimeState?.state_observed_at
    : snapshot?.captured_at;
  const currentUptime = runtimeFresh
    ? advanceCurrentBootUptime(synchronizedUptime, uptimeObservedAt, clockNowMs)
    : synchronizedUptime;
  const reconstructedRecords = reconstructCurrentBootUptime(
    rawRecords,
    synchronizedUptime,
    uptimeObservedAt,
  );
  const records = mergeHealthObservation(
    reconstructedRecords,
    currentHealthObservation(snapshot, runtimeState, synchronizedUptime),
  );
  const evidenceRecords = healthRecentRecords(records, 8);
  const restarts = restartEvents(evidenceRecords);
  const allRestarts = restartEvents(records);
  const gaps = monitoringGaps(evidenceRecords, healthNumber(snapshot?.raw_history?.sampleIntervalSeconds) ?? 300);
  const lastRestart = restarts[restarts.length - 1] ?? null;
  const lastGap = gaps[gaps.length - 1] ?? null;
  const currentBootStartMs = healthTimestampMs(lastRestart?.t);
  let uptimeChartRecords = currentBootStartMs == null
    ? records
    : records.filter((record) => (healthTimestampMs(record.t) ?? 0) >= currentBootStartMs);
  if (lastRestart) {
    uptimeChartRecords = mergeHealthObservation(uptimeChartRecords, {
      t: lastRestart.t,
      uptimeSeconds: 0,
    });
  }
  if (runtimeFresh && currentUptime != null) {
    uptimeChartRecords = mergeHealthObservation(uptimeChartRecords, {
      t: new Date(clockNowMs).toISOString(),
      uptimeSeconds: currentUptime,
    });
  }
  const latestRecord = records[records.length - 1] ?? null;
  const undervoltageCurrent = healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_current")) ?? snapshot?.undervoltage ?? null;
  const undervoltageOccurred = healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_occurred"));
  const throttleFlags = healthString(healthOwnerValue(snapshot, runtimeState, "throttled_flags"));
  const currentCpuTemp = healthNumber(healthOwnerValue(snapshot, runtimeState, "cpu_temp_c")) ?? snapshot?.cpu_temp_c ?? null;
  const ethernetLink = healthBoolean(healthOwnerValue(snapshot, runtimeState, "ethernet_link")) ?? snapshot?.ethernet_link ?? null;
  const ethernetIp = healthString(healthOwnerValue(snapshot, runtimeState, "ethernet_ip")) ?? snapshot?.ethernet_ip ?? null;
  const gatewayPingMs = healthNumber(healthOwnerValue(snapshot, runtimeState, "gateway_ping_ms")) ?? snapshot?.gateway_ping_ms ?? null;
  const currentSensors = (runtimeFresh ? runtimeState?.sensors_current : null) ?? snapshot?.sensors_current ?? healthNumber(latestRecord?.sensorRows);
  const expectedSensors = (runtimeFresh ? runtimeState?.sensors_expected : null) ?? snapshot?.sensors_expected ?? null;
  const staleMissing = sumKnownCounts(
    (runtimeFresh ? runtimeState?.sensors_stale : null) ?? snapshot?.sensors_stale,
    (runtimeFresh ? runtimeState?.sensors_missing : null) ?? snapshot?.sensors_missing,
  );
  const lastSensorReadingAt = (runtimeFresh ? runtimeState?.last_sensor_reading_at : null) ?? snapshot?.last_sensor_reading_at ?? null;
  const restartEvidenceKnown = records.length >= 2 && currentUptime != null;
  const reportingHealthy = runtimeFresh && runtimeState?.pi_online === true && runtimeState.api_status?.toUpperCase() === "OK";
  const restartOutageStatus = restartOutagePresentation(
    restartEvidenceKnown,
    restarts.length,
    gaps.length,
    reportingHealthy,
  );
  const sensorEvidenceKnown = currentSensors != null && expectedSensors != null && staleMissing != null;

  return (
    <section className="system-health-main" aria-label="System health">
      <HealthSelectedDetailDrawer
        detail={selectedDetail}
        onClose={() => setSelectedDetail(null)}
      />
      <button type="button" className="support-back-button" onClick={onBackHome}>
        <ArrowLeft size={15} />
        Home
      </button>

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <HealthPanel
        title="Restart / Outage Evidence"
        detail={restartOutageStatus.detail}
        badge={restartOutageStatus.badge}
        badgeTone={restartOutageStatus.badgeTone}
      >
        <div className="health-mini-grid is-five">
          <HealthMiniFact label="Now" value={currentUptime == null ? "Not synced" : `up; ${healthDurationText(currentUptime)}`} />
          <HealthMiniFact label="Latest restart" value={!restartEvidenceKnown ? "Not synced" : lastRestart ? formatSettingsTimestamp(lastRestart.t) : "none detected"} />
          <HealthMiniFact label="Telemetry stopped" value={!restartEvidenceKnown ? "Not synced" : lastGap ? formatSettingsTimestamp(lastGap.start) : "none detected"} />
          <HealthMiniFact label="Service restored" value={!restartEvidenceKnown ? "Not synced" : lastGap ? formatSettingsTimestamp(lastGap.end) : "none detected"} />
          <HealthMiniFact label="Outage duration" value={!restartEvidenceKnown ? "Not synced" : lastGap ? healthCompactDuration(lastGap.durationMs) : "none detected"} />
        </div>
        <HealthTrendChart
          yTitle="Uptime minutes"
          onSelectDetail={setSelectedDetail}
          series={[
            {
              label: "Current boot uptime",
              tone: "primary",
              points: uptimeChartRecords.map((record) => {
                const point = healthChartPoint(record, "uptimeSeconds");
                return { ...point, value: point.value == null ? null : point.value / 60 };
              }),
            },
            {
              label: "Restart detected",
              tone: "danger",
              points: restarts.map((restart) => ({
                t: healthTimestampMs(restart.t) ?? Date.now(),
                iso: restart.t,
                value: 0,
              })),
            },
            {
              label: "Observed telemetry gap",
              tone: "warning",
              points: gaps.flatMap((gap) => [
                { t: healthTimestampMs(gap.start) ?? Date.now(), iso: gap.start, value: 0 },
                { t: healthTimestampMs(gap.end) ?? Date.now(), iso: gap.end, value: 0 },
              ]),
            },
          ]}
        />
      </HealthPanel>

      <div className="health-evidence-grid">
        <HealthPanel
          title="Power Evidence"
          detail={`${formatHealthNumber(currentCpuTemp, 1, " C")} now; undervoltage ${formatHealthBoolean(undervoltageCurrent, "on", "off")}.`}
          badge={formatHealthNumber(currentCpuTemp, 1, " C")}
          badgeTone={undervoltageCurrent == null ? "unknown" : undervoltageCurrent ? "warning" : "ok"}
        >
          <div className="health-mini-grid">
            <HealthMiniFact label="CPU temp" value={formatHealthNumber(currentCpuTemp, 1, " C")} />
            <HealthMiniFact label="Current undervoltage" value={formatHealthBoolean(undervoltageCurrent)} />
            <HealthMiniFact label="Since boot" value={formatHealthBoolean(undervoltageOccurred)} />
            <HealthMiniFact label="Throttle flags" value={throttleFlags ?? "Not synced"} />
          </div>
          <HealthTrendChart
            yTitle="Temperature C / flag marker"
            yMax={85}
            unit="C"
            onSelectDetail={setSelectedDetail}
            series={[
              { label: "CPU temp", tone: "primary", points: records.map((record) => healthChartPoint(record, "cpuTempC")) },
              {
                label: "Current undervoltage marker",
                tone: "danger",
                points: records.map((record) => {
                  const point = healthChartPoint(record, "undervoltage");
                  return { ...point, value: booleanMarker(record.undervoltage, 85, 0) };
                }),
              },
              {
                label: "Since boot marker",
                tone: "warning",
                points: records.map((record) => {
                  const point = healthChartPoint(record, "undervoltageOccurred");
                  return { ...point, value: booleanMarker(record.undervoltageOccurred, 85, 0) };
                }),
              },
              {
                label: "Restart evidence",
                tone: "secondary",
                points: allRestarts.map((restart) => ({
                  t: healthTimestampMs(restart.t) ?? Date.now(),
                  iso: restart.t,
                  value: 0,
                })),
              },
            ]}
          />
        </HealthPanel>

        <HealthPanel
          title="Ethernet Link"
          detail={ethernetLink == null
            ? "Ethernet state has not been synchronized."
            : `${ethernetIp ?? "No IP reported"}; gateway ${formatHealthNumber(gatewayPingMs, 3, " ms")}.`}
          badge={formatHealthBoolean(ethernetLink, "Link up", "Link down")}
          badgeTone={ethernetLink == null ? "unknown" : ethernetLink ? "ok" : "bad"}
        >
          <div className="health-mini-grid">
            <HealthMiniFact label="Ethernet link" value={formatHealthBoolean(ethernetLink, "up", "down")} />
            <HealthMiniFact label="Speed" value="Not synced" />
            <HealthMiniFact label="Gateway ping" value={formatHealthNumber(gatewayPingMs, 3, " ms")} />
          </div>
          <HealthTrendChart
            yTitle="Ethernet link"
            yMax={1}
            onSelectDetail={setSelectedDetail}
            series={[
              {
                label: "Ethernet link",
                tone: "primary",
                points: records.map((record) => {
                  const point = healthChartPoint(record, "ethUp");
                  return { ...point, value: booleanMarker(record.ethUp) };
                }),
              },
            ]}
          />
        </HealthPanel>
      </div>

      <HealthPanel
        title="Sensor Freshness"
        detail={`${formatHealthInteger(currentSensors)} / ${formatHealthInteger(expectedSensors)} current; latest read ${healthDateWithAge(lastSensorReadingAt)}.`}
        badge={!sensorEvidenceKnown
          ? "Not synced"
          : `${formatHealthInteger(currentSensors)}/${formatHealthInteger(expectedSensors)} ${staleMissing > 0 ? "Review" : "OK"}`}
        badgeTone={!sensorEvidenceKnown ? "unknown" : staleMissing > 0 ? "warning" : "ok"}
      >
        <div className="health-mini-grid">
          <HealthMiniFact label="Last Matt read" value={healthDateWithAge(lastSensorReadingAt)} />
          <HealthMiniFact label="Current" value={`${formatHealthInteger(currentSensors)}/${formatHealthInteger(expectedSensors)}`} />
          <HealthMiniFact label="Stale/missing" value={formatHealthInteger(staleMissing)} />
          <HealthMiniFact label="Node2" value="Not synced" />
          <HealthMiniFact label="Node4" value="Not synced" />
        </div>
        <HealthTrendChart
          yTitle="Sensor count"
          yMax={Math.max(20, expectedSensors ?? 20)}
          onSelectDetail={setSelectedDetail}
          series={[
            { label: "Not updating or missing", tone: "warning", points: records.map((record) => healthChartPoint(record, "staleOrMissingSensors")) },
            { label: "Total mapped sensors", tone: "secondary", points: records.map((record) => healthChartPoint(record, "sensorRows")) },
          ]}
        />
      </HealthPanel>
    </section>
  );
}

function SoftwareTermsModal({
  open,
  accepted,
  onAgree,
  onClose,
}: {
  open: boolean;
  accepted: boolean;
  onAgree: () => void;
  onClose: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canAgree, setCanAgree] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCanAgree(accepted);
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (scroller.scrollHeight <= scroller.clientHeight + 12) {
        setCanAgree(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accepted, open]);

  if (!open) return null;

  function handleScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining <= 16) {
      setCanAgree(true);
    }
  }

  return (
    <div className="portal-terms-backdrop" role="presentation">
      <section
        className="portal-terms-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portalTermsTitle"
        aria-describedby="portalTermsNote"
      >
        <header className="portal-terms-header">
          <div>
            <span>Exact H2O LLC</span>
            <h3 id="portalTermsTitle">Software Access Terms</h3>
            <p id="portalTermsNote">Version {softwareTermsVersion}.</p>
          </div>
          <button type="button" className="portal-terms-close" aria-label="Close terms" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="portal-terms-scroll" ref={scrollerRef} onScroll={handleScroll} tabIndex={0}>
          {softwareTermsIntro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {softwareTermsSections.map((section) => (
            <section key={section.title} className="portal-terms-section">
              <h4>{section.title}</h4>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.items?.length ? (
                <ul>
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
          <section className="portal-terms-section">
            <h4>Contact</h4>
            {softwareTermsCompany.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
        </div>

        <footer className="portal-terms-actions">
          <p>{canAgree ? "Ready for acceptance." : "Scroll through the terms to enable agreement."}</p>
          <div>
            <button type="button" className="portal-terms-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="portal-terms-primary"
              disabled={!canAgree}
              onClick={() => {
                onAgree();
                onClose();
              }}
            >
              I agree
            </button>
          </div>
        </footer>
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
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [csvDownload, setCsvDownload] = useState<CsvDownload | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [selectedMode] = useState<DataMode>("auto");
  const [experimentGraphMode, setExperimentGraphMode] = useState<ExperimentGraphMode>("vwc");
  const [potPreset, setPotPreset] = useState<PotPreset>("all");
  const [hiddenPots, setHiddenPots] = useState<Set<string>>(() => new Set());
  const [selectedSeriesName, setSelectedSeriesName] = useState<string | null>(null);
  const [selectedWateringDetail, setSelectedWateringDetail] = useState<HealthSelectedDetail | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(fullTimeWindow);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize>(defaultExpandedPanelSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview");
  const [controlBusy, setControlBusy] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [data, setData] = useState<LoadState>(initialLoadState);
  const [portalAccess, setPortalAccess] = useState<PortalAccess>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [portalView, setPortalView] = useState<PortalView>("home");
  const [selectedExperimentId, setSelectedExperimentId] = useState<ExperimentId>("matt-experiment");
  const [healthSnapshot, setHealthSnapshot] = useState<DeviceHealthSnapshot | null>(null);
  const [healthHistory, setHealthHistory] = useState<DeviceHealthSnapshot[]>([]);
  const [runtimeState, setRuntimeState] = useState<DeviceRuntimeState | null>(null);
  const [configState, setConfigState] = useState<DeviceConfigState | null>(null);
  const [valveEvents, setValveEvents] = useState<ValveEvent[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [salesSupportData, setSalesSupportData] = useState<SalesSupportData>(initialSalesSupportData);
  const [salesSupportLoading, setSalesSupportLoading] = useState(false);
  const [salesSupportError, setSalesSupportError] = useState<string | null>(null);
  const [rdAccessStatus, setRdAccessStatus] = useState<RdAccessStatus>("unknown");
  const [rdSnapshot, setRdSnapshot] = useState<RdLabSnapshot | null>(null);
  const [rdLoading, setRdLoading] = useState(false);
  const [rdError, setRdError] = useState<string | null>(null);
  const [rdHistoryLoading, setRdHistoryLoading] = useState(false);
  const [rdHistoryError, setRdHistoryError] = useState<string | null>(null);

  const dataRef = useRef(data);
  const valveEventsRef = useRef(valveEvents);
  const loadTokenRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const pendingRefreshRef = useRef<RefreshOptions | null>(null);
  const realtimeRefreshInFlightRef = useRef(false);
  const authRecoveryInFlightRef = useRef<Promise<boolean> | null>(null);
  const watchdogRefreshCountRef = useRef(0);
  const controlRequestIdsRef = useRef(new Map<string, { id: string; createdAt: number }>());
  const dashboardMainRef = useRef<HTMLElement | null>(null);
  const controlPanelRef = useRef<HTMLElement | null>(null);
  const panelDragOffsetRef = useRef<PanelPosition | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    valveEventsRef.current = valveEvents;
  }, [valveEvents]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  const selectedExperiment = useMemo(
    () => portalExperimentById(selectedExperimentId),
    [selectedExperimentId],
  );
  const sortedPairings = useMemo(
    () => orderedPairings(
      visibleExperimentPairings(data.pairings)
        .filter((pairing) => pairingBelongsToExperiment(pairing, selectedExperiment)),
    ),
    [data.pairings, selectedExperiment],
  );
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
  const selectedVwcTimeBounds = useMemo(
    () => overlayTimeBounds(timeBounds, timeWindow),
    [timeBounds, timeWindow],
  );
  const visibleNames = useMemo(
    () => new Set(series.filter((item) => !hiddenPots.has(item.name)).map((item) => item.name)),
    [series, hiddenPots],
  );
  const overlayVisibleNames = useMemo(
    () => new Set(series
      .filter((item) => item.kind === "pot" && !hiddenPots.has(item.name))
      .map((item) => item.name)),
    [series, hiddenPots],
  );
  const visibleWateringPairings = useMemo(
    () => sortedPairings.filter((pairing) => !hiddenPots.has(pairing.name)),
    [hiddenPots, sortedPairings],
  );
  const experimentWateringEvents = useMemo(
    () => resolveHealthWateringEvents(valveEventsToHealthWateringEvents(valveEvents, sortedPairings), sortedPairings),
    [sortedPairings, valveEvents],
  );

  const visiblePotCount = series.filter(
    (item) => visibleNames.has(item.name) && item.rawPointCount > 0,
  ).length;
  const isAdmin = portalAccess?.role === "admin";
  const canReadProjectData = hasProjectDataReadAccess(portalAccess?.role);
  const canUseExperimentSettings = hasExperimentSettingsAccess(portalAccess?.role) &&
    !isObservationOnlyExperiment(selectedExperiment);

  const resetPortalSessionUi = useCallback((nextView: PortalView = "home") => {
    setSettingsOpen(false);
    setSettingsSection("overview");
    setControlBusy(false);
    setControlNotice(null);
    setControlError(null);
    setCsvDownload(null);
    setCsvError(null);
    setTermsOpen(false);
    setTermsAccepted(false);
    setExperimentGraphMode("vwc");
    setSelectedWateringDetail(null);
    setPortalView(nextView);
  }, []);

  const openExperiment = useCallback((experimentId: ExperimentId) => {
    setSelectedExperimentId(experimentId);
    setExperimentGraphMode("vwc");
    setPotPreset("all");
    setHiddenPots(new Set());
    setSelectedSeriesName(null);
    setSelectedWateringDetail(null);
    setTimeWindow(fullTimeWindow);
    setSettingsOpen(false);
    setPortalView("experiment");
  }, []);

  const expirePortalSession = useCallback(() => {
    setError(null);
    setLoginError(null);
    setAuthNotice(expiredPortalSessionNotice);
    setSessionReady(false);
  }, []);

  const recoverPortalSession = useCallback(async () => {
    if (authRecoveryInFlightRef.current) return authRecoveryInFlightRef.current;

    const recovery = (async () => {
      const { data: sessionData, error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError || !sessionData.session) {
        await supabase.auth.signOut({ scope: "local" });
        expirePortalSession();
        return false;
      }
      setSessionReady(true);
      return true;
    })();

    authRecoveryInFlightRef.current = recovery;
    try {
      return await recovery;
    } finally {
      authRecoveryInFlightRef.current = null;
    }
  }, [expirePortalSession]);

  const loadPortalAccess = useCallback(async () => {
    setAccessLoading(true);
    try {
      const queryAccess = async () => {
        const userResponse = await withSupabaseTimeout(
          supabase.auth.getUser(),
          portalAccessTimeoutMs,
          "Portal session",
        );
        if (userResponse.error) throw userResponse.error;
        const userId = userResponse.data.user?.id ?? null;
        if (!userId) throw { status: 401, message: "Portal session is unavailable" };

        const response = await withSupabaseTimeout(
          supabase
            .from("portal_access")
            .select("role, email")
            .eq("project_id", mattProjectId)
            .eq("user_id", userId)
            .maybeSingle(),
          portalAccessTimeoutMs,
          "Portal access",
        );
        if (response.error) throw response.error;
        return response;
      };

      let response;
      try {
        response = await queryAccess();
      } catch (err) {
        if (!isSessionAuthorizationError(err) || !(await recoverPortalSession())) throw err;
        response = await queryAccess();
      }

      const role = parsePortalRole(response.data?.role);
      if (!role) {
        setPortalAccess(null);
        setPortalView("home");
        return;
      }
      const access: Exclude<PortalAccess, null> = {
        role,
        email: response.data?.email ?? null,
      };
      setPortalAccess(access);
      setPortalView("home");
    } catch (err) {
      if (isSessionAuthorizationError(err)) {
        expirePortalSession();
        return;
      }
      setPortalAccess(null);
      setPortalView("home");
    } finally {
      setAccessLoading(false);
    }
  }, [expirePortalSession, recoverPortalSession]);

  const loadHealthSnapshot = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isAdmin) return;
    const silent = options.silent === true;
    if (!silent) {
      setHealthLoading(true);
      setHealthError(null);
    }

    try {
      const response = await withSupabaseTimeout(
        supabase
          .from("device_health_snapshots")
          .select(healthSnapshotSelectColumns)
          .eq("project_id", mattProjectId)
          .eq("device_id", mattDeviceId)
          .eq("ingest_complete", true)
          .order("captured_at", { ascending: false })
          .limit(300),
        supabaseQueryTimeoutMs,
        "Health snapshot",
      );

      if (response.error) throw response.error;
      const snapshots = (response.data ?? []) as DeviceHealthSnapshot[];
      setHealthHistory(snapshots);
      setHealthSnapshot(selectHealthSnapshot(snapshots));
    } catch (err) {
      if (!silent) setHealthError(errorMessage(err));
    } finally {
      if (!silent) setHealthLoading(false);
    }
  }, [isAdmin]);

  const loadDeviceSyncState = useCallback(async () => {
    if (!canUseExperimentSettings) {
      setRuntimeState(null);
      setConfigState(null);
      return;
    }

    try {
      const [runtimeResponse, configResponse] = await Promise.all([
        withSupabaseTimeout(
          supabase
            .from("device_runtime_state")
            .select("*")
            .eq("project_id", mattProjectId)
            .eq("device_id", mattDeviceId)
            .maybeSingle(),
          supabaseQueryTimeoutMs,
          "Runtime state",
        ),
        withSupabaseTimeout(
          supabase
            .from("device_config_state")
            .select("*")
            .eq("project_id", mattProjectId)
            .eq("device_id", mattDeviceId)
            .maybeSingle(),
          supabaseQueryTimeoutMs,
          "Config state",
        ),
      ]);

      if (!runtimeResponse.error) {
        setRuntimeState((runtimeResponse.data ?? null) as DeviceRuntimeState | null);
      }
      if (!configResponse.error) {
        setConfigState((configResponse.data ?? null) as DeviceConfigState | null);
      }
    } catch {
      // Keep the last mirrored controller state visible while Supabase catches up.
    }
  }, [canUseExperimentSettings]);

  const loadValveEvents = useCallback(async (options: { incremental?: boolean } = {}) => {
    if (!canReadProjectData) {
      setValveEvents([]);
      return;
    }

    try {
      const incremental = options.incremental === true;
      const existing = valveEventsRef.current;
      const newestExistingAt = existing.reduce(
        (latest, event) => Math.max(latest, valveEventTimestampMs(event)),
        0,
      );
      const sinceMs = incremental && newestExistingAt > 0
        ? newestExistingAt - incrementalCursorOverlapMs
        : Date.now() - wateringHistoryMs;
      const response = await withSupabaseTimeout(
        supabase
          .from("valve_events")
          .select("*")
          .eq("project_id", mattProjectId)
          .eq("device_id", mattDeviceId)
          .gte("device_recorded_at", new Date(sinceMs).toISOString())
          .order("device_recorded_at", { ascending: false })
          .limit(incremental ? incrementalValveEventRows : maxValveEventRows),
        supabaseQueryTimeoutMs,
        "Valve events",
      );

      if (response.error) throw response.error;
      setValveEvents((current) => mergeValveEventRows(current, (response.data ?? []) as ValveEvent[]));
    } catch {
      // Keep the last good watering timeline visible until Supabase recovers.
    }
  }, [canReadProjectData]);

  const loadSalesSupport = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isAdmin) {
      setSalesSupportData(initialSalesSupportData);
      return;
    }

    const silent = options.silent === true;
    if (!silent) {
      setSalesSupportLoading(true);
      setSalesSupportError(null);
    }

    try {
      const [quotesResponse, threadsResponse, messagesResponse] = await Promise.all([
        withSupabaseTimeout(
          supabase
            .from("quote_requests")
            .select("id, project_id, created_at, updated_at, name, email, phone, organization, application, timeline, message, source_url, referrer, notification_email, notification_status, notification_error, status, priority")
            .eq("project_id", mattProjectId)
            .order("created_at", { ascending: false })
            .limit(40),
          supabaseQueryTimeoutMs,
          "Quote requests",
        ),
        withSupabaseTimeout(
          supabase
            .from("support_threads")
            .select("id, project_id, created_at, updated_at, last_message_at, source, status, priority, request_type, subject, customer_name, customer_email, customer_phone, customer_organization, quote_request_id, last_message_preview, last_message_from_email, last_message_subject, metadata")
            .eq("project_id", mattProjectId)
            .order("last_message_at", { ascending: false })
            .limit(40),
          supabaseQueryTimeoutMs,
          "Support threads",
        ),
        withSupabaseTimeout(
          supabase
            .from("support_messages")
            .select("id, thread_id, project_id, created_at, direction, channel, from_email, from_name, to_emails, subject, body_text, body_html, metadata")
            .eq("project_id", mattProjectId)
            .order("created_at", { ascending: false })
            .limit(80),
          supabaseQueryTimeoutMs,
          "Support messages",
        ),
      ]);

      if (quotesResponse.error) throw quotesResponse.error;
      if (threadsResponse.error) throw threadsResponse.error;
      if (messagesResponse.error) throw messagesResponse.error;

      setSalesSupportData({
        quotes: (quotesResponse.data ?? []) as QuoteRequestRow[],
        threads: (threadsResponse.data ?? []) as SupportThreadRow[],
        messages: (messagesResponse.data ?? []) as SupportMessageRow[],
      });
    } catch (err) {
      if (!silent) setSalesSupportError(errorMessage(err));
    } finally {
      if (!silent) setSalesSupportLoading(false);
    }
  }, [isAdmin]);

  const loadRdAccess = useCallback(async () => {
    if (!isAdmin) {
      setRdAccessStatus("denied");
      setRdSnapshot(null);
      return;
    }
    setRdAccessStatus("unknown");
    try {
      setRdAccessStatus(await loadRdLabAccess() ? "allowed" : "denied");
    } catch {
      // The R&D allowlist is independent from the normal portal-admin role.
      // Fail closed without coupling access to the much larger lab snapshot.
      setRdAccessStatus("denied");
    }
  }, [isAdmin]);

  const loadRdSnapshot = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isAdmin || rdAccessStatus !== "allowed") return;
    const silent = options.silent === true;
    if (!silent) setRdLoading(true);
    try {
      const snapshot = await loadRdLabSnapshot();
      setRdSnapshot(snapshot);
      setRdError(null);
      setRdHistoryError(null);
    } catch (err) {
      setRdError(errorMessage(err));
    } finally {
      if (!silent) setRdLoading(false);
    }
  }, [isAdmin, rdAccessStatus]);

  const loadMoreRdHistory = useCallback(async () => {
    const cursor = rdSnapshot?.pagination?.next_cursor ?? null;
    if (!cursor || rdHistoryLoading || rdAccessStatus !== "allowed") return;
    setRdHistoryLoading(true);
    setRdHistoryError(null);
    try {
      const page = await loadRdLabSnapshot({ historyCursor: cursor });
      setRdSnapshot((current) => current ? mergeRdHistoryPage(current, page) : page);
    } catch (err) {
      setRdHistoryError(errorMessage(err));
    } finally {
      setRdHistoryLoading(false);
    }
  }, [rdAccessStatus, rdHistoryLoading, rdSnapshot?.pagination?.next_cursor]);

  const runPortalRefresh = useCallback(
    async ({ incremental }: RefreshOptions) => {
      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      setError(null);
      setLoading(!incremental || dataRef.current.readings.length === 0);
      try {
        const loadCoreData = async () => {
          const results = await Promise.all([
            withSupabaseTimeout(
              supabase
                .from("device_config_state")
                .select("*")
                .eq("project_id", mattProjectId)
                .eq("device_id", mattDeviceId)
                .maybeSingle(),
              supabaseQueryTimeoutMs,
              "Controller config",
            ),
            withSupabaseTimeout(
              supabase
                .from("latest_device_state")
                .select("*")
                .eq("device_id", mattDeviceId)
                .limit(1)
                .maybeSingle(),
              supabaseQueryTimeoutMs,
              "Latest device state",
            ),
            selectedMode === "auto"
              ? withSupabaseTimeout(
                supabase
                  .from("sensor_readings")
                  .select("id, server_received_at")
                  .eq("project_id", mattProjectId)
                  .eq("device_id", mattDeviceId)
                  .like("event_id", livePrefix)
                  .gte("server_received_at", new Date(Date.now() - staleAfterMs).toISOString())
                  .limit(1),
                supabaseQueryTimeoutMs,
                "Live reading availability",
              )
              : Promise.resolve({ data: null, error: null }),
          ]);

          for (const result of results) {
            if (result.error) throw result.error;
          }
          return results;
        };

        let coreData;
        try {
          coreData = await loadCoreData();
        } catch (err) {
          if (!isSessionAuthorizationError(err) || !(await recoverPortalSession())) throw err;
          coreData = await loadCoreData();
        }
        const [controllerConfig, latestState, liveAvailability] = coreData;

        const previous = dataRef.current;
        const effectiveMode = resolveEffectiveMode(selectedMode, Boolean(liveAvailability.data?.length));
        const canIncrement = incremental && previous.effectiveMode === effectiveMode;
        const newerThan = canIncrement ? incrementalReadingCursor(previous.readings) : null;
        const nowIso = new Date().toISOString();
        const latestIngestTime =
          latestState.data?.updated_at ??
          previous.latestIngestTime ??
          null;

        if (token !== loadTokenRef.current) return;

        let pairingsData = pairingsFromDeviceConfigState(
          controllerConfig.data?.pairings,
          controllerConfig.data?.groups,
        );
        if (pairingsData.length === 0) {
          const legacyPairings = await withSupabaseTimeout(
            supabase.from("pairings").select("*").limit(1000),
            supabaseQueryTimeoutMs,
            "Legacy pairings",
          );
          if (legacyPairings.error) throw legacyPairings.error;
          pairingsData = (legacyPairings.data ?? []) as PairingRow[];
        }
        pairingsData = visibleExperimentPairings(pairingsData);

        if (controllerConfig.data) {
          setConfigState(controllerConfig.data as DeviceConfigState);
        }

        setData((current) => ({
          ...current,
          pairings: pairingsData,
          latestState: latestState.data ?? null,
          latestIngestTime,
          lastCheckedAt: nowIso,
          effectiveMode,
          readings: canIncrement ? current.readings : [],
          totalImportedReadings: canIncrement ? current.totalImportedReadings : 0,
          totalLiveReadings: canIncrement ? current.totalLiveReadings : 0,
        }));

        const applyReadingsBatch = (incomingReadings: SensorReading[]) => {
          if (token !== loadTokenRef.current || incomingReadings.length === 0) return;
          setData((current) => {
            const readings = mergeReadings(current.readings, incomingReadings);
            const loadedCounts = loadedReadingCounts(readings);
            const latestLiveReading = newestByTime(
              readings.filter((reading) => reading.event_id.startsWith("live-device:")),
            );
            return {
              ...current,
              readings,
              totalImportedReadings: loadedCounts.imported,
              totalLiveReadings: loadedCounts.live,
              latestLiveReading: latestLiveReading ?? current.latestLiveReading,
              lastCheckedAt: nowIso,
              lastNewDataAt: nowIso,
              effectiveMode,
            };
          });
        };

        await fetchReadingsForMode(effectiveMode, newerThan, applyReadingsBatch);
      } catch (err) {
        if (token === loadTokenRef.current) {
          if (isSessionAuthorizationError(err)) {
            expirePortalSession();
            return;
          }
          setError(errorMessage(err));
        }
      } finally {
        if (token === loadTokenRef.current) {
          setLoading(false);
        }
      }
    },
    [expirePortalSession, recoverPortalSession, selectedMode],
  );

  const refreshLatestReadings = useCallback(async () => {
    if (realtimeRefreshInFlightRef.current) return;
    const currentData = dataRef.current;
    const newerThan = incrementalReadingCursor(currentData.readings);
    if (!newerThan) return;

    realtimeRefreshInFlightRef.current = true;
    try {
      const effectiveMode = currentData.effectiveMode;
      const incomingReadings = await fetchReadingsForMode(effectiveMode, newerThan);
      const nowIso = new Date().toISOString();

      setData((current) => {
        if (!incomingReadings.length) {
          return {
            ...current,
            lastCheckedAt: nowIso,
          };
        }

        const readings = mergeReadings(current.readings, incomingReadings);
        const loadedCounts = loadedReadingCounts(readings);
        const latestLiveReading = newestByTime(
          readings.filter((reading) => reading.event_id.startsWith("live-device:")),
        );

        return {
          ...current,
          readings,
          totalImportedReadings: loadedCounts.imported,
          totalLiveReadings: loadedCounts.live,
          latestLiveReading: latestLiveReading ?? current.latestLiveReading,
          latestIngestTime:
            latestLiveReading?.server_received_at ??
            current.latestState?.updated_at ??
            current.latestIngestTime,
          lastCheckedAt: nowIso,
          lastNewDataAt: nowIso,
        };
      });
    } catch {
      // Keep the visible chart stable and retry on the next realtime/poll tick.
    } finally {
      realtimeRefreshInFlightRef.current = false;
    }
  }, []);

  const refresh = useCallback(
    async (options: RefreshOptions) => {
      if (refreshInFlightRef.current) {
        if (options.incremental) {
          void refreshLatestReadings();
          return;
        }
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = {
          incremental: pending ? pending.incremental && options.incremental : options.incremental,
        };
        return;
      }

      refreshInFlightRef.current = true;
      let nextOptions: RefreshOptions | null = options;

      try {
        while (nextOptions) {
          const currentOptions = nextOptions;
          nextOptions = null;
          await runPortalRefresh(currentOptions);
          nextOptions = pendingRefreshRef.current;
          pendingRefreshRef.current = null;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [refreshLatestReadings, runPortalRefresh],
  );

  const queueControlCommand = useCallback<QueueControlCommand>(
    async (commandType, payload, options) => {
      if (!canUseExperimentSettings) {
        setControlError("Experiment settings access is required for portal controls.");
        return;
      }
      if (!isAdmin && adminOnlyControlCommandTypes.has(commandType)) {
        setControlError("Administrator access is required for this controller command.");
        return;
      }

      setControlBusy(true);
      setControlNotice(null);
      setControlError(null);

      const requestKey = JSON.stringify([commandType, payload, options?.confirm === true]);
      const nowMs = Date.now();
      for (const [key, entry] of controlRequestIdsRef.current) {
        if (nowMs - entry.createdAt > 10 * 60 * 1000) controlRequestIdsRef.current.delete(key);
      }
      const existingRequest = controlRequestIdsRef.current.get(requestKey);
      const clientRequestId = existingRequest?.id ?? crypto.randomUUID();
      controlRequestIdsRef.current.set(requestKey, { id: clientRequestId, createdAt: nowMs });

      try {
        const response = await withSupabaseTimeout(
          (signal) => supabase.functions.invoke<ControlCommandResponse>("create-control-command", {
            body: {
              project_id: mattProjectId,
              device_id: dataRef.current.latestState?.device_id ?? mattDeviceId,
              client_request_id: clientRequestId,
              command_type: commandType,
              payload,
              confirm: options?.confirm === true,
            },
            signal,
          }),
          supabaseQueryTimeoutMs,
          "Control command",
        );

        if (response.error) {
          throw new Error(await functionErrorMessage(response.error));
        }

        controlRequestIdsRef.current.delete(requestKey);
        setControlNotice(`${controlCommandLabel(commandType)} sent`);
      } catch (err) {
        try {
          const reconciliation = await withSupabaseTimeout(
            supabase
              .from("project_control_commands")
              .select("id")
              .eq("project_id", mattProjectId)
              .eq("client_request_id", clientRequestId)
              .maybeSingle(),
            supabaseQueryTimeoutMs,
            "Control command reconciliation",
          );
          if (!reconciliation.error && reconciliation.data?.id) {
            controlRequestIdsRef.current.delete(requestKey);
            setControlNotice(`${controlCommandLabel(commandType)} received; status refreshed`);
          } else {
            setControlError(`${errorMessage(err)} Safe to retry; the same request ID will be reused.`);
          }
        } catch {
          setControlError(`${errorMessage(err)} Safe to retry; the same request ID will be reused.`);
        }
      } finally {
        setControlBusy(false);
      }
    },
    [canUseExperimentSettings, isAdmin],
  );

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
    resetPortalSessionUi();
    setPassword("");
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

    if (!termsAccepted) {
      setLoading(false);
      setLoginError("Review and accept the Software Access Terms to continue.");
      return;
    }

    const { data: inviteData, error: inviteError } =
      await supabase.functions.invoke<InviteAcceptResponse>("accept-invite", {
        body: {
          token: inviteToken,
          email,
          password,
          termsAccepted: true,
          termsVersion: softwareTermsVersion,
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
    resetPortalSessionUi();
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
    resetPortalSessionUi();
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
    setPortalAccess(null);
    setAccessLoading(false);
    resetPortalSessionUi();
    setHealthSnapshot(null);
    setHealthHistory([]);
    setRuntimeState(null);
    setConfigState(null);
    setHealthLoading(false);
    setHealthError(null);
    setSalesSupportData(initialSalesSupportData);
    setSalesSupportLoading(false);
    setSalesSupportError(null);
    setRdSnapshot(null);
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
    setCsvError(null);

    try {
      const readings = dedupeReadingsForExport(data.readings);
      if (readings.length === 0) {
        throw new Error("Readings are still loading. Try again after the chart appears.");
      }
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
        filename: `exacth2o-readings-loaded-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: readings.length,
      });
    } catch (err) {
      setCsvError(errorMessage(err));
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

    let active = true;
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || authMode === "set-password" || authMode === "accept-invite") return;
      setSessionReady(Boolean(session));
      if (session && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
        setSessionRevision((current) => current + 1);
      }
    });

    void supabase.auth.getSession().then(({ data: sessionData }) => {
      if (!active || authMode === "set-password" || authMode === "accept-invite") return;
      setSessionReady(Boolean(sessionData.session));
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [authMode]);

  useEffect(() => {
    if (!sessionReady) return undefined;

    const validateVisibleSession = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void supabase.auth.getSession().then(({ data: sessionData, error: sessionError }) => {
        if (sessionError || !sessionData.session) {
          expirePortalSession();
          return;
        }
        const expiresAtMs = (sessionData.session.expires_at ?? 0) * 1000;
        if (expiresAtMs <= Date.now() + 60_000) {
          void recoverPortalSession();
        }
      });
    };

    document.addEventListener("visibilitychange", validateVisibleSession);
    window.addEventListener("online", validateVisibleSession);
    return () => {
      document.removeEventListener("visibilitychange", validateVisibleSession);
      window.removeEventListener("online", validateVisibleSession);
    };
  }, [expirePortalSession, recoverPortalSession, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void refresh({ incremental: false });
  }, [canReadProjectData, refresh, selectedMode, sessionReady, sessionRevision]);

  useEffect(() => {
    if (!sessionReady) {
      setPortalAccess(null);
      setSettingsOpen(false);
      setSettingsSection("overview");
      setPortalView("home");
      setHealthSnapshot(null);
      setHealthHistory([]);
      setRuntimeState(null);
      setConfigState(null);
      setValveEvents([]);
      setSalesSupportData(initialSalesSupportData);
      setRdAccessStatus("unknown");
      setRdSnapshot(null);
      setRdLoading(false);
      setRdError(null);
      setRdHistoryLoading(false);
      setRdHistoryError(null);
      setData(initialLoadState);
      dataRef.current = initialLoadState;
      valveEventsRef.current = [];
      return;
    }
    void loadPortalAccess();
  }, [loadPortalAccess, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return;
    void loadHealthSnapshot();
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void loadValveEvents();
  }, [canReadProjectData, loadValveEvents, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return;
    void loadDeviceSyncState();
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return;
    void loadSalesSupport();
  }, [isAdmin, loadSalesSupport, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return;
    void loadRdAccess();
  }, [isAdmin, loadRdAccess, sessionReady, sessionRevision]);

  useEffect(() => {
    if (
      !sessionReady || !isAdmin || rdAccessStatus !== "allowed" ||
      portalView !== "rd"
    ) return;
    void loadRdSnapshot();
  }, [isAdmin, loadRdSnapshot, portalView, rdAccessStatus, sessionReady]);

  useEffect(() => {
    if (
      !sessionReady || !isAdmin || rdAccessStatus !== "allowed" ||
      portalView !== "rd"
    ) return undefined;
    const pollId = window.setInterval(() => {
      void loadRdSnapshot({ silent: true });
    }, healthSnapshotPollMs);
    return () => window.clearInterval(pollId);
  }, [isAdmin, loadRdSnapshot, portalView, rdAccessStatus, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;
    const pollId = window.setInterval(() => {
      void loadHealthSnapshot({ silent: true });
    }, healthSnapshotPollMs);
    return () => window.clearInterval(pollId);
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;
    const pollId = window.setInterval(() => {
      void loadValveEvents({ incremental: true });
    }, healthSnapshotPollMs);
    return () => window.clearInterval(pollId);
  }, [canReadProjectData, loadValveEvents, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return undefined;
    const pollId = window.setInterval(() => {
      void loadDeviceSyncState();
    }, healthSnapshotPollMs);
    return () => window.clearInterval(pollId);
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;
    const pollId = window.setInterval(() => {
      void loadSalesSupport({ silent: true });
    }, supportPollMs);
    return () => window.clearInterval(pollId);
  }, [isAdmin, loadSalesSupport, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;
    const intervalId = window.setInterval(() => {
      watchdogRefreshCountRef.current += 1;
      const fullReconciliation =
        watchdogRefreshCountRef.current % fullReconciliationEveryPolls === 0;
      void refresh({ incremental: !fullReconciliation });
    }, autoRefreshMs);
    return () => window.clearInterval(intervalId);
  }, [canReadProjectData, refresh, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;

    const shouldApplyReading = (reading: Partial<SensorReading> | null | undefined) => {
      if (!reading || isIgnoredDiagnosticReading(reading)) return false;
      const eventId = reading.event_id;
      if (typeof eventId !== "string") return false;
      if (selectedMode === "combined" || selectedMode === "auto") return true;
      if (selectedMode === "live") return eventId.startsWith("live-device:");
      return eventId.startsWith("balena-export-v2:");
    };

    const channel = supabase
      .channel(`exacth2o-dashboard-live-${selectedMode}-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sensor_readings",
          filter: `project_id=eq.${mattProjectId}`,
        },
        (payload) => {
          const row = payload.new as SensorReading & { device_id?: string };
          if (row.device_id !== mattDeviceId || !shouldApplyReading(row)) return;

          const nowIso = new Date().toISOString();
          const switchingToLive =
            selectedMode === "auto" &&
            row.event_id.startsWith("live-device:") &&
            dataRef.current.effectiveMode !== "live";
          setData((current) => {
            const isLive = row.event_id.startsWith("live-device:");
            if (selectedMode === "auto" && !isLive && current.effectiveMode === "live") return current;
            const effectiveMode = selectedMode === "auto" && isLive ? "live" : current.effectiveMode;
            const readings = mergeReadings(current.readings, [row]);
            const counts = loadedReadingCounts(readings);
            return {
              ...current,
              readings,
              effectiveMode,
              totalImportedReadings: counts.imported,
              totalLiveReadings: counts.live,
              latestLiveReading: isLive ? row : current.latestLiveReading,
              latestIngestTime: row.server_received_at ?? current.latestIngestTime,
              lastCheckedAt: nowIso,
              lastNewDataAt: nowIso,
            };
          });
          if (switchingToLive) void refresh({ incremental: false });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "latest_device_state",
          filter: `device_id=eq.${mattDeviceId}`,
        },
        (payload) => {
          const row = payload.new as LatestState;
          if (row.device_id !== mattDeviceId) return;
          setData((current) => ({
            ...current,
            latestState: row,
            latestIngestTime: row.updated_at ?? current.latestIngestTime,
            lastCheckedAt: new Date().toISOString(),
          }));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [canReadProjectData, refresh, sessionReady, selectedMode]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;

    const channel = supabase
      .channel("exacth2o-health-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_health_snapshots",
          filter: `project_id=eq.${mattProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceHealthSnapshot>;
          if (row.device_id !== mattDeviceId || row.ingest_complete !== true) return;
          setHealthHistory((current) => {
            const next = row as DeviceHealthSnapshot;
            const byId = new Map(current.map((item) => [item.id, item]));
            byId.set(next.id, next);
            return Array.from(byId.values())
              .sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))
              .slice(0, 300);
          });
          setHealthSnapshot((current) => selectHealthSnapshot([
            row as DeviceHealthSnapshot,
            ...(current ? [current] : []),
          ]));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return undefined;

    const channel = supabase
      .channel("exacth2o-device-sync-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_runtime_state",
          filter: `project_id=eq.${mattProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceRuntimeState>;
          if (row.device_id === mattDeviceId) {
            setRuntimeState(row as DeviceRuntimeState);
            return;
          }
          void loadDeviceSyncState();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_config_state",
          filter: `project_id=eq.${mattProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceConfigState>;
          if (row.device_id === mattDeviceId) {
            setConfigState(row as DeviceConfigState);
            return;
          }
          void loadDeviceSyncState();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;

    const channel = supabase
      .channel("exacth2o-valve-events-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "valve_events",
          filter: `project_id=eq.${mattProjectId}`,
        },
        (payload) => {
          const row = payload.new as ValveEvent;
          if (row.device_id !== mattDeviceId || isIgnoredDiagnosticValveEvent(row)) return;
          setValveEvents((current) => mergeValveEventRows(current, [row]));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [canReadProjectData, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;

    const channel = supabase
      .channel("exacth2o-sales-support-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "support_threads",
          filter: `project_id=eq.${mattProjectId}`,
        },
        () => {
          void loadSalesSupport({ silent: true });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "quote_requests",
          filter: `project_id=eq.${mattProjectId}`,
        },
        () => {
          void loadSalesSupport({ silent: true });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isAdmin, loadSalesSupport, sessionReady]);

  if (!sessionReady) {
    const isInviteAccept = authMode === "accept-invite";
    const isPasswordSetup = authMode === "set-password";
    const showTermsAgreement = !isPasswordSetup;
    const termsRequired = isInviteAccept;
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
          <a href="/" className="portal-logo" aria-label="ExactH2O website home">
            <img src={exactH2OLogo} alt="ExactH2O" />
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
              {showTermsAgreement ? (
                <div className="portal-terms-prompt">
                  <label className="portal-check portal-terms-check">
                    <input
                      type="checkbox"
                      name="terms"
                      checked={termsAccepted}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setTermsOpen(true);
                          return;
                        }
                        setTermsAccepted(false);
                      }}
                    />
                    <span>
                      I agree to the{" "}
                      <button
                        type="button"
                        className="portal-inline-action"
                        onClick={() => setTermsOpen(true)}
                      >
                        Software Access Terms
                      </button>
                      .
                    </span>
                  </label>
                  <p>
                    {termsRequired
                      ? "Required before accepting this invite."
                      : "Invite users will review and accept these terms before access."}
                  </p>
                </div>
              ) : null}
              <button
                className="portal-submit-btn"
                type="submit"
                disabled={loading || (!isPasswordSetup && !email) || !password || (termsRequired && !termsAccepted)}
              >
                {authSubmitText}
              </button>
              {authNotice ? <p className="portal-success-line">{authNotice}</p> : null}
              {loginError ? <p className="portal-error-line">{loginError}</p> : null}
            </form>

            <div className="portal-support-line">
              Need access? Ask for an invite or contact{" "}
              <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </div>
          </div>
        </section>
        <SoftwareTermsModal
          open={termsOpen}
          accepted={termsAccepted}
          onAgree={() => setTermsAccepted(true)}
          onClose={() => setTermsOpen(false)}
        />
      </main>
    );
  }

  const groupedPairings = Array.from(
    sortedPairings.reduce((groups, pairing) => {
      const current = groups.get(pairing.zone) ?? [];
      current.push(pairing);
      groups.set(pairing.zone, current);
      return groups;
    }, new Map<number, PairingRow[]>()),
  ).sort(([zoneA], [zoneB]) => zoneA - zoneB);
  const controlPanelStyle: CSSProperties | undefined = graphExpanded
    ? {
        width: panelSize.width,
        height: panelSize.height,
        ...(panelPosition
          ? { left: panelPosition.x, top: panelPosition.y, right: "auto" }
          : {}),
      }
    : undefined;
  const showSettingsControl = canUseExperimentSettings && portalView === "experiment";
  const showHomeActions = Boolean(portalAccess) && portalView === "home";
  const showExperimentHomeControl = Boolean(portalAccess) && portalView === "experiment";

  const portalActions = (
    <div className="header-actions">
      {showHomeActions ? (
        <button className="header-action" type="button" onClick={signOut}>
          Sign out
        </button>
      ) : null}
      {showExperimentHomeControl ? (
        <button className="header-action" type="button" onClick={() => setPortalView("home")}>
          <ArrowLeft size={14} />
          Home
        </button>
      ) : null}
      {showSettingsControl ? (
        <button
          className="header-action"
          type="button"
          aria-label="Portal settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon size={14} />
          Settings
        </button>
      ) : null}
    </div>
  );

  const experimentCornerActions = showExperimentHomeControl || showSettingsControl ? (
    <div className="experiment-corner-actions" aria-label="Experiment actions">
      {portalActions}
    </div>
  ) : null;

  const portalHeader = (
    <header className="dashboard-header">
      <a
        className="dashboard-logo"
        href="/"
        aria-label="ExactH2O website home"
      >
        <img src={exactH2OLogo} alt="ExactH2O" />
      </a>
      <div className="portal-header-right">
        {portalActions}
      </div>
    </header>
  );

  if (accessLoading && !portalAccess) {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <section className="portal-loading-screen">
          <Loader2 className="chart-loading-spinner" size={32} aria-hidden="true" />
        </section>
      </main>
    );
  }

  if (!portalAccess) {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <section className="portal-loading-screen" aria-live="polite">
          <ShieldCheck size={32} aria-hidden="true" />
          <p>This account does not currently have portal access.</p>
          <button className="header-action" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
      </main>
    );
  }

  if (isAdmin && portalView === "home") {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <PortalAdminHome
          data={data}
          healthSnapshot={healthSnapshot}
          healthLoading={healthLoading}
          salesSupportData={salesSupportData}
          salesSupportLoading={salesSupportLoading}
          rdAccessAllowed={hasRdSystemAdminAccess(portalAccess.role, rdAccessStatus === "allowed")}
          onOpenExperiment={openExperiment}
          onOpenHealth={() => setPortalView("health")}
          onOpenSupport={() => setPortalView("support")}
          onOpenRd={() => {
            setRdError(null);
            setPortalView("rd");
          }}
        />
        <PortalSettingsPanel
          open={settingsOpen}
          portalRole={portalAccess.role}
          activeSection={settingsSection}
          data={data}
          runtimeState={runtimeState}
          configState={configState}
          pairings={sortedPairings}
          visiblePotCount={visiblePotCount}
          csvDownload={csvDownload}
          csvError={csvError}
          exportingCsv={exportingCsv}
          controlBusy={controlBusy}
          controlNotice={controlNotice}
          controlError={controlError}
          onClose={() => setSettingsOpen(false)}
          onSectionChange={setSettingsSection}
          onPrepareCsvDownload={prepareCsvDownload}
          onDownloadPairingsCsv={downloadPairingsCsv}
          onQueueCommand={queueControlCommand}
          onSignOut={signOut}
        />
      </main>
    );
  }

  if (!isAdmin && portalView === "home") {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <PortalResearcherHome data={data} onOpenExperiment={openExperiment} />
      </main>
    );
  }

  if (isAdmin && portalView === "health") {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <SystemHealthView
          snapshot={healthSnapshot}
          history={healthHistory}
          runtimeState={runtimeState}
          error={healthError}
          onBackHome={() => setPortalView("home")}
        />
      </main>
    );
  }

  if (isAdmin && portalView === "support") {
    return (
      <main className="dashboard-shell portal-admin-shell">
        <SalesSupportView
          data={salesSupportData}
          loading={salesSupportLoading}
          error={salesSupportError}
          onBackHome={() => setPortalView("home")}
        />
      </main>
    );
  }

  if (isAdmin && portalView === "rd") {
    return (
      <main className="dashboard-shell portal-admin-shell rd-preview-shell">
        {portalHeader}
        {rdSnapshot ? (
          <>
            {rdError ? (
              <div className="rd-refresh-notice" role="status">
                Showing the last successful snapshot. Refresh will retry automatically.
              </div>
            ) : null}
            <ResponseCurveLab
              snapshot={rdSnapshot}
              onBack={() => setPortalView("home")}
              historyLoading={rdHistoryLoading}
              historyError={rdHistoryError}
              onLoadMoreHistory={rdSnapshot.pagination?.has_more ? loadMoreRdHistory : undefined}
            />
          </>
        ) : (
          <section className="rd-load-state" aria-live="polite">
            {rdLoading ? <Loader2 className="chart-loading-spinner" size={30} aria-hidden="true" /> : <AlertTriangle size={28} aria-hidden="true" />}
            <h1>{rdLoading ? "Loading Response Curve" : "Response Curve is temporarily unavailable"}</h1>
            <p>{rdLoading ? "Loading the latest bounded lab snapshot." : "The model is still running. Only this display request failed."}</p>
            <div>
              <button type="button" className="header-action" onClick={() => setPortalView("home")}>Home</button>
              {!rdLoading ? <button type="button" className="header-action" onClick={() => void loadRdSnapshot()}>Retry</button> : null}
            </div>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="dashboard-shell experiment-shell">
      {experimentCornerActions}
      <HealthSelectedDetailDrawer
        detail={selectedWateringDetail}
        onClose={() => setSelectedWateringDetail(null)}
      />

      {canUseExperimentSettings ? (
        <PortalSettingsPanel
          open={settingsOpen}
          portalRole={portalAccess.role}
          activeSection={settingsSection}
          data={data}
          runtimeState={runtimeState}
          configState={configState}
          pairings={sortedPairings}
          visiblePotCount={visiblePotCount}
          csvDownload={csvDownload}
          csvError={csvError}
          exportingCsv={exportingCsv}
          controlBusy={controlBusy}
          controlNotice={controlNotice}
          controlError={controlError}
          onClose={() => setSettingsOpen(false)}
          onSectionChange={setSettingsSection}
          onPrepareCsvDownload={prepareCsvDownload}
          onDownloadPairingsCsv={downloadPairingsCsv}
          onQueueCommand={queueControlCommand}
          onSignOut={signOut}
        />
      ) : null}

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <h1 className="experiment-view-title">{selectedExperiment.name}</h1>

      <section
        ref={dashboardMainRef}
        className={`dashboard-main ${graphExpanded ? "is-expanded" : ""}`}
      >
        <section className={`chart-card ${experimentGraphMode === "watering" ? "is-watering" : ""}`}>
          <div className="chart-tools">
            <div className="chart-view-toggle" aria-label="Graph view">
              <button
                type="button"
                className={experimentGraphMode === "vwc" ? "is-selected" : ""}
                onClick={() => {
                  setSelectedWateringDetail(null);
                  setExperimentGraphMode("vwc");
                }}
              >
                VWC
              </button>
              {!isObservationOnlyExperiment(selectedExperiment) ? (
                <>
                  <button
                    type="button"
                    className={experimentGraphMode === "watering" ? "is-selected" : ""}
                    onClick={() => setExperimentGraphMode("watering")}
                  >
                    Watering
                  </button>
                  <button
                    type="button"
                    className={experimentGraphMode === "overlay" ? "is-selected" : ""}
                    onClick={() => {
                      setSelectedWateringDetail(null);
                      setExperimentGraphMode("overlay");
                    }}
                  >
                    Overlay
                  </button>
                </>
              ) : null}
            </div>
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

          <section
            className="chart-panel-main"
            aria-label={
              experimentGraphMode === "watering"
                ? "Watering activity chart"
                : experimentGraphMode === "overlay"
                  ? "VWC and watering overlay chart"
                  : "All plants chart"
            }
          >
            {experimentGraphMode === "watering" ? (
              <ResearchWateringActivity
                events={experimentWateringEvents}
                pairings={visibleWateringPairings}
                onSelectDetail={setSelectedWateringDetail}
              />
            ) : (
              <SensorCanvasChart
                series={timeFilteredSeries}
                visibleNames={experimentGraphMode === "overlay" ? overlayVisibleNames : visibleNames}
                selectedName={selectedSeriesName}
                viewMode="traces"
                onSelectSeries={selectPot}
                loading={loading}
                xDomain={selectedVwcTimeBounds}
                wateringEvents={experimentGraphMode === "overlay" ? experimentWateringEvents : []}
              />
            )}
          </section>
          {experimentGraphMode !== "watering" ? (
            <div className="chart-bottom-controls">
              <TimeRangeControl
                bounds={timeBounds}
                value={timeWindow}
                onChange={setTimeWindow}
              />
            </div>
          ) : null}
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
              {!isObservationOnlyExperiment(selectedExperiment) ? (
                <>
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
                </>
              ) : null}
            </div>
          </section>

          {groupedPairings.map(([zone, groupPairings]) => {
            const label = !isObservationOnlyExperiment(selectedExperiment)
              ? (zone === 2 ? "Maize" : zone === 4 ? "Sorghum" : `Zone ${zone}`)
              : `Zone ${zone}`;
            const allVisible = groupPairings.every((pairing) => !hiddenPots.has(pairing.name));
            return (
              <section className="pot-group" key={zone}>
                <div className="pot-group-head">
                  <h3>{label}</h3>
                  <button
                    type="button"
                    className={`group-toggle ${allVisible ? "is-on" : ""}`}
                    aria-label={`${allVisible ? "Hide" : "Show"} all ${label} pots`}
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
                        {!isObservationOnlyExperiment(selectedExperiment) ? (
                          <em className={`treatment-dot ${treatmentForPairing(pairing)}`}>
                            {treatmentForPairing(pairing) === "control" ? "C" : "D"}
                          </em>
                        ) : null}
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
