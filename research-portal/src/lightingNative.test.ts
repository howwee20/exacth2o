import { describe, expect, it } from "vitest";
import {
  lightingSourceLabel,
  normalizeLightingIntensity,
} from "./lightingNative";

describe("lighting native contract", () => {
  it("matches the Windows maintenance control range", () => {
    expect(normalizeLightingIntensity(0)).toBe(0);
    expect(normalizeLightingIntensity(10)).toBe(10);
    expect(normalizeLightingIntensity("255")).toBe(255);
    expect(() => normalizeLightingIntensity(9)).toThrow();
    expect(() => normalizeLightingIntensity(256)).toThrow();
    expect(() => normalizeLightingIntensity(10.5)).toThrow();
  });

  it("keeps local and portal changes explicit", () => {
    expect(lightingSourceLabel("local")).toBe("Windows controller");
    expect(lightingSourceLabel("portal")).toBe("ExactH2O portal");
  });
});
