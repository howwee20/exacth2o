import { describe, expect, it } from "vitest";
import {
  decimateForDisplay,
  gapThresholdMs,
  nearestIndexByTime,
  pointsInRange,
  prepareSeries,
  summarizeSeries,
  type TimedValue,
} from "./seriesStatistics";

const minute = 60_000;
const start = Date.UTC(2026, 9, 1, 12);

function regular(count: number, intervalMs: number, value: (index: number) => number): TimedValue[] {
  return Array.from({ length: count }, (_, index) => ({ timestampMs: start + index * intervalMs, value: value(index) }));
}

describe("prepareSeries", () => {
  it("sorts out-of-order input and gives order-independent summaries", () => {
    const points = regular(50, 10 * minute, (index) => 30 - index * 0.1 + (index % 7));
    const shuffled = points.slice().reverse();
    shuffled.splice(10, 0, ...shuffled.splice(30, 5));
    const prepared = prepareSeries(shuffled);
    expect(prepared.outOfOrderCount).toBeGreaterThan(0);
    expect(prepared.points.map((point) => point.timestampMs)).toEqual(points.map((point) => point.timestampMs));
    expect(summarizeSeries(prepared.points, { configuredIntervalMs: 10 * minute }))
      .toEqual(summarizeSeries(points, { configuredIntervalMs: 10 * minute }));
  });

  it("excludes invalid values instead of treating them as zero", () => {
    const prepared = prepareSeries([
      { timestampMs: start, value: 30 },
      { timestampMs: start + minute, value: Number.NaN },
      { timestampMs: Number.NaN, value: 25 },
      { timestampMs: start + 2 * minute, value: Number.POSITIVE_INFINITY },
      { timestampMs: start + 3 * minute, value: 28 },
    ]);
    expect(prepared.invalidCount).toBe(3);
    const summary = summarizeSeries(prepared.points);
    expect(summary.count).toBe(2);
    expect(summary.min?.value).toBe(28);
    expect(summary.mean).toBe(29);
  });

  it("collapses duplicate timestamps and reports conflicting values", () => {
    const prepared = prepareSeries([
      { timestampMs: start, value: 30 },
      { timestampMs: start, value: 30 },
      { timestampMs: start + minute, value: 29 },
      { timestampMs: start + minute, value: 31 },
    ]);
    expect(prepared.points).toHaveLength(2);
    expect(prepared.duplicateCount).toBe(1);
    expect(prepared.conflictingDuplicateCount).toBe(1);
    // The later point in input order wins, deterministically.
    expect(prepared.points[1].value).toBe(31);
  });
});

