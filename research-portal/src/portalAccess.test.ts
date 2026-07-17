import { describe, expect, it } from "vitest";

import {
  hasExperimentSettingsAccess,
  hasProjectDataReadAccess,
  hasRdSystemAdminAccess,
  parsePortalRole,
} from "./portalAccess";

describe("portal role authorization", () => {
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

  it("requires both the admin role and the explicit R&D allowlist", () => {
    expect(hasRdSystemAdminAccess("admin", true)).toBe(true);
    expect(hasRdSystemAdminAccess("admin", false)).toBe(false);
    expect(hasRdSystemAdminAccess("researcher", true)).toBe(false);
    expect(hasRdSystemAdminAccess("viewer", true)).toBe(false);
  });
});
