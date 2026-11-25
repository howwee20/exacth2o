import { describe, expect, it } from "vitest";
import { analyze, controllerLibrary, emptyWorksheet, evaluateCurve, sameCurve, sameStoredCurve, sampleMean } from "./model";

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

describe("recognising a saved curve after a lost save response", () => {
  it("treats the API's 15-digit copy of a fitted curve as the same curve", () => {
    // Audit 2026-11-25: the fit 162.31590641370653 − 0.18560196136644413x came back as 162.315906413707 − 0.185601961366444x,
    // so a retry after a dropped response said the name was taken instead of confirming the save.
    const fitted = [162.31590641370653, -0.18560196136644413];
    const stored = fitted.map((value) => Number(value.toPrecision(15)));
    expect(sameCurve(stored, fitted)).toBe(false);
    expect(sameStoredCurve(stored, fitted)).toBe(true);
  });
  it("still rejects a different curve saved under the same name", () => {
    expect(sameStoredCurve([162.3159, -0.1856], [162.31590641370653, -0.18560196136644413])).toBe(false);
    expect(sameStoredCurve([1, 2, 0], [1, 2])).toBe(true);
    expect(sameStoredCurve([1, 2, 3], [1, 2])).toBe(false);
  });
});
