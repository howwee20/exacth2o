const defaultRefreshIntervalMs = 15 * 60 * 1000;

/**
 * @param {{
 *   lastConfigUpdatedAtMs: number,
 *   lastAttemptCompletedAtMs: number,
 *   nowMs: number,
 *   intervalMs?: number,
 * }} input
 */
export function configRefreshDue(input) {
  const latestCheckpoint = Math.max(
    Number.isFinite(input.lastConfigUpdatedAtMs) ? input.lastConfigUpdatedAtMs : Number.NEGATIVE_INFINITY,
    Number.isFinite(input.lastAttemptCompletedAtMs) ? input.lastAttemptCompletedAtMs : Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestCheckpoint)) return true;

  const safeInterval = Number.isFinite(input.intervalMs)
    ? Math.max(60_000, Number(input.intervalMs))
    : defaultRefreshIntervalMs;
  return input.nowMs - latestCheckpoint >= safeInterval;
}

/**
 * Automatic watchdog refreshes preserve the last known config when optional
 * controller config routes are unavailable. Explicit config requests still
 * fail closed so an operator cannot mistake a stale mirror for a completed
 * refresh.
 *
 * @param {{ includeConfig: unknown, required: unknown, writeAttempted: unknown, writeOk: unknown, previousConfigUsable: unknown }} input
 * @returns {{ error: string | null, warning: string | null }}
 */
export function configRefreshOutcome(input) {
  if (input.includeConfig !== true || input.writeOk === true) {
    return { error: null, warning: null };
  }
  if (input.required === true || input.writeAttempted === true || input.previousConfigUsable !== true) {
    return { error: "config_state", warning: null };
  }
  return { error: null, warning: "config_state_preserved" };
}
