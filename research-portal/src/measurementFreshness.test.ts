import { describe, expect, it } from "vitest";
import {
  formatMeasurementTime,
  measurementFreshness,
  worstFreshness,
} from "./measurementFreshness";

const now = Date.parse("2026-10-07T16:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("measurementFreshness", () => {
  it("judges age against the configured cadence", () => {
    const tenMinutes = 10 * 60_000;
    expect(measurementFreshness({ measuredAt: minutesAgo(12), expectedIntervalMs: tenMinutes, nowMs: now }).state).toBe("current");
    expect(measurementFreshness({ measuredAt: minutesAgo(40), expectedIntervalMs: tenMinutes, nowMs: now }).state).toBe("delayed");
    expect(measurementFreshness({ measuredAt: minutesAgo(90), expectedIntervalMs: tenMinutes, nowMs: now }).state).toBe("stale");
    // A one-minute cadence makes the same 40-minute-old reading stale.
    expect(measurementFreshness({ measuredAt: minutesAgo(40), expectedIntervalMs: 60_000, nowMs: now }).state).toBe("stale");
  });

  it("uses labelled fallback thresholds when the cadence is unknown", () => {
    const result = measurementFreshness({ measuredAt: minutesAgo(20), nowMs: now });
    expect(result.state).toBe("delayed");
    expect(result.expectedIntervalMs).toBeNull();
    expect(result.detail).toContain("cadence unknown");
  });

  it("never calls a three-week-old reading live, whatever the data source", () => {
    const result = measurementFreshness({ measuredAt: "2026-09-16T19:23:00Z", expectedIntervalMs: 600_000, nowMs: now });
    expect(result.state).toBe("stale");
    expect(result.label).toBe("Stale");
    expect(result.detail).toContain("21 days");
  });

  it("reports offline only from controller presence, never from age alone", () => {
    expect(measurementFreshness({ measuredAt: minutesAgo(90), expectedIntervalMs: 600_000, nowMs: now }).state).toBe("stale");
    expect(measurementFreshness({ measuredAt: minutesAgo(90), expectedIntervalMs: 600_000, controllerOffline: true, nowMs: now }).state)
      .toBe("offline");
    // A current reading stays current even if presence data is behind.
    expect(measurementFreshness({ measuredAt: minutesAgo(3), expectedIntervalMs: 600_000, controllerOffline: true, nowMs: now }).state)
      .toBe("current");
  });

  it("treats completed experiments as historical and missing data as unknown", () => {
    expect(measurementFreshness({ measuredAt: minutesAgo(9000), completed: true, nowMs: now }).state).toBe("historical");
    const none = measurementFreshness({ measuredAt: null, nowMs: now });
    expect(none.state).toBe("unknown");
    expect(none.ageMs).toBeNull();
    expect(measurementFreshness({ measuredAt: "not a date", nowMs: now }).state).toBe("unknown");
  });

  it("flags device clocks far in the future instead of calling them current", () => {
    const result = measurementFreshness({ measuredAt: new Date(now + 3_600_000).toISOString(), nowMs: now });
    expect(result.state).toBe("unknown");
    expect(result.label).toBe("Clock mismatch");
  });

  it("chooses the most conservative of several judgements", () => {
    const server = measurementFreshness({ measuredAt: minutesAgo(1), nowMs: now });
    const client = measurementFreshness({ measuredAt: minutesAgo(500), nowMs: now });
    expect(worstFreshness([server, client])?.state).toBe("stale");
  });
});

describe("formatMeasurementTime", () => {
  it("always names the time zone, including across daylight-saving changes", () => {
    expect(formatMeasurementTime("2026-10-07T19:23:00Z", { timeZone: "America/Detroit" })).toBe("Oct 7, 3:23 PM EDT");
    expect(formatMeasurementTime("2026-11-02T19:23:00Z", { timeZone: "America/Detroit" })).toBe("Nov 2, 2:23 PM EST");
    expect(formatMeasurementTime(null)).toBeNull();
  });
});
