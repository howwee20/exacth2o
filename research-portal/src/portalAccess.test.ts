import { describe, expect, it } from "vitest";

import {
  hasExperimentSettingsAccess,
  hasProjectDataReadAccess,
  hasSalesSupportAccess,
  parsePortalRole,
} from "./portalAccess";

describe("portal role authorization", () => {
  it("requires separate inbox approval even for admins and respects demotion", () => {
    expect(hasSalesSupportAccess("admin", true)).toBe(true);
    for (const approval of [false, undefined, null, "true", 1]) {
      expect(hasSalesSupportAccess("admin", approval)).toBe(false);
    }
    for (const role of ["researcher", "viewer", null] as const) {
      expect(hasSalesSupportAccess(role, true)).toBe(false);
    }
    expect(hasProjectDataReadAccess("admin")).toBe(true);
    expect(hasExperimentSettingsAccess("admin")).toBe(true);
  });
  it("preserves every database portal role without widening unknown values", () => {
    expect(parsePortalRole("admin")).toBe("admin");
    expect(parsePortalRole("researcher")).toBe("researcher");
    expect(parsePortalRole("viewer")).toBe("viewer");
    expect(parsePortalRole("owner")).toBeNull();
    expect(parsePortalRole("member")).toBeNull();
    expect(parsePortalRole(null)).toBeNull();
  });

  it("keeps viewer access read-only while preserving researcher settings", () => {
    expect(hasExperimentSettingsAccess("admin")).toBe(true);
    expect(hasExperimentSettingsAccess("researcher")).toBe(true);
    expect(hasExperimentSettingsAccess("viewer")).toBe(false);
    expect(hasExperimentSettingsAccess(null)).toBe(false);
  });

  it("allows every portal member to read project data without widening anonymous access", () => {
    expect(hasProjectDataReadAccess("admin")).toBe(true);
    expect(hasProjectDataReadAccess("researcher")).toBe(true);
    expect(hasProjectDataReadAccess("viewer")).toBe(true);
    expect(hasProjectDataReadAccess(null)).toBe(false);
  });
});
