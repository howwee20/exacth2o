export const walkerProjectId = "33333333-3333-4333-8333-333333333331";
export const walkerDeviceId = "balena:a1c4ace2b367fbee8521f1aff6a6329b";

export type WalkerWorkspace = {
  id: string;
  slug: string;
  name: string;
  workspace_type: "completed_archive" | "planned_validation";
  lifecycle_state: "completed" | "planned";
  observation_mode: "historical" | "planned";
  started_at: string | null;
  ended_at: string | null;
  watering_state: "off";
  immutable: boolean;
};

export type WalkerSensor = {
  source_sensor_id: number;
  sensor_key: string;
  display_label: string;
  source_pairing_name: string;
  position_number: number | null;
  board_serial_id: string;
  sensor_address: string;
  historical_group: string | null;
  first_reading_at: string | null;
  last_reading_at: string | null;
  latest_calibrated_value: number | null;
  reading_count: number;
  quality_flags: Record<string, unknown>;
};

export type WalkerOverview = {
  project_id: string;
  device_id: string;
  device_name: string;
  source: "verified_historical_archive";
  freshness: "stale";
  live_ingestion: false;
  latest_verified_reading_at: string;
  historical_controller_state: "STOPPED";
  controller_state_observed_at: string;
  portal_control_available: false;
  physical_water_capable: true;
  expected_sensor_count: 100;
  evidenced_sensor_count: number;
  inventory_discrepancy: {
    missing_numeric_positions: number[];
    position_41_label: string;
    resolved: false;
  };
  workspaces: WalkerWorkspace[];
  archive: {
    name: string;
    status: "planned" | "importing" | "verified" | "failed";
    expected_reading_count: number;
    imported_reading_count: number;
    expected_sensor_count: number;
    imported_sensor_count: number;
    expected_first_at: string;
    expected_last_at: string;
    verified_at: string | null;
  };
  sensors: WalkerSensor[];
};

export type WalkerTracePoint = {
  at: string;
  minimum: number;
  maximum: number;
  average: number;
  sample_count: number;
};

export type WalkerTraceSeries = {
  source_sensor_id: number;
  display_label: string;
  source_pairing_name: string;
  board_serial_id: string;
  historical_group: string | null;
  points: WalkerTracePoint[];
};

export type WalkerTracePage = {
  range_start: string | null;
  range_end: string | null;
  point_budget: number;
  bucket_seconds?: number;
  series: WalkerTraceSeries[];
};

export function isWalkerAccessDenied(error: { code?: string; message?: string } | null) {
  return error?.code === "42501" ||
    error?.message?.toLowerCase().includes("observation access required") === true;
}

export function filterWalkerSensors(
  sensors: WalkerSensor[],
  query: string,
  board: string,
  group: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  return sensors.filter((sensor) => {
    if (board !== "all" && sensor.board_serial_id !== board) return false;
    if (group !== "all" && (sensor.historical_group ?? "Ungrouped") !== group) {
      return false;
    }
    if (!normalizedQuery) return true;
    return [
      sensor.display_label,
      sensor.source_pairing_name,
      sensor.sensor_key,
      sensor.board_serial_id,
      sensor.sensor_address,
      sensor.historical_group,
      String(sensor.source_sensor_id),
      sensor.position_number == null ? null : String(sensor.position_number),
    ].some((value) => value?.toLowerCase().includes(normalizedQuery));
  });
}

export function walkerSmallMultipleGroups(
  series: WalkerTraceSeries[],
  groupSize = 16,
) {
  const byBoard = new Map<string, WalkerTraceSeries[]>();
  series.forEach((trace) => {
    const current = byBoard.get(trace.board_serial_id) ?? [];
    current.push(trace);
    byBoard.set(trace.board_serial_id, current);
  });
  return Array.from(byBoard.entries()).flatMap(([board, traces]) => {
    const groups = [];
    for (let index = 0; index < traces.length; index += groupSize) {
      groups.push({
        id: `${board}-${Math.floor(index / groupSize) + 1}`,
        label: `${board} · ${index + 1}–${Math.min(index + groupSize, traces.length)}`,
        series: traces.slice(index, index + groupSize),
      });
    }
    return groups;
  });
}
