export type PortalRole = "admin" | "researcher" | "viewer";

export function parsePortalRole(value: unknown): PortalRole | null {
  if (value === "admin" || value === "researcher" || value === "viewer") return value;
  return null;
}

export function hasExperimentSettingsAccess(role: PortalRole | null | undefined) {
  return role === "admin" || role === "researcher";
}

export function hasProjectDataReadAccess(role: PortalRole | null | undefined) {
  return role === "admin" || role === "researcher" || role === "viewer";
}

export function hasRdSystemAdminAccess(
  role: PortalRole | null | undefined,
  explicitlyAllowed: boolean,
) {
  return role === "admin" && explicitlyAllowed;
}
