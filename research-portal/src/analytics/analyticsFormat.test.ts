import { describe, expect, it } from "vitest";
import { campaignUrl, formatChange, formatRange, formatShare, rateVital, shareNote, toCsv, utmValue } from "./analyticsFormat";

describe("analytics formatting", () => {
  it("shows counts beside percentages and flags small denominators", () => {
    expect(formatShare(3, 12)).toBe("3 of 12 (25%)");
    expect(formatShare(1, 40)).toBe("1 of 40 (2.5%)");
    expect(formatShare(0, 0)).toBe("0 of 0");
    expect(shareNote(12)).toBe("small sample");
    expect(shareNote(120)).toBeNull();
  });

  it("never reports infinite growth from a zero baseline or a pre-collection baseline", () => {
    expect(formatChange({ value: 5, previous: 0, change: null }).text).toBe("No comparison (previous period: 0)");
    expect(formatChange({ value: 0, previous: 0, change: null }).text).toBe("No change from 0");
    expect(formatChange({ value: 6, previous: 4, change: 0.5 }).text).toBe("+50% vs 4");
    expect(formatChange({ value: 6, previous: 4, change: 0.5, previousStart: "2026-09-08" }).text)
      .toBe("No comparison: previous period predates collection");
  });

  it("formats date ranges in calendar terms", () => {
    expect(formatRange("2026-10-01", "2026-10-07")).toBe("Oct 1 – Oct 7, 2026");
    expect(formatRange("2026-12-20", "2027-01-05")).toBe("Dec 20, 2026 – Jan 5, 2027");
  });

  it("rates Core Web Vitals at their published thresholds", () => {
    expect(rateVital("lcp", 2400)).toBe("good");
    expect(rateVital("inp", 350)).toBe("needs improvement");
    expect(rateVital("cls", 0.3)).toBe("poor");
    expect(rateVital("lcp", null)).toBeNull();
  });

  it("exports aggregate CSV safely", () => {
    expect(toCsv(["Source", "Sessions"], [["=HYPERLINK(\"x\")", 3], ["a, b", 2]]))
      .toBe("Source,Sessions\n\"'=HYPERLINK(\"\"x\"\")\",3\n\"a, b\",2");
  });

  it("builds tagged links only to site pages with clean campaign values", () => {
    expect(utmValue("  Fall Newsletter 2026! ")).toBe("fall-newsletter-2026");
    expect(campaignUrl({ page: "/applications", source: "Newsletter", medium: "Email", campaign: "Fall Trials" }))
      .toBe("https://exacth2o.com/applications?utm_source=newsletter&utm_medium=email&utm_campaign=fall-trials");
    expect(campaignUrl({ page: "https://evil.example/", source: "x", medium: "", campaign: "" }))
      .toBe("https://exacth2o.com/?utm_source=x");
  });
});
