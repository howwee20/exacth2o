import { describe, expect, it } from "vitest";

import {
  interpolateOverlayValue,
  overlayTimeBounds,
  partitionOverlayMarkers,
} from "./wateringOverlay";

describe("watering overlay time alignment", () => {
  it("uses the exact VWC chart window for event positioning", () => {
    expect(overlayTimeBounds(
      { startMs: 1_000, endMs: 11_000 },
      { start: 20, end: 70 },
    )).toEqual({ startMs: 3_000, endMs: 8_000 });
  });

  it("returns an exact sensor value when watering and sensing share a timestamp", () => {
    const points = [
      { timestampMs: 1_000, value: 20 },
      { timestampMs: 2_000, value: 24 },
    ];
    expect(interpolateOverlayValue(points, 2_000, 30_000)).toMatchObject({
      value: 24,
      exact: true,
    });
  });

  it("places a watering marker on the displayed line between nearby samples", () => {
    const points = [
      { timestampMs: 0, value: 18 },
      { timestampMs: 10 * 60_000, value: 22 },
    ];
    expect(interpolateOverlayValue(points, 5 * 60_000, 30 * 60_000)).toMatchObject({
      value: 20,
      exact: false,
      before: points[0],
      after: points[1],
    });
  });

  it("refuses to invent VWC across a large sensor-data gap", () => {
    const points = [
      { timestampMs: 0, value: 18 },
      { timestampMs: 60 * 60_000, value: 22 },
    ];
    expect(interpolateOverlayValue(points, 30 * 60_000, 30 * 60_000)).toBeNull();
  });

  it("keeps unmatched watering events out of the VWC plot and counts them", () => {
    const markers = [
      { id: "visible", value: 20.4 },
      { id: "missing-before", value: null },
      { id: "missing-after", value: null },
    ];

    expect(partitionOverlayMarkers(markers)).toEqual({
      visible: [{ id: "visible", value: 20.4 }],
      omittedCount: 2,
    });
  });
});
