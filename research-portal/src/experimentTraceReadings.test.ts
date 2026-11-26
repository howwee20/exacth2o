import { describe, expect, it } from "vitest";
import { experimentTraceReadings } from "./experimentTraceReadings";
import type { PortalExperiment } from "./experimentRegistry";
import type { SensorReading } from "./types";

const experiment: PortalExperiment = { id: "trial", name: "Trial", shortDescription: "", mode: "controlled", groupNames: [], pairingNames: ["Pot 1"], startedAt: "2026-01-01T00:00:00Z", endedAt: "2027-01-01T00:00:00Z", assignments: [{ pairing_name: "Pot 1", pot_number: 1, zone: 1, sensor_key_snapshot: "sensor:1", crop: null, treatment: null, block: null, substrate: null, target_vwc_percent: 30, measurement_interval_minutes: 10 }] };
const reading = (id: number): SensorReading => ({ id, event_id: `live-device:${id}`, pairing_name: "Pot 1", sensor_key: "sensor:1", raw_value: 200, calibrated_value: 30, temperature: 22, electrical_conductivity: 1, device_recorded_at: new Date(Date.parse(experiment.startedAt!) + id * 60_000).toISOString(), server_received_at: "2026-10-26T00:00:00Z" });
describe("full experiment traces", () => {
  it("keeps more than the old 50,000-row cache limit and merges overlapping live readings", () => {
    const history = Array.from({ length: 51_003 }, (_, i) => reading(i));
    const result = experimentTraceReadings(history, [history[50_000], reading(51_003)], experiment);
    expect(result).toHaveLength(51_004);
    expect(result[0].id).toBe(0);
    expect(result.at(-1)?.id).toBe(51_003);
  });
  it("keeps the experiment boundary and follows a renamed sensor", () => {
    const old = { ...reading(2), pairing_name: "Former label" };
    const foreign = { ...reading(3), pairing_name: "Other pot", sensor_key: "other:2" };
    const before = { ...reading(4), device_recorded_at: "2025-12-31T00:00:00Z" };
    expect(experimentTraceReadings([old, foreign, before], [], experiment).map((r) => r.pairing_name)).toEqual(["Pot 1"]);
  });
});

it("preserves a flagged acknowledgement in the archive and excludes it from chart measurements", async () => {
  const { metricValue } = await import("./portalPresentation");
  const { measureValue } = await import("./waterline");
  const { readingQualityNote } = await import("./readingQuality");
  const flagged = { ...reading(1), calibrated_value: 100.68, raw_value: 0, temperature: 1, electrical_conductivity: 3, sensor_frame: "sdi12_acknowledgement" };
  const saved = experimentTraceReadings([flagged], [], experiment);
  expect(saved[0]).toMatchObject({ raw_value: 0, calibrated_value: 100.68 });
  expect(metricValue(saved[0])).toBeNull();
  expect(measureValue(saved[0], "temperature")).toBeNull();
  expect(readingQualityNote(saved[0])).toMatch(/acknowledgement/i);
  expect(metricValue({ ...flagged, calibrated_value: 0, sensor_frame: null })).toBe(0);
});
