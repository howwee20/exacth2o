import { walkerDeviceId, walkerProjectId, type WalkerLiveSnapshot } from "./walkerObservation";

export type WalkerPortalExperiment = {
  id: string;
  project_id: string;
  device_id: string;
  name: string;
  sensor_ids: number[];
  started_at: string;
  created_at: string;
};

/** A saved observation filters only Walker readings; it cannot carry controller settings. */
export function scopeWalkerSnapshot(snapshot: WalkerLiveSnapshot, experiment: WalkerPortalExperiment) {
  if (snapshot.project_id !== walkerProjectId || snapshot.device_id !== walkerDeviceId ||
      experiment.project_id !== walkerProjectId || experiment.device_id !== walkerDeviceId) {
    throw new Error("The experiment does not belong to Walker Pi.");
  }
  const start = Date.parse(experiment.started_at);
  if (!Number.isFinite(start)) throw new Error("The experiment start time is unavailable.");
  const selected = new Set(experiment.sensor_ids);
  const series = snapshot.series.filter(item => selected.has(item.source_sensor_id)).map(item => ({
    ...item, points: item.points.filter(point => Date.parse(point.at) >= start),
  }));
  const sensors = snapshot.sensors.filter(sensor => selected.has(sensor.source_sensor_id)).map(sensor => {
    if (sensor.latest_reading_at && Date.parse(sensor.latest_reading_at) >= start) return sensor;
    return { ...sensor, latest_reading_at: null, latest_calibrated_value: null, live_point_count: 0 };
  });
  return {
    ...snapshot,
    range_start: new Date(Math.min(Date.parse(snapshot.range_end), Math.max(start, Date.parse(snapshot.range_start)))).toISOString(),
    sensors, series,
    expected_sensor_count: selected.size,
    evidenced_sensor_count: sensors.length,
    current_sensor_count: sensors.filter(sensor => sensor.latest_reading_at && Date.parse(sensor.latest_reading_at) >= Date.parse(snapshot.range_end) - 15 * 60_000).length,
  };
}