describe("summarizeSeries", () => {
  it("keeps extremes and sharp drops from very large series (well over 12,000 points)", () => {
    const points = regular(60_000, 20_000, (index) => 30 + Math.sin(index / 500));
    points[41_237] = { ...points[41_237], value: 55 };
    points[17_001] = { ...points[17_001], value: 4 };
    const summary = summarizeSeries(points, { configuredIntervalMs: 20_000 });
    expect(summary.count).toBe(60_000);
    expect(summary.max?.value).toBe(55);
    expect(summary.max?.timestampMs).toBe(points[41_237].timestampMs);
    expect(summary.min?.value).toBe(4);
    // A one-sample dip produces exactly one drop into it (the recovery is a rise).
    expect(summary.sharpDrops.count).toBe(2);
    expect(summary.missingEstimate).toBe(0);
  });

  it("estimates missing readings from the configured cadence, not a fixed interval", () => {
    // Five-minute cadence with one 40-minute outage: seven readings missing.
    const points = [
      ...regular(10, 5 * minute, () => 30),
      ...regular(10, 5 * minute, () => 29).map((point) => ({ ...point, timestampMs: point.timestampMs + 85 * minute })),
    ];
    const summary = summarizeSeries(points, { configuredIntervalMs: 5 * minute });
    expect(summary.cadence).toEqual({ intervalMs: 5 * minute, source: "configured" });
    expect(summary.gaps.count).toBe(1);
    expect(summary.gaps.longestMs).toBe(40 * minute);
    expect(summary.missingEstimate).toBe(7);
  });

  it("tolerates irregular sampling jitter without inventing missing readings", () => {
    const jitter = [0, 40_000, -35_000, 15_000, -20_000, 55_000, -50_000, 10_000];
    const points = regular(200, 10 * minute, (index) => 25 + (index % 3)).map((point, index) => ({
      ...point,
      timestampMs: point.timestampMs + jitter[index % jitter.length],
    }));
    const summary = summarizeSeries(prepareSeries(points).points, { configuredIntervalMs: 10 * minute });
    expect(summary.missingEstimate).toBe(0);
    expect(summary.gaps.count).toBe(0);
  });

  it("labels the cadence as observed or unknown when none is configured", () => {
    expect(summarizeSeries(regular(20, 3 * minute, () => 20)).cadence)
      .toEqual({ intervalMs: 3 * minute, source: "observed" });
    const twoPoints = summarizeSeries(regular(2, 3 * minute, () => 20));
    expect(twoPoints.cadence.source).toBe("unknown");
    expect(twoPoints.missingEstimate).toBeNull();
  });

  it("reports physically impossible values without hiding them", () => {
    const summary = summarizeSeries(regular(5, minute, (index) => [20, -3, 21, 104, 22][index]));
    expect(summary.outOfRangeCount).toBe(2);
    expect(summary.min?.value).toBe(-3);
    expect(summary.max?.value).toBe(104);
  });

  it("returns an empty summary rather than zeros when there are no readings", () => {
    const summary = summarizeSeries([], { configuredIntervalMs: 10 * minute });
    expect(summary.latest).toBeNull();
    expect(summary.mean).toBeNull();
    expect(summary.min).toBeNull();
  });
});

describe("decimateForDisplay", () => {
  it("never feeds statistics and keeps each bucket's extremes, including spikes", () => {
    const points = regular(50_000, 20_000, () => 30);
    points[23_456] = { ...points[23_456], value: 48 };
    points[23_457] = { ...points[23_457], value: 12 };
    const before = summarizeSeries(points);
    const segments = decimateForDisplay(points, {
      startMs: points[0].timestampMs,
      endMs: points[points.length - 1].timestampMs,
      buckets: 800,
      gapMs: gapThresholdMs(20_000),
    });
    const drawn = segments.flat();
    expect(drawn.length).toBeLessThanOrEqual(800 * 4);
    expect(drawn.some((point) => point.value === 48)).toBe(true);
    expect(drawn.some((point) => point.value === 12)).toBe(true);
    // Statistics are unchanged by drawing.
    expect(summarizeSeries(points)).toEqual(before);
  });

  it("breaks the line across outages", () => {
    const points = [
      ...regular(30, 10 * minute, () => 30),
      ...regular(30, 10 * minute, () => 31).map((point) => ({ ...point, timestampMs: point.timestampMs + 12 * 60 * minute })),
    ];
    const segments = decimateForDisplay(points, {
      startMs: points[0].timestampMs,
      endMs: points[points.length - 1].timestampMs,
      buckets: 400,
      gapMs: gapThresholdMs(10 * minute),
    });
    expect(segments).toHaveLength(2);
    expect(segments[0][segments[0].length - 1].value).toBe(30);
    expect(segments[1][0].value).toBe(31);
  });

  it("keeps every point when the series is already small", () => {
    const points = regular(12, minute, (index) => index);
    expect(decimateForDisplay(points, { startMs: start, endMs: start + 11 * minute, buckets: 500, gapMs: 10 * minute }).flat())
      .toEqual(points);
  });
});

describe("range helpers", () => {
  it("finds ranges and nearest points by binary search", () => {
    const points = regular(100, minute, (index) => index);
    expect(pointsInRange(points, start + 10 * minute, start + 12 * minute).map((point) => point.value)).toEqual([10, 11, 12]);
    expect(nearestIndexByTime(points, start + 10 * minute + 29_000)).toBe(10);
    expect(nearestIndexByTime(points, start + 10 * minute + 31_000)).toBe(11);
    expect(nearestIndexByTime(points, start - minute)).toBe(0);
    expect(nearestIndexByTime([], start)).toBe(-1);
  });
});
