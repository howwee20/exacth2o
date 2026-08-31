export const gasMixerSessionTtlSeconds = 300;

export function normalizeSessionMode(value) {
  if (value === undefined || value === null || value === "view") return "view";
  if (value === "control") return "control";
  throw new Error("Session mode must be view or control");
}

export function capabilityForSessionMode(mode) {
  return normalizeSessionMode(mode) === "control"
    ? "remote_control"
    : "remote_view";
}

export function deviceIsReady(status, nowMs = Date.now()) {
  if (
    !status?.connected || !status?.local_session_available ||
    !status?.last_heartbeat_at
  ) {
    return false;
  }
  const heartbeatMs = Date.parse(status.last_heartbeat_at);
  return Number.isFinite(heartbeatMs) && heartbeatMs >= nowMs - 45_000;
}

export function sessionExpiresAt(nowMs = Date.now()) {
  return new Date(nowMs + gasMixerSessionTtlSeconds * 1000).toISOString();
}
