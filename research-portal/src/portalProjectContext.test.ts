import { describe, expect, it } from "vitest";
import { needsProjectDirectory, portalSystemName, projectDirectoryIds, scopedProjectDirectory, selectPortalAccessRow, selectProjectDevice } from "./portalProjectContext";

const rows = [
  { project_id: "project-a", role: "researcher", email: "a@example.com" },
  { project_id: "project-b", role: "admin", email: "b@example.com" },
];

describe("selectPortalAccessRow", () => {
  it("honors an authorized project requested in the URL", () => {
    expect(selectPortalAccessRow(rows, "project-b")?.project_id).toBe("project-b");
  });

  it("falls back to the first authorized project", () => {
    expect(selectPortalAccessRow(rows, "unknown")?.project_id).toBe("project-a");
    expect(selectPortalAccessRow(rows, null)?.project_id).toBe("project-a");
  });

  it("does not invent access", () => {
    expect(selectPortalAccessRow([], "project-b")).toBeNull();
  });
});

describe("selectProjectDevice", () => {
  it("uses the most recent device row supplied by the caller", () => {
    expect(selectProjectDevice([{ device_id: "device-new" }, { device_id: "device-old" }]))
      .toBe("device-new");
  });

  it("returns null for a project without a configured device", () => {
    expect(selectProjectDevice([])).toBeNull();
  });

  it("uses registration before the first controller observation", () => {
    expect(selectProjectDevice([], [{ id: "new-testbed" }])).toBe("new-testbed");
  });

  it("prefers observed configuration over a registration fallback", () => {
    expect(selectProjectDevice([{ device_id: "observed" }], [{ id: "registered" }])).toBe("observed");
  });
});

describe("project directory", () => {
  const access = [
    ...rows,
    { project_id: "observation", role: "admin", email: null, access_scope: "observe" },
    { project_id: "invalid-role", role: "owner", email: null, access_scope: "project" },
    rows[0],
  ];

  it("lists each valid project membership once and excludes observation-only scopes", () => {
    expect(projectDirectoryIds(access)).toEqual(["project-a", "project-b"]);
  });

  it("never lists a project without a matching portal membership", () => {
    expect(scopedProjectDirectory(access, [
      { id: "unrelated", name: "Private project" },
      { id: "project-b", name: " Four-pot testbed " },
      { id: "observation", name: "Observed machine" },
      { id: "project-a", name: "Existing system" },
    ])).toEqual([
      { id: "project-a", name: "Existing system" },
      { id: "project-b", name: "Four-pot testbed" },
    ]);
  });

  it("preserves the existing lab name without relabeling new systems", () => {
    expect(portalSystemName("22222222-2222-4222-8222-222222222222", "Matt Greenhouse")).toBe("Rhee Lab");
    expect(portalSystemName("new-project", "Jake's testbed")).toBe("Jake's testbed");
    expect(portalSystemName("new-project")).toBe("System");
  });

  it("avoids an extra lookup for the existing single-project home", () => {
    expect(needsProjectDirectory(["22222222-2222-4222-8222-222222222222"])).toBe(false);
    expect(needsProjectDirectory(["22222222-2222-4222-8222-222222222222", "new-project"])).toBe(true);
  });
});
