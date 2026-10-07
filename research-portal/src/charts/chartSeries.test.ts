import { describe, expect, it } from "vitest";
import { type ChartSeries } from "../portalTypes";
import { compareGroup } from "./chartSeries";

const hour = 3_600_000;
const end = Date.parse("2026-10-07T16:00:00Z");

function pot(name: string, lastAt: number, value: number): ChartSeries {
  const points = Array.from({ length: 6 }, (_, index) => ({ timestampMs: lastAt - (5 - index) * 120_000, value }));
  return { name, points, rawPointCount: points.length, expectedIntervalMs: 120_000 } as unknown as ChartSeries;
}

describe("compareGroup", () => {
  it("leaves pots that stopped reporting out of the latest snapshot and counts them", () => {
    const comparison = compareGroup([
      pot("Pot 1", end, 30),
      pot("Pot 2", end - 60_000, 32),
      // Silent for 60 hours: its last value is not a current reading.
      pot("Pot 3", end - 60 * hour, 12),
    ]);
    expect(comparison.reportingCount).toBe(2);
    expect(comparison.silentCount).toBe(1);
    expect(comparison.latestMedian).toBe(31);
    expect(comparison.latestMin).toBe(30);
    // The window mean still uses every reading in the window.
    expect(comparison.windowMean).toBeCloseTo((30 * 6 + 32 * 6 + 12 * 6) / 18);
  });

  it("keeps a briefly delayed pot in the snapshot", () => {
    const comparison = compareGroup([pot("Pot 1", end, 30), pot("Pot 2", end - 20 * 60_000, 28)]);
    expect(comparison.silentCount).toBe(0);
    expect(comparison.latestMedian).toBe(29);
  });
});
