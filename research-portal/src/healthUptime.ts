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
): RestartOutagePresentation {
  if (!evidenceKnown) {
    return {
      detail: "Not enough synchronized history to evaluate restarts or outages.",
      badge: "Not synced",
      badgeTone: "unknown",
    };
  }
  if (restartCount > 0) {
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
