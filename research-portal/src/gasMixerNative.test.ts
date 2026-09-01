import { describe, expect, it } from "vitest";
import {
  applyGasMixerNativeField,
  formatGasMixerNativeValue,
  gasMixerNativeDisplayOrder,
  gasMixerNativeFieldSpec,
  initialGasMixerNativeState,
  normalizeGasMixerNativeValue,
} from "./gasMixerNative";

describe("native gas mixer contract", () => {
  it("matches the physical 3x2 controller layout", () => {
    expect(gasMixerNativeDisplayOrder).toEqual(["A", "C", "E", "B", "D", "F"]);
    const state = initialGasMixerNativeState();
    expect(state.channels.A).toMatchObject({ formula: "N2", balance: true, ratio: 100, flow_unit: "SLPM" });
    expect(state.channels.C).toMatchObject({ formula: "Ar", ratio_unit: "PPM", flow_unit: "SCCM" });
    expect(state.channels.D).toMatchObject({ formula: "CO2", ratio_unit: "PPM", flow_unit: "SCCM" });
  });

  it("uses the existing Qt field bounds and precision", () => {
    expect(gasMixerNativeFieldSpec("total_slpm")).toEqual({ min: 0, max: 9, decimals: 3, step: 0.001 });
    expect(gasMixerNativeFieldSpec("mfc.C.ratio")).toEqual({ min: 0, max: 99_999, decimals: 0, step: 1 });
    expect(gasMixerNativeFieldSpec("mfc.D.setpoint")).toEqual({ min: 0, max: 9_999, decimals: 2, step: 0.01 });
    expect(() => normalizeGasMixerNativeValue("mfc.B.ratio", 100.1)).toThrow();
    expect(() => gasMixerNativeFieldSpec("mfc.A.ratio" as never)).toThrow();
  });

  it("preserves the balance controller when a ratio changes", () => {
    let state = initialGasMixerNativeState();
    state = applyGasMixerNativeField(state, "total_slpm", 2);
    state = applyGasMixerNativeField(state, "mfc.B.ratio", 20);
    state = applyGasMixerNativeField(state, "mfc.D.ratio", 400);
    expect(state.channels.B.setpoint).toBe(0.4);
    expect(state.channels.D.setpoint).toBe(0.8);
    expect(state.channels.A.ratio).toBeCloseTo(79.96);
    expect(state.channels.A.setpoint).toBeCloseTo(1.5992);
  });

  it("converts SCCM setpoints back into PPM ratios", () => {
    let state = initialGasMixerNativeState();
    state = applyGasMixerNativeField(state, "total_slpm", 4);
    state = applyGasMixerNativeField(state, "mfc.D.setpoint", 1.6);
    expect(state.channels.D.ratio).toBeCloseTo(400);
    expect(formatGasMixerNativeValue(state.channels.D.ratio, "PPM")).toBe("400");
  });

  it("matches the Qt balance behavior when non-balance flows exceed total", () => {
    let state = initialGasMixerNativeState();
    state = applyGasMixerNativeField(state, "total_slpm", 1);
    state = applyGasMixerNativeField(state, "mfc.B.ratio", 80);
    state = applyGasMixerNativeField(state, "mfc.E.ratio", 40);
    expect(state.channels.B.setpoint).toBe(0);
    expect(state.channels.E.setpoint).toBe(0.4);
    expect(state.channels.A.setpoint).toBe(0.6);
    expect(() => applyGasMixerNativeField(state, "mfc.D.setpoint", 1_001)).toThrow("Setpoint exceeds total flow");
  });
});
