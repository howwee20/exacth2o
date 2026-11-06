import { describe, expect, it } from "vitest";
import { scopeWalkerSnapshot, type WalkerPortalExperiment } from "./walkerExperiments";
import { walkerDeviceId, walkerProjectId, type WalkerLiveSnapshot } from "./walkerObservation";

const experiment: WalkerPortalExperiment = { id: "study", name: "New study", project_id: walkerProjectId, device_id: walkerDeviceId, sensor_ids: [65], started_at: "2026-11-04T04:00:00Z", created_at: "2026-11-04T04:00:00Z" };
const source = {
  project_id: walkerProjectId, device_id: walkerDeviceId,
  range_start: "2026-11-01T04:00:00Z", range_end: "2026-11-04T04:10:00Z",
  expected_sensor_count: 100,
  sensors: [65, 66].map(id => ({ source_sensor_id: id, latest_reading_at: "2026-11-04T04:05:00Z", latest_calibrated_value: 30, live_point_count: 2 })),
  series: [65, 66].map(id => ({ source_sensor_id: id, points: [{ at: "2026-11-04T03:59:00Z", average: 20 }, { at: "2026-11-04T04:05:00Z", average: 30 }] })),
} as WalkerLiveSnapshot;

describe("Walker experiment isolation", () => {
  it("rejects a record or snapshot from Pan's project even when sensor numbers overlap", () => {
    expect(() => scopeWalkerSnapshot(source, { ...experiment, project_id: "22222222-2222-4222-8222-222222222222" })).toThrow("Walker Pi");
    expect(() => scopeWalkerSnapshot({ ...source, device_id: "pan-controller" }, experiment)).toThrow("Walker Pi");
  });
  it("keeps only selected Walker sensors and readings after the experiment started without mutating the source", () => {
    const result = scopeWalkerSnapshot(source, experiment);
    expect(result.sensors.map(sensor => sensor.source_sensor_id)).toEqual([65]);
    expect(result.series.map(series => series.source_sensor_id)).toEqual([65]);
    expect(result.series[0].points.map(point => point.average)).toEqual([30]);
    expect(result.expected_sensor_count).toBe(1);
    expect(source.series[0].points).toHaveLength(2);
    expect(source.sensors).toHaveLength(2);
  });
  it("does not present a reading predating the study as its latest value", () => {
    const result = scopeWalkerSnapshot({ ...source, sensors: [{ ...source.sensors[0], latest_reading_at: "2026-11-04T03:59:00Z" }] }, experiment);
    expect(result.sensors[0].latest_calibrated_value).toBeNull();
    expect(result.sensors[0].latest_reading_at).toBeNull();
    expect(result.current_sensor_count).toBe(0);
  });
});
