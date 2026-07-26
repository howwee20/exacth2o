export const walkerProjectId = "33333333-3333-4333-8333-333333333331";
export const walkerDeviceId = "balena:a1c4ace2b367fbee8521f1aff6a6329b";
export const walkerDefaultWindowHours = 72;
export const walkerDefaultPointBudget = 288;

export type WalkerLiveFreshness =
  | "awaiting_publisher"
  | "live"
  | "delayed"
  | "stale";

export type WalkerPublisherState = {
  status: "gate_b_pending" | "starting" | "healthy" | "degraded" | "stopped";
  cursor: number | null;
  source_latest_known: number | null;
  accepted_after: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
};

export type WalkerLiveStatus = {
  project_id: string;
  device_id: string;
  device_name: string;
  observation_only: true;
  portal_control_available: false;
  expected_sensor_count: 100;
  evidenced_sensor_count: number;
  missing_numeric_positions: number[];
  window_hours: number;
  freshness: WalkerLiveFreshness;
  latest_live_reading_at: string | null;
  publisher: WalkerPublisherState;
};

export type WalkerLiveSensor = {
  source_sensor_id: number;
  sensor_key: string;
  display_label: string;
  source_pairing_name: string;
  position_number: number | null;
  board_serial_id: string;
  sensor_address: string;
  latest_calibrated_value: number | null;
  latest_reading_at: string | null;
  live_point_count: number;
};

export type WalkerLiveTracePoint = {
  at: string;
  minimum: number;
  maximum: number;
  average: number;
  sample_count: number;
};

export type WalkerLiveTraceSeries = {
  source_sensor_id: number;
  display_label: string;
  source_pairing_name: string;
  position_number: number | null;
  board_serial_id: string;
  points: WalkerLiveTracePoint[];
};

export type WalkerLiveSnapshot = WalkerLiveStatus & {
  range_start: string;
  range_end: string;
  point_budget: number;
  bucket_seconds: number;
  sensors: WalkerLiveSensor[];
  series: WalkerLiveTraceSeries[];
};

export function isWalkerAccessDenied(error: { code?: string; message?: string } | null) {
  return error?.code === "42501" ||
    error?.message?.toLowerCase().includes("observation access required") === true;
}

export function walkerSensorsByBoard(sensors: WalkerLiveSensor[]) {
  const boards = new Map<string, WalkerLiveSensor[]>();
  for (const sensor of sensors) {
    const current = boards.get(sensor.board_serial_id) ?? [];
    current.push(sensor);
    boards.set(sensor.board_serial_id, current);
  }
  return Array.from(boards.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

export function toggleWalkerSensorSelection(
  selectedIds: ReadonlySet<number>,
  sensorId: number,
  allSensorIds: readonly number[],
) {
  if (selectedIds.size === allSensorIds.length) return new Set([sensorId]);
  const next = new Set(selectedIds);
  if (next.has(sensorId)) next.delete(sensorId);
  else next.add(sensorId);
  return next;
}
