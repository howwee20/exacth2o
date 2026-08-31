import { describe, expect, it } from "vitest";
import {
  gasMixerAccessDenied,
  gasMixerSessionRenewalDelay,
  normalizedMixerPoint,
} from "./chamberControl";

describe("gas mixer portal presentation", () => {
  it("fails closed when installation access is denied", () => {
    expect(gasMixerAccessDenied({ code: "42501" })).toBe(true);
    expect(gasMixerAccessDenied({ message: "System-admin installation access is required" })).toBe(true);
    expect(gasMixerAccessDenied({ message: "network error" })).toBe(false);
  });

  it("maps portal taps to normalized mixer coordinates", () => {
    expect(normalizedMixerPoint(150, 75, { left: 50, top: 25, width: 200, height: 100 }))
      .toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedMixerPoint(-10, 500, { left: 0, top: 0, width: 100, height: 100 }))
      .toEqual({ x: 0, y: 1 });
  });

  it("renews short server leases before they expire", () => {
    const now = Date.parse("2026-08-31T21:00:00.000Z");
    expect(gasMixerSessionRenewalDelay("2026-08-31T21:05:00.000Z", now))
      .toBe(240_000);
    expect(gasMixerSessionRenewalDelay("2026-08-31T21:00:10.000Z", now))
      .toBe(1_000);
    expect(gasMixerSessionRenewalDelay("invalid", now)).toBe(1_000);
  });
});
