/**
 * Translate the public invite vocabulary into the two authorization models
 * used after acceptance. Unknown values fail closed.
 *
 * @param {unknown} role
 * @returns {{ projectMemberRole: string, portalRole: string } | null}
 */
export function acceptedInviteRoles(role) {
  if (role === "owner") {
    return { projectMemberRole: "owner", portalRole: "admin" };
  }
  if (role === "admin") {
    return { projectMemberRole: "admin", portalRole: "admin" };
  }
  if (role === "member") {
    return { projectMemberRole: "researcher", portalRole: "researcher" };
  }
  if (role === "viewer") {
    return { projectMemberRole: "viewer", portalRole: "viewer" };
  }
  return null;
}
