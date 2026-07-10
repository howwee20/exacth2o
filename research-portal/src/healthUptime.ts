type UptimeHistoryRecord = Record<string, unknown> & {
  t?: unknown;
  uptimeSeconds?: unknown;
};

function finiteNonnegativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fills missing uptime samples from the current boot timestamp.
 *
 * This does not extrapolate across a restart: rows before the current boot or
 * after the observation that established the boot timestamp remain unknown.
 * Explicitly observed uptime values always win.
 */
export function reconstructCurrentBootUptime<T extends UptimeHistoryRecord>(
  records: T[],
  currentUptimeSeconds: unknown,
  observedAt: unknown,
): T[] {
  const currentUptime = finiteNonnegativeNumber(currentUptimeSeconds);
  const observedAtMs = timestampMs(observedAt);
  if (currentUptime == null || observedAtMs == null) return records;

  const bootAtMs = observedAtMs - currentUptime * 1000;
  return records.map((record) => {
    if (finiteNonnegativeNumber(record.uptimeSeconds) != null) return record;
    const recordAtMs = timestampMs(record.t);
    if (recordAtMs == null || recordAtMs < bootAtMs || recordAtMs > observedAtMs) return record;
    return {
      ...record,
      uptimeSeconds: Math.max(0, (recordAtMs - bootAtMs) / 1000),
    };
  });
}

/**
 * Advances a synchronized uptime observation using the browser clock.
 *
 * Callers must only use the result while the source observation is still
 * fresh. This keeps the visible uptime moving between controller publishes
 * without pretending that an expired device observation is current.
 */
export function advanceCurrentBootUptime(
  uptimeSeconds: unknown,
  observedAt: unknown,
  now: unknown,
): number | null {
  const uptime = finiteNonnegativeNumber(uptimeSeconds);
  const observedAtMs = timestampMs(observedAt);
  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : timestampMs(now);
  if (uptime == null || observedAtMs == null || nowMs == null) return uptime;
  return uptime + Math.max(0, nowMs - observedAtMs) / 1000;
}

export type RestartOutagePresentation = {
  detail: string;
  badge: "Not synced" | "Review" | "Recovered" | "Stable";
  badgeTone: "ok" | "warning" | "unknown";
};

/**
 * Summarizes restart/outage evidence without presenting a resolved monitoring
 * gap as an active incident. Restarts still require review; a gap with newer
 * synchronized evidence is historical and therefore recovered.
 */
export function restartOutagePresentation(
  evidenceKnown: boolean,
  restartCount: number,
  gapCount: number,
  reportingHealthy = false,
): RestartOutagePresentation {
  if (!evidenceKnown) {
    return {
      detail: "Not enough synchronized history to evaluate restarts or outages.",
      badge: "Not synced",
      badgeTone: "unknown",
    };
  }
  if (restartCount > 0) {
    if (reportingHealthy) {
      return {
        detail: "Restart recorded; telemetry recovered and the controller is reporting again.",
        badge: "Recovered",
        badgeTone: "ok",
      };
    }
    return {
      detail: "Restart detected in the synchronized window.",
      badge: "Review",
      badgeTone: "warning",
    };
  }
  if (gapCount > 0) {
    return {
      detail: "Monitoring gap recovered; the controller is reporting again.",
      badge: "Recovered",
      badgeTone: "ok",
    };
  }
  return {
    detail: "No reset or outage in the synchronized window.",
    badge: "Stable",
    badgeTone: "ok",
  };
}
