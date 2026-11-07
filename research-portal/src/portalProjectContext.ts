import { parsePortalRole } from "./portalAccess";

const rheeProjectId = "22222222-2222-4222-8222-222222222222";

export type PortalAccessRow = {
  project_id: string;
  role: string;
  access_scope?: string;
  email: string | null;
  created_at?: string | null;
};

export type PortalProjectSummary = { id: string; name: string };

export function portalSystemName(projectId: string, projectName?: string | null) {
  if (projectId === rheeProjectId) return "Rhee Lab";
  return projectName?.trim() || "System";
}

export function projectDirectoryIds(rows: readonly PortalAccessRow[]) {
  return [...new Set(rows.filter(row =>
    parsePortalRole(row.role) && (row.access_scope === undefined || row.access_scope === "project"),
  ).map(row => row.project_id))];
}

export function needsProjectDirectory(projectIds: readonly string[]) {
  return projectIds.some(id => id !== rheeProjectId);
}

/** Ignore rows outside this user's project-scoped portal memberships. */
export function scopedProjectDirectory(
  accessRows: readonly PortalAccessRow[],
  projects: readonly PortalProjectSummary[],
) {
  const byId = new Map(projects.map(project => [project.id, project]));
  return projectDirectoryIds(accessRows).flatMap(id => {
    const project = byId.get(id);
    return project ? [{ id, name: portalSystemName(id, project.name) }] : [];
  });
}

export function selectPortalAccessRow(
  rows: readonly PortalAccessRow[],
  requestedProjectId: string | null,
) {
  if (requestedProjectId) {
    const requested = rows.find((row) => row.project_id === requestedProjectId);
    if (requested) return requested;
  }
  return rows[0] ?? null;
}

export type ProjectDeviceRow = {
  device_id: string;
  updated_at?: string | null;
};

export function selectProjectDevice(
  rows: readonly ProjectDeviceRow[],
  registeredDevices: readonly { id: string }[] = [],
) {
  return rows[0]?.device_id ?? registeredDevices[0]?.id ?? null;
}
