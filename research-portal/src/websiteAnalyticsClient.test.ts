import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));
const { preferReport, ReportCache, reportKey } = await import("./websiteAnalyticsClient");
type Envelope = import("./websiteAnalyticsClient").ReportEnvelope<unknown>;

const ready = (updatedAt: string): Envelope => ({ status: "ready", report: "overview", updatedAt });
const answer = (status: Envelope["status"]): Envelope => ({ status, report: "overview" });

describe("website analytics client", () => {
  it("never replaces a stored report with an empty or older answer", () => {
    const stored = ready("2026-10-07T16:05:00Z");
    // Another request held the refresh lease: no rows were stored yet when this answer was made.
    expect(preferReport(stored, answer("collecting"))).toBe(stored);
    expect(preferReport(stored, answer("unavailable"))).toBe(stored);
    expect(preferReport(stored, ready("2026-10-07T16:00:00Z"))).toBe(stored);
    const newer = ready("2026-10-07T16:10:00Z");
    expect(preferReport(stored, newer)).toBe(newer);
    const collecting = answer("collecting");
    expect(preferReport(collecting, stored)).toBe(stored);
    expect(preferReport(null, collecting)).toBe(collecting);
  });

  it("keys reports by name, range and device, and expires cached answers", () => {
    expect(reportKey("overview", { preset: "7d" }, "all")).not.toBe(reportKey("overview", { preset: "7d" }, "mobile"));
    const cache = new ReportCache(2, 60_000);
    cache.set("a", ready("x"), 0);
    expect(cache.get("a", 30_000)).not.toBeNull();
    expect(cache.get("a", 61_000)).toBeNull();
    expect(cache.peek("a")).not.toBeNull();
    cache.set("b", ready("x"), 0);
    cache.set("c", ready("x"), 0);
    expect(cache.size).toBe(2);
  });
});
