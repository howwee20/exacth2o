import { describe, expect, it } from "vitest";
import { measurementFreshness } from "./measurementFreshness";
import {
  experimentFreshness,
  orderHomeExperiments,
  experimentProgressText,
  groupTarget,
  latestMeasurementByPot,
  reportingCoverage,
  withReportingCoverage,
  pairingTargetText,
  targetLinesForPairings,
} from "./experimentMeasurement";
import { pairingWateringDisabled, presentTarget, wateringDisabledTarget } from "./targetPresentation";
import type { PortalExperiment } from "./experimentRegistry";
import type { PairingRow } from "./types";

function pairing(name: string, overrides: Partial<PairingRow> = {}): PairingRow {
  return {
    id: 1,
    name,
    zone: 1,
    pot_number: Number(name.replace(/\D/g, "")) || 1,
    source_sensor_id: 1,
    sensor_key: `board:${name}`,
    source_valve_id: 1,
    valve_key: `0x20:${name}`,
    wtc_percent_limit: 30,
    valve_open_time_ms: 3000,
    measurement_interval_ms: 600_000,
    ...overrides,
  };
}

const active = { status: "active" as const, wateringState: "controller_managed" as const, mode: "controlled" as const };

describe("presentTarget", () => {
  it("keeps an intentional 0% target distinct from no target, disabled watering, sensing only and completion", () => {
    expect(presentTarget({ target: 0 }).label).toBe("Target 0% VWC");
    expect(presentTarget({ target: 0 }).kind).toBe("zero_target");
    expect(presentTarget({ target: null }).label).toBe("No target set");
    expect(presentTarget({ target: wateringDisabledTarget }).label).toBe("Watering disabled");
    expect(presentTarget({ target: 30, sensingOnly: true }).label).toBe("Sensing only");
    expect(presentTarget({ target: 30, experimentStatus: "completed" }).label).toBe("Completed · target was 30% VWC");
    expect(presentTarget({ target: 30 }).label).toBe("Target 30% VWC");
    expect(presentTarget({ target: 30, distinctTargets: [25, 30] }).kind).toBe("mixed");
  });

  it("matches the controller's rule for when watering is disabled", () => {
    expect(pairingWateringDisabled(pairing("Pot 1", { wtc_percent_limit: -999_999 }))).toBe(true);
    expect(pairingWateringDisabled(pairing("Pot 1", { valve_open_time_ms: 0 }))).toBe(true);
    expect(pairingWateringDisabled(pairing("Pot 1", { wtc_percent_limit: 0 }))).toBe(false);
    expect(pairingWateringDisabled(pairing("Pot 1", { measurement_interval_ms: 0 }))).toBe(true);
  });
});

describe("groupTarget", () => {
  it("labels a 0% plan target explicitly instead of a bare 0%", () => {
    const result = groupTarget({ target: 0, pairingNames: ["Pot 1", "Pot 2"] }, active, [
      pairing("Pot 1", { wtc_percent_limit: 0 }),
      pairing("Pot 2", { wtc_percent_limit: 0 }),
    ]);
    expect(result.label).toBe("Target 0% VWC");
    expect(result.planMismatch).toBe(false);
  });

  it("presents the controller's applied target, with the differing plan beside it", () => {
    const result = groupTarget({ target: 30, pairingNames: ["Pot 1"] }, active, [pairing("Pot 1", { wtc_percent_limit: 25 })]);
    expect(result.planMismatch).toBe(true);
    // Every label (card, screen reader, expanded header) carries the applied value and the mismatch.
    expect(result.label).toBe("Target 25% VWC · plan 30%");
    expect(result.detail).toMatch(/^Target 25% VWC/);
    expect(result.detail).toMatch(/plan says 30% VWC, but the controller is applying 25% VWC/);
    expect(result.lineValue).toBe(25);
  });

  it("says when only some pots in a group are watered", () => {
    const result = groupTarget({ target: null, pairingNames: ["Pot 1", "Pot 2", "Pot 3"] }, active, [
      pairing("Pot 1", { wtc_percent_limit: 35 }),
      pairing("Pot 2", { wtc_percent_limit: 35 }),
      pairing("Pot 3", { wtc_percent_limit: -999_999 }),
    ]);
    expect(result.label).toBe("Target 35% VWC · 1 pot unwatered");
  });

  it("reports sensing-only and completed experiments rather than a target", () => {
    expect(groupTarget({ target: 30, pairingNames: [] }, { ...active, wateringState: "off" }, []).kind).toBe("sensing_only");
    expect(groupTarget({ target: 30, pairingNames: [] }, { ...active, status: "completed" }, []).kind).toBe("completed");
  });
});

