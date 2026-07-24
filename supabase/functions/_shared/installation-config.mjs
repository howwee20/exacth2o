const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function publicIntakeProjectId(env) {
  const projectId = text(env.PUBLIC_INTAKE_PROJECT_ID, 80);
  return uuidPattern.test(projectId) ? projectId : null;
}

export function healthSyncInstallation(env) {
  const projectId = text(env.HEALTH_SYNC_PROJECT_ID, 80);
  const organizationId = text(env.HEALTH_SYNC_ORGANIZATION_ID, 80);
  const deviceId = text(env.HEALTH_SYNC_DEVICE_ID, 200);
  const deviceName = text(env.HEALTH_SYNC_DEVICE_NAME, 120);
  const ownerHealthBaseUrl = text(env.OWNER_HEALTH_BASE_URL, 500) ||
    (deviceId ? `https://${deviceId}.balena-devices.com/owner-health` : "");
  if (
    !uuidPattern.test(projectId) ||
    !uuidPattern.test(organizationId) ||
    !deviceId ||
    !deviceName ||
    !ownerHealthBaseUrl.startsWith("https://")
  ) {
    return null;
  }
  return {
    projectId,
    organizationId,
    deviceId,
    deviceName,
    ownerHealthBaseUrl: ownerHealthBaseUrl.replace(/\/+$/, ""),
  };
}
