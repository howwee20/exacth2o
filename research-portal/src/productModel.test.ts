import { describe, expect, it } from "vitest";
import { defaultGrouping, experimentFactors, parseGrouping, potGroups, potRangeText } from "./experimentFactors";
import type { PortalExperiment, PortalExperimentAssignment } from "./experimentRegistry";
import { homeExceptions, primaryExperimentException } from "./homeExceptions";
import { parsePortalRoute, portalRouteSearch } from "./portalRoute";
import type { PairingRow, SensorReading } from "./types";
import { availableMeasures, groupWaterline, median, potTraces, waterlineSegments } from "./waterline";

const minute = 60_000;
const hour = 60 * minute;

function assignment(pot: number, treatment: string, crop: string, target: number | null = null): PortalExperimentAssignment {
  return {
    pot_id: null,
    pairing_name: `Zone1-Pot${pot}`,
    zone: 1,
    pot_number: pot,
    crop,
    treatment,
    block: pot <= 4 ? "A" : "B",
    substrate: null,
    target_vwc_percent: target,
    measurement_interval_minutes: 10,
  };
}

function pairing(pot: number, target = 30, board = "1"): PairingRow {
  return {
    id: pot,
    name: `Zone1-Pot${pot}`,
    zone: 1,
    pot_number: pot,
    source_sensor_id: pot,
    sensor_key: `${board}:${pot}`,
    source_valve_id: pot,
    valve_key: `1:${pot}`,
    wtc_percent_limit: target,
    valve_open_time_ms: 3000,
    measurement_interval_ms: 10 * minute,
  };
}

function reading(pot: number, at: number, value: number): SensorReading {
  return {
    id: at + pot,
    event_id: `live-device:x:${pot}:${at}`,
    pairing_name: `Zone1-Pot${pot}`,
    sensor_key: `1:${pot}`,
    raw_value: 400 + value * 20,
    calibrated_value: value,
    temperature: null,
    electrical_conductivity: null,
    device_recorded_at: new Date(at).toISOString(),
    server_received_at: new Date(at + 1000).toISOString(),
  };
}

const experiment: PortalExperiment = {
  id: "matt-experiment-2",
  name: "Matt Experiment 2",
  shortDescription: "",
  mode: "controlled",
  status: "active",
  wateringState: "controller_managed",
  groupNames: [],
  pairingNames: [1, 2, 3, 4, 5, 6, 7, 8].map((pot) => `Zone1-Pot${pot}`),
  assignments: [
    assignment(1, "control", "maize", 34),
    assignment(2, "drought", "maize", 22),
    assignment(3, "control", "sorghum", 34),
    assignment(4, "drought", "sorghum", 22),
    assignment(5, "control", "maize", 34),
    assignment(6, "drought", "maize", 22),
    assignment(7, "control", "sorghum", 34),
    assignment(8, "drought", "sorghum", 22),
  ],
};

describe("experiment factors", () => {
  it("derives factors from the assignments instead of a fixed treatment list", () => {
    const factors = experimentFactors(experiment);
    expect(factors.map((factor) => factor.key)).toEqual(["treatment", "crop", "block"]);
    expect(factors[0].levels.map((level) => level.label)).toEqual(["Control", "Drought"]);
    expect(defaultGrouping(factors)).toEqual(["treatment", "crop"]);
  });

  it("groups pots by any chosen factor and keeps unassigned pots visible", () => {
    const groups = potGroups({ ...experiment, pairingNames: [...experiment.pairingNames, "Zone1-Pot9"] }, ["treatment"]);
    expect(groups.map((group) => [group.label, group.pairingNames.length, group.plannedTargets])).toEqual([
      ["Control", 4, [34]],
      ["Drought", 4, [22]],
      ["Not in the plan", 1, []],
    ]);
    expect(new Set(groups.map((group) => group.pattern.dash)).size).toBe(3);
  });

  it("parses a grouping from the URL and ignores factors the experiment does not have", () => {
    const factors = experimentFactors(experiment);
    expect(parseGrouping("crop", factors)).toEqual(["crop"]);
    expect(parseGrouping("substrate", factors)).toEqual(["treatment", "crop"]);
    expect(parseGrouping("none", factors)).toEqual([]);
    expect(experimentFactors({ assignments: [assignment(1, "x", "maize")] })).toEqual([]);
  });

  it("writes pot ranges compactly", () => {
    expect(potRangeText([17, 18, 19, 20, 21, 22, 23, 24])).toBe("Pots 17–24");
    expect(potRangeText([3, 11, 20])).toBe("Pots 3, 11 and 20");
    expect(potRangeText([4])).toBe("Pot 4");
    expect(potRangeText([1, 2, 3, 4, 9, 12])).toBe("Pots 1–4, 9 and 12");
  });
});

