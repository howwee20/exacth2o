import { describe, expect, it } from "vitest";
import {
  lightingSourceLabel,
  lightingStatusIsFresh,
  type LightingNativeStatus,
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

  it("disables cached readiness after heartbeat loss", () => {
    const now = Date.parse("2026-09-09T21:00:00Z");
    const state = { bridge_ready: true, last_bridge_at: "2026-09-09T20:59:50Z" } as LightingNativeStatus;
    expect(lightingStatusIsFresh(state, now)).toBe(true);
    expect(lightingStatusIsFresh(state, now + 5_000)).toBe(false);
    expect(lightingStatusIsFresh({ ...state, bridge_ready: false }, now)).toBe(false);
    expect(lightingStatusIsFresh({ ...state, last_bridge_at: "invalid" }, now)).toBe(false);
    expect(lightingStatusIsFresh(null, now)).toBe(false);
  });

  it("keeps local and portal changes explicit", () => {
    expect(lightingSourceLabel("local")).toBe("Windows controller");
    expect(lightingSourceLabel("portal")).toBe("ExactH2O portal");
  });
});