describe("targetLinesForPairings", () => {
  const treatment = (item: PairingRow) => (item.pot_number % 2 ? "control" : "drought") as "control" | "drought";

  it("draws one labelled line per treatment with a single applied target", () => {
    const lines = targetLinesForPairings([
      pairing("Pot 1", { wtc_percent_limit: 35 }),
      pairing("Pot 3", { wtc_percent_limit: 35 }),
      pairing("Pot 2", { wtc_percent_limit: 20 }),
    ], treatment, active);
    expect(lines).toEqual([
      { value: 35, label: "Current control target 35%", tone: "control" },
      { value: 20, label: "Current drought target 20%", tone: "drought" },
    ]);
  });

  it("draws nothing for mixed, disabled, sensing-only or completed groups", () => {
    expect(targetLinesForPairings([pairing("Pot 1", { wtc_percent_limit: 35 }), pairing("Pot 3", { wtc_percent_limit: 30 })], treatment, active)).toEqual([]);
    expect(targetLinesForPairings([pairing("Pot 1", { valve_open_time_ms: 0 })], treatment, active)).toEqual([]);
    expect(targetLinesForPairings([pairing("Pot 1")], treatment, { ...active, wateringState: "off" })).toEqual([]);
    expect(targetLinesForPairings([pairing("Pot 1")], treatment, { ...active, status: "completed" })).toEqual([]);
  });

  it("describes each pot's target for tooltips", () => {
    expect(pairingTargetText(pairing("Pot 1", { wtc_percent_limit: 0 }), active)).toBe("Target 0% VWC");
    expect(pairingTargetText(pairing("Pot 1", { wtc_percent_limit: -999_999 }), active)).toBe("Watering disabled");
    expect(pairingTargetText(pairing("Pot 1"), { ...active, mode: "observation" })).toBe("Sensing only");
  });
});

describe("experimentFreshness", () => {
  const nowMs = Date.parse("2026-10-07T16:00:00Z");

  it("uses the fastest configured cadence among the experiment's pots", () => {
    const pairings = [pairing("Pot 1", { measurement_interval_ms: 60_000 }), pairing("Pot 2", { measurement_interval_ms: 600_000 })];
    // 40 minutes without a reading: stale for one-minute reporters, only delayed for ten-minute ones.
    expect(experimentFreshness({ experiment: active, pairings, latestMeasuredAt: nowMs - 40 * 60_000, nowMs }).state).toBe("stale");
    expect(experimentFreshness({ experiment: active, pairings: [pairings[1]], latestMeasuredAt: nowMs - 40 * 60_000, nowMs }).state).toBe("delayed");
  });

  it("treats ended experiments as historical", () => {
    const ended = { status: "active" as const, endedAt: "2026-09-20T00:00:00Z" };
    expect(experimentFreshness({ experiment: ended, pairings: [], latestMeasuredAt: "2026-09-16T19:23:00Z", nowMs }).state).toBe("historical");
  });
});

describe("experimentProgressText", () => {
  const nowMs = Date.parse("2026-10-07T16:00:00Z");
  it("states the experiment day from its recorded start and planned end", () => {
    expect(experimentProgressText({ startedAt: "2026-10-02T12:00:00Z" }, nowMs)).toBe("Day 6");
    expect(experimentProgressText({ startedAt: "2026-10-02T12:00:00Z", endedAt: "2026-10-16T12:00:00Z" }, nowMs)).toBe("Day 6 of 14");
    expect(experimentProgressText({ startedAt: "2026-09-02T12:00:00Z", endedAt: "2026-09-16T12:00:00Z" }, nowMs)).toBe("Completed after 14 days");
    expect(experimentProgressText({}, nowMs)).toBeNull();
  });
});

describe("reporting coverage", () => {
  it("does not let one live pot make a silent experiment look current", () => {
    const now = Date.parse("2026-10-07T16:00:00Z");
    const pots = Array.from({ length: 12 }, (_, index) => ({ name: `Pot ${index + 1}`, measurement_interval_ms: 120_000 }));
    const latest = latestMeasurementByPot([
      { pairing_name: "Pot 1", device_recorded_at: new Date(now - 60_000).toISOString() },
      ...pots.slice(1).map((p) => ({ pairing_name: p.name, device_recorded_at: new Date(now - 60 * 3_600_000).toISOString() })),
    ]);
    const coverage = reportingCoverage(pots, latest, now);
    expect(coverage).toEqual({ reporting: 1, total: 12 });
    const freshness = withReportingCoverage(measurementFreshness({ measuredAt: now - 60_000, expectedIntervalMs: 120_000, nowMs: now }), coverage);
    expect(freshness.state).toBe("partial");
    expect(freshness.label).toBe("1 of 12 reporting");
    expect(freshness.detail).toMatch(/^1 of 12 pots have a current reading/);
    // All reporting: unchanged.
    expect(withReportingCoverage(measurementFreshness({ measuredAt: now, nowMs: now }), { reporting: 12, total: 12 }).state).toBe("current");
  });
});


describe("home experiment ordering", () => {
  it("places the current run first and keeps completed numbered runs together", () => {
    const make = (name: string, status: PortalExperiment["status"]): PortalExperiment => ({
      id: name, name, status, mode: "controlled", shortDescription: "", pairingNames: [], groupNames: [],
    });
    const runs = [make("SWC Saturation Calibration", "completed"), make("Matt Experiment 10", "completed"),
      make("Matt Experiment 2", "completed"), make("Huiqiao Pan experiment", "active"), make("Matt Experiment 1", "completed")];
    expect(orderHomeExperiments(runs).map(run => run.name)).toEqual([
      "Huiqiao Pan experiment", "Matt Experiment 1", "Matt Experiment 2", "Matt Experiment 10", "SWC Saturation Calibration",
    ]);
    expect(runs[0].name).toBe("SWC Saturation Calibration");
  });
});
