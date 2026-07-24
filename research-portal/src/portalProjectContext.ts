export type PortalAccessRow = {
  project_id: string;
  role: string;
  email: string | null;
  created_at?: string | null;
};

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

export function selectProjectDevice(rows: readonly ProjectDeviceRow[]) {
  return rows[0]?.device_id ?? null;
}