describe("waterline statistics", () => {
  const now = Date.UTC(2026, 9, 7, 21, 40);
  const window = { startMs: now - 6 * hour, endMs: now };

  it("weights every pot equally per bucket, whatever its sampling rate", () => {
    // Pot 1 reports six times per bucket at 30; pot 2 once at 10; pot 3 once at 20.
    const readings: SensorReading[] = [];
    for (let i = 0; i < 6; i += 1) readings.push(reading(1, window.startMs + i * 5 * minute, 30));
    readings.push(reading(2, window.startMs + 10 * minute, 10));
    readings.push(reading(3, window.startMs + 10 * minute, 20));
    const traces = potTraces(readings, [pairing(1), pairing(2), pairing(3)], "vwc");
    const line = groupWaterline({ id: "g", label: "G", levels: {}, pairingNames: ["Zone1-Pot1", "Zone1-Pot2", "Zone1-Pot3"], potNumbers: [1, 2, 3], plannedTargets: [], pattern: { index: 0, color: "#000", dash: null, marker: "circle" } }, traces, window, { bucketMs: hour, asOfMs: now });
    expect(line.buckets[0]).toMatchObject({ potCount: 3, median: 20, low: 10, high: 30 });
    // A mean over readings would have been (6×30+10+20)/8 = 26.25.
  });

  it("leaves a gap where fewer than half the pots reported and ends where readings end", () => {
    const readings = [
      reading(1, window.startMs + 5 * minute, 30),
      reading(2, window.startMs + 5 * minute, 31),
      reading(1, window.startMs + 65 * minute, 30),
      reading(1, window.startMs + 125 * minute, 29),
      reading(2, window.startMs + 125 * minute, 30),
    ];
    const traces = potTraces(readings, [pairing(1), pairing(2), pairing(3), pairing(4)], "vwc");
    const line = groupWaterline({ id: "g", label: "G", levels: {}, pairingNames: ["Zone1-Pot1", "Zone1-Pot2", "Zone1-Pot3", "Zone1-Pot4"], potNumbers: [1, 2, 3, 4], plannedTargets: [], pattern: { index: 0, color: "#000", dash: null, marker: "circle" } }, traces, window, { bucketMs: hour, asOfMs: now });
    expect(line.buckets.map((bucket) => bucket.median)).toEqual([30.5, null, 29.5, null, null, null, null]);
    expect(line.buckets[1].thin).toBe(true);
    expect(waterlineSegments(line.buckets)).toHaveLength(2);
    // Nothing is current four hours later: coverage says so instead of hiding it.
    expect(line.reporting).toBe(0);
    expect(line.silent.map((pot) => pot.potNumber)).toEqual([1, 2, 3, 4]);
  });

  it("only offers measures that have data and computes medians", () => {
    expect(availableMeasures([reading(1, now, 30)])).toEqual(["vwc", "raw"]);
    expect(median([3, 1, 2, 10])).toBe(2.5);
  });
});

describe("home exceptions", () => {
  const now = Date.UTC(2026, 9, 7, 21, 40);
  const pairings = [1, 2, 3, 4, 5, 6, 7, 8].map((pot) => pairing(pot, pot % 2 ? 34 : 22, pot > 4 ? "3" : "1"));
  const fresh = pairings.map((p) => reading(p.pot_number, now - 5 * minute, 30));
  const format = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const base = { experiments: [experiment], pairings, nowMs: now, checked: true, refresh: { failedAt: null, lastSuccessAt: now }, controller: { offline: false, lastSeenAt: now }, formatTime: format };

  it("is silent when every pot is current and the plan matches the controller", () => {
    expect(homeExceptions({ ...base, readings: fresh })).toEqual([]);
  });

  it("names the silent board, not every pot, and stays specific to the experiment", () => {
    const readings = fresh.filter((r) => !["Zone1-Pot5", "Zone1-Pot6", "Zone1-Pot7", "Zone1-Pot8"].includes(r.pairing_name))
      .concat([5, 6, 7, 8].map((pot) => reading(pot, now - 3 * hour, 30)));
    const exceptions = homeExceptions({ ...base, readings });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ kind: "missing-observations", experimentId: "matt-experiment-2" });
    expect(exceptions[0].sentence).toContain("Pots 5–8 (sensor board 3)");
  });

  it("separates a failed portal check from a controller outage and judges pots as of the last good check", () => {
    const failed = homeExceptions({ ...base, readings: fresh, nowMs: now + 3 * hour, refresh: { failedAt: now + 3 * hour, lastSuccessAt: now } });
    expect(failed.map((item) => item.kind)).toEqual(["refresh-failed"]);
    const offline = homeExceptions({ ...base, readings: fresh, nowMs: now + 3 * hour, controller: { offline: true, lastSeenAt: now } });
    expect(offline.map((item) => item.kind)).toEqual(["controller-offline"]);
  });

  it("says nothing about pots before the first successful check", () => {
    expect(homeExceptions({ ...base, readings: [], checked: false, refresh: { failedAt: null, lastSuccessAt: null } })).toEqual([]);
  });

  it("reports a plan/controller target difference as its own condition", () => {
    const drifted = pairings.map((p) => (p.pot_number === 2 ? { ...p, wtc_percent_limit: 25 } : p));
    const exceptions = homeExceptions({ ...base, pairings: drifted, readings: fresh });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ kind: "configuration-discrepancy", short: "Plan 22% · controller 25% on 1 pot" });
    expect(primaryExperimentException(exceptions, "matt-experiment-2")?.more).toBe(0);
  });
});

describe("portal routes", () => {
  it("round-trips every route and keeps the project", () => {
    const cases = [
      "",
      "?view=trends",
      "?view=bench&pot=Zone1-Pot3",
      "?view=workbench&comparison=abc",
      "?experiment=matt-experiment-2&tab=pots&pot=Zone1-Pot3",
      "?pot=Zone1-Pot17",
      "?view=pocket&pot=Zone1-Pot17&note=1",
      "?view=health",
    ];
    for (const search of cases) {
      expect(portalRouteSearch(parsePortalRoute(search))).toBe(search);
    }
    expect(portalRouteSearch({ view: "experiment", experiment: "x", tab: "overview", pot: null }, "?project=p1&group=crop&invite=t")).toBe("?experiment=x&project=p1");
  });

  it("falls back to the home for unknown views and to the overview for unknown tabs", () => {
    expect(parsePortalRoute("?view=nope")).toEqual({ view: "home" });
    expect(parsePortalRoute("?experiment=x&tab=nope")).toEqual({ view: "experiment", experiment: "x", tab: "overview", pot: null });
  });
});
