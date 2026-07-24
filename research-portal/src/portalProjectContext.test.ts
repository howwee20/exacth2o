import { describe, expect, it } from "vitest";
import { selectPortalAccessRow, selectProjectDevice } from "./portalProjectContext";

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
});
