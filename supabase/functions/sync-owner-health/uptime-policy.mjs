function finiteNonnegativeNumber(value) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function uptimeSecondsFromSources(status, health = {}) {
  const source = status && typeof status === "object" && !Array.isArray(status) ? status : {};
  const healthSource = record(health);
  const ownerStatus = record(healthSource.ownerStatus);
  const host = record(source.host);
  const system = record(source.system);

  return finiteNonnegativeNumber(source.uptime_seconds) ??
    finiteNonnegativeNumber(source.current_uptime_seconds) ??
    finiteNonnegativeNumber(ownerStatus.uptime_seconds) ??
    finiteNonnegativeNumber(ownerStatus.current_uptime_seconds) ??
    finiteNonnegativeNumber(healthSource.uptime_seconds) ??
    finiteNonnegativeNumber(healthSource.current_uptime_seconds) ??
    finiteNonnegativeNumber(host.uptime_seconds) ??
    finiteNonnegativeNumber(system.uptime_seconds);
}
