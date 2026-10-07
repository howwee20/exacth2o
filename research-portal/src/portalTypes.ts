import { type PlantGroup, type Treatment } from "./experimentPresentation";
import { type PortalRole } from "./portalAccess";
import { type EffectiveMode } from "./portalData";
import { type SettingsPlan } from "./settingsSpec";
import { type LatestState, type PairingRow, type SensorReading } from "./types";

export type ViewMode = "group" | "traces" | "individual" | "qc";
export type ExperimentGraphMode = "vwc" | "watering" | "overlay";

export type LoadState = {
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

export type ChartPoint = {
  timestampMs: number;
  value: number;
  reading: SensorReading;
};

export type ChartSeries = {
  name: string;
  kind: "pot" | "group";
  zone: number;
  potNumber: number;
  treatment: Treatment;
  plantGroup: PlantGroup;
  color: string;
  /** Every valid reading, ascending by time, one per timestamp. Never display-sampled. */
  points: ChartPoint[];
  rawPointCount: number;
  /** Configured reporting interval for this pot, when known. */
  expectedIntervalMs: number | null;
  /** Readings dropped for a non-finite value or timestamp. */
  invalidCount: number;
  duplicateCount: number;
  conflictingDuplicateCount: number;
  memberCount?: number;
};

/** Horizontal reference line on a VWC chart, e.g. a treatment's target. */
export type ChartTargetLine = {
  value: number;
  label: string;
  tone: "control" | "drought" | "neutral";
};

export type WateringOverlayMarker = {
  event: HealthWateringEvent;
  series: ChartSeries;
  timestampMs: number;
  value: number | null;
  exactValue: boolean;
  before: ChartPoint | null;
  after: ChartPoint | null;
};

export type WateringOverlayTooltip = WateringOverlayMarker & {
  x: number;
  y: number;
  locked?: boolean;
};

export type PotPreset = "all" | "control" | "drought" | "maize" | "sorghum" | "custom";
export type AuthMode = "sign-in" | "accept-invite" | "set-password";
export type PortalView = "home" | "experiment" | "health" | "support" | "walker" | "chamber" | "analytics";

export type PortalAccess = {
  role: PortalRole;
  email: string | null;
  projectId: string;
  deviceId: string | null;
  accessScope: string;
  gasMixerAllowed: boolean;
} | null;

export type InviteAcceptResponse = {
  ok?: boolean;
  session?: {
    access_token?: string;
    refresh_token?: string;
  };
};

export type TooltipState = {
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

export type CsvDownload = {
  url: string;
  filename: string;
  rowCount: number;
};

export type PanelPosition = {
  x: number;
  y: number;
};

export type PanelSize = {
  width: number;
  height: number;
};

export type SettingsSection =
  | "overview"
  | "assistant"
  | "pairings"
  | "autocalibrate"
  | "calibrations"
  | "water"
  | "groups"
  | "hardware"
  | "exports";

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  description: string;
  group: "Experiment" | "Set up" | "Data" | "Advanced";
};

export type BoardConfig = {
  address: string;
  resetPin: string;
};

export type ControlCommandType =
  | "update_pairing"
  | "bulk_update_pairings"
  | "create_pairing"
  | "delete_pairing"
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

export const adminOnlyControlCommandTypes = new Set<ControlCommandType>([
  "create_calibration",
  "delete_calibration",
  "apply_calibration",
  "delete_pairing",
  "update_board_config",
  "initialize_sensors",
]);

export type ControlCommand = {
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

export type ControlCommandResponse = {
  ok?: boolean;
  operation_id?: string;
  command?: ControlCommand;
  batch_id?: string;
  commands?: ControlCommand[];
};

export type QueueControlCommand = (
  commandType: ControlCommandType,
  payload: Record<string, unknown>,
  options?: { confirm?: boolean; operationIntent?: string },
) => Promise<void>;

export type QueueSettingsPlan = (
  plan: SettingsPlan,
  configHash: string,
) => Promise<void>;

export type DeviceHealthSnapshot = {
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

export type DeviceRuntimeState = {
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

export type DeviceConfigState = {
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

export type SupportStatus = "new" | "open" | "waiting_on_customer" | "quoted" | "won" | "lost" | "closed";

export type QuoteRequestRow = {
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

export type SupportThreadRow = {
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

export type SupportMessageRow = {
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

export type SalesSupportData = {
  quotes: QuoteRequestRow[];
  threads: SupportThreadRow[];
  messages: SupportMessageRow[];
};

export type TimeBounds = {
  startMs: number;
  endMs: number;
};

export type TimeWindow = {
  start: number;
  end: number;
};

export type RefreshOptions = {
  incremental: boolean;
};

export type HealthChartPoint = {
  t: number;
  iso: string;
  value: number | null;
};

export type HealthChartWindow = {
  startMs: number;
  endMs: number;
  maxOffset: number;
};

export type HealthChartSeries = {
  label: string;
  tone: "primary" | "secondary" | "warning" | "danger";
  points: HealthChartPoint[];
};

export type HealthSelectedDetail = {
  title: string;
  rows: Array<{ label: string; value: string }>;
};

export type HealthHistoryRecord = Record<string, unknown> & {
  t?: string;
};

export type HealthWateringEvent = Record<string, unknown> & {
  t?: string;
  pairing?: string;
  pairingName?: string;
  originalPairing?: string;
  physicalPot?: number;
  valveOpenTimeMs?: number;
  sensor?: string;
  valve?: string;
};
