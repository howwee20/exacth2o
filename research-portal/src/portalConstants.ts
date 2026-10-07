import { type PanelSize, type TimeWindow } from "./portalTypes";

export const pageSize = 1000;
export const readingSelectColumns =
  "id,event_id,pairing_name,sensor_key,raw_value,calibrated_value,temperature,electrical_conductivity,device_recorded_at,server_received_at";
export const healthSnapshotSelectColumns =
  "id,project_id,device_id,device_name,source,captured_at,owner_checked_at,status_endpoint_ok,history_endpoint_ok,status_http_status,status_elapsed_ms,history_samples,overall_status,api_status,pi_online,public_url_reachable,ethernet_link,ethernet_ip,gateway_ping_ms,undervoltage,cpu_temp_c,uptime_seconds,sensors_expected,sensors_current,sensors_stale,sensors_missing,missing_sensors,stale_sensors,last_sensor_reading_at,watering_last_event,watering_last_event_at,watering_events_last_24h,scheduler_jobs_loaded,active_alerts,known_issues,ingest_complete,created_at";
export const autoRefreshMs = 5 * 60_000;
export const healthSnapshotPollMs = 5 * 60_000;
export const supabaseQueryTimeoutMs = 12_000;
export const portalAccessTimeoutMs = 8_000;
export const supportPollMs = 2 * 60_000;
export const incrementalCursorOverlapMs = 2 * 60_000;
export const fullReconciliationEveryPolls = 72;
export const healthChartWindowHours = 8;
export const staleAfterMs = 15 * 60 * 1000;
export const dayMs = 24 * 60 * 60 * 1000;
export const wateringEventDedupeBucketMs = 60 * 1000;
export const wateringHistoryMs = 7 * dayMs;
export const maxValveEventRows = 2_000;
export const incrementalValveEventRows = 250;
export const wateringOverlayMaxSampleSpanMs = 30 * 60 * 1000;

export const importedPrefix = "balena-export-v2:%";
export const livePrefix = "live-device:%";
export const rememberEmailKey = "exacth2o.portal.rememberEmail";
// The shared demo account lives in the sample-data portal at /demo. Its sign-in is handed over
// there without contacting Supabase, so the demo never touches real accounts or data.
export const demoAccountEmail = "demo@exacth2o.com";
export const demoHandoffKey = "exacth2o.portal.demoHandoff";
export const defaultExpandedPanelSize: PanelSize = {
  width: 300,
  height: 430,
};
export const minExpandedPanelSize: PanelSize = {
  width: 190,
  height: 46,
};
export const fullTimeWindow: TimeWindow = {
  start: 0,
  end: 100,
};
export const minTimeWindowSpan = 3;
