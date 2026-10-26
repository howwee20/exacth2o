import { describe, expect, it } from "vitest";
import { customTimeWindow, presetTimeWindow } from "./timeRangePresets";

const day = 86_400_000;
const bounds = { startMs: 1_000_000, endMs: 1_000_000 + 400 * day };
describe("experiment time ranges", () => {
  it("shows the complete experiment by default", () => {
    expect(presetTimeWindow(bounds, null)).toEqual({ start: 0, end: 100 });
  });
  it("selects precisely 24 hours even on a year-long experiment", () => {
    const window = presetTimeWindow(bounds, 24);
    expect(window.start).toBeCloseTo(99.75);
    expect((window.end - window.start) / 100 * (bounds.endMs - bounds.startMs)).toBeCloseTo(day);
  });
  it("clamps long presets to short experiments", () => {
    expect(presetTimeWindow({ startMs: 0, endMs: day }, 336)).toEqual({ start: 0, end: 100 });
  });
  it("accepts custom dates only within the experiment", () => {
    expect(customTimeWindow(bounds, bounds.startMs + day, bounds.startMs + 2 * day)).toEqual({ start: .25, end: .5 });
    for (const range of [[NaN, bounds.endMs], [bounds.startMs, bounds.startMs], [0, bounds.endMs], [bounds.startMs, bounds.endMs + 1]]) {
      expect(customTimeWindow(bounds, range[0], range[1])).toBeNull();
    }
  });
});
