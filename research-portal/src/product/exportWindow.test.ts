import { describe, expect, it, vi } from "vitest";
vi.mock("../supabase", () => ({ supabase: {} }));
import { minuteInputEnd } from "./ExperimentExport";

describe("export custom range end", () => {
  it("keeps a reading taken partway through the last minute of the chart window", () => {
    // Audit 2026-11-25: the chart window ended at the newest reading (17:20:46); the export end became 17:20
    // and the default export held 0 of 4 readings.
    const end = Date.parse("2026-11-25T17:20:46.389Z");
    expect(minuteInputEnd(end)).toBe("2026-11-25T17:21");
    expect(Date.parse(minuteInputEnd(end) + "Z")).toBeGreaterThanOrEqual(end);
    expect(minuteInputEnd(Date.parse("2026-11-25T17:20:00Z"))).toBe("2026-11-25T17:20");
  });
});
