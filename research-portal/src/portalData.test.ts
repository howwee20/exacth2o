import { describe, expect, it } from "vitest";
import {
  dedupeReadings,
  mergeRollingExperimentReadings,
  rollingExperimentHistoryMs,
  rollingExperimentReadLimit,
} from "./portalData";
import type { SensorReading } from "./types";

const nowMs = Date.parse("2026-10-07T16:00:00Z");

function reading(id: number, minutesAgo: number, eventId = `live-device:${id}`): SensorReading {
  const at = new Date(nowMs - minutesAgo * 60_000).toISOString();
  return {
    id,
    event_id: eventId,
    pairing_name: `Zone1-Pot${(id % 12) + 1}`,
    sensor_key: `board:${id % 12}`,
    raw_value: 1000 + id,
    calibrated_value: 20 + (id % 17),
    temperature: null,
    electrical_conductivity: null,
    device_recorded_at: at,
    server_received_at: at,
  };
}

// The pre-optimisation implementation, kept as the behavioural reference.
function referenceMerge(base: SensorReading[], incoming: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const item of [...base, ...incoming]) byKey.set(item.event_id || String(item.id), item);
  const cutoff = nowMs - rollingExperimentHistoryMs;
  return Array.from(byKey.values())
    .sort((a, b) => new Date(b.device_recorded_at).getTime() - new Date(a.device_recorded_at).getTime())
    .slice(0, rollingExperimentReadLimit)
    .filter((item) => Date.parse(item.device_recorded_at) >= cutoff);
}

describe("rolling readings merge", () => {
  it("matches the previous merge exactly, including duplicate replacement and the window cutoff", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const base = Array.from({ length: 3000 }, (_, index) => reading(index, Math.floor(random() * 5000)));
    const incoming = Array.from({ length: 400 }, (_, index) => {
      const id = Math.floor(random() * 3600);
      const item = reading(id, Math.floor(random() * 5000));
      return index % 3 === 0 ? { ...item, calibrated_value: 99 } : item;
    });
    expect(mergeRollingExperimentReadings(base, incoming, nowMs)).toEqual(referenceMerge(base, incoming));
  });

  it("orders newest first and keeps the later copy of a repeated event", () => {
    const older = reading(1, 30);
    const replacement = { ...reading(1, 30), calibrated_value: 41 };
    const newer = reading(2, 5);
    const merged = mergeRollingExperimentReadings([older], [newer, replacement], nowMs);
    expect(merged.map((item) => item.id)).toEqual([2, 1]);
    expect(merged[1].calibrated_value).toBe(41);
  });

  it("drops unparsable timestamps from the rolling window", () => {
    const broken = { ...reading(5, 1), device_recorded_at: "not a date" };
    expect(mergeRollingExperimentReadings([broken], [reading(6, 2)], nowMs).map((item) => item.id)).toEqual([6]);
    expect(dedupeReadings([broken, reading(6, 2)]).map((item) => item.id)).toEqual([6, 5]);
  });

  it("merges a realtime batch into 50,000 readings quickly", () => {
    const base = Array.from({ length: 50_000 }, (_, index) => reading(index, (index % 4000) + 1));
    const incoming = Array.from({ length: 24 }, (_, index) => reading(60_000 + index, 0));
    const started = performance.now();
    const merged = mergeRollingExperimentReadings(base, incoming, nowMs);
    const elapsed = performance.now() - started;
    expect(merged[0].id).toBeGreaterThanOrEqual(60_000);
    expect(merged).toHaveLength(rollingExperimentReadLimit);
    // Generous bound for slow CI machines; the previous implementation re-parsed dates in the comparator.
    expect(elapsed).toBeLessThan(1500);
  });
});
