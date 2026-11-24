import { describe, expect, it } from "vitest";
import { analyze, controllerLibrary, emptyWorksheet, evaluateCurve, sameCurve, sampleMean } from "./model";

describe("soil bench curves", () => {
  it("uses every selected probe including real zeroes, and never fills missing readings with zero", () => {
    const sheet = emptyWorksheet();
    sheet.probes = ["A", "B"];
    sheet.rows[0].cells = { A: { value: "0" }, B: { value: "2" } };
    expect(sampleMean(sheet.rows[0], sheet.probes)).toBe(1);
    delete sheet.rows[0].cells.B;
    expect(analyze(sheet).error).toContain("all selected probes");
  });
  it("recovers coefficients in raw controller units on a scaled cubic", () => {
    const sheet = emptyWorksheet();
    sheet.probes = ["A", "B"];
    sheet.mode = "cubic";
    sheet.rows = [200, 260, 330, 415, 510, 590].map((x, i) => ({
      id: String(i),
      vwc: String(5 + x * 0.02 + x * x * 0.0001 + x ** 3 * 0.0000001),
      cells: { A: { value: String(x - 2) }, B: { value: String(x + 2) } },
    }));
    const fit = analyze(sheet);
    expect(fit.error).toBe("");
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(evaluateCurve(fit.coefficients, 410)).toBeCloseTo(
      5 + 410 * 0.02 + 410 ** 2 * 0.0001 + 410 ** 3 * 0.0000001,
      10,
    );
    sheet.rows.forEach((row) => (row.cells = { A: { value: "2" }, B: { value: "2" } }));
    expect(analyze(sheet).error).toContain("distinct");
  });
  it("publishes a known manual curve without requiring bench observations", () => {
    const sheet = emptyWorksheet();
    sheet.mode = "manual";
    sheet.manual = ["-2", ".7", "0", "", "", ""];
    expect(analyze(sheet).coefficients).toEqual([-2, 0.7]);
    expect(sameCurve([-2, 0.7], [-2, 0.7, 0])).toBe(true);
    expect(
      controllerLibrary([{ name: "Peat", polynomialCoefficientsCommaDelimited: "-2,.7,0" }]).get("Peat"),
    ).toEqual([-2, 0.7, 0]);
  });
});
