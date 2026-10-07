/**
 * One definition of "how current is this measurement" for every tile, chart,
 * tooltip, table and health view.
 *
 * Freshness is always derived from the measurement's own timestamp
 * (device_recorded_at) and the cadence the sensor is configured to report at.
 * The time the portal last fetched data is reported separately and never makes
 * an old measurement look current. A failed browser request is not evidence
 * that a device is offline; only controller presence data can say that.
 */

export type FreshnessState =
  | "current"
  /** The newest reading is current, but not every pot in the experiment is reporting. */
  | "partial"
  | "delayed"
  | "stale"
  | "offline"
  | "historical"
  | "unknown";

export type FreshnessTone = "ok" | "warning" | "bad" | "info" | "unknown";

export type FreshnessInput = {
  /** Timestamp of the newest valid measurement (device clock). */
  measuredAt: string | number | null | undefined;
  /** Configured reporting interval, when known. */
  expectedIntervalMs?: number | null;
  /** The experiment has ended; its readings are a historical record. */
  completed?: boolean;
  /** Controller presence data (not a browser request) says the controller is offline. */
  controllerOffline?: boolean;
  nowMs?: number;
};

export type Freshness = {
  state: FreshnessState;
  tone: FreshnessTone;
  /** Short status word for pills. */
  label: string;
  /** Sentence describing the measurement age and the expectation it was judged against. */
  detail: string;
  measuredAtMs: number | null;
  ageMs: number | null;
  /** Cadence used for the judgement; null when the fallback thresholds were used. */
  expectedIntervalMs: number | null;
};

/** Allowance for upload and ingestion after the device records a reading. */
export const ingestGraceMs = 2 * 60_000;
/**
 * Small negative ages are normal: the page clock advances every 30 seconds while readings arrive
 * in real time, and device and browser clocks differ by seconds. Only beyond this is a reading
 * "in the future".
 */
export const clockToleranceMs = 5 * 60_000;
/** Fallback thresholds when the configured cadence is unknown. */
export const unknownCadenceCurrentMs = 15 * 60_000;
export const unknownCadenceDelayedMs = 60 * 60_000;

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export function parseTimestampMs(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validated configured cadence in milliseconds, or null when it is missing or implausible. */
export function validCadenceMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  // Controllers report between every few seconds and once per day.
  if (value < 1_000 || value > dayMs) return null;
  return value;
}

export function freshnessThresholds(expectedIntervalMs?: number | null) {
  const cadence = validCadenceMs(expectedIntervalMs);
  if (cadence == null) {
    return { currentMs: unknownCadenceCurrentMs, delayedMs: unknownCadenceDelayedMs, cadence: null };
  }
  return {
    // One missed report is tolerated before a reading stops being current.
    currentMs: Math.max(cadence * 2, 5 * minuteMs) + ingestGraceMs,
    // Up to five missed reports is delayed; beyond that the reading is stale.
    delayedMs: Math.max(cadence * 6, 30 * minuteMs) + ingestGraceMs,
    cadence,
  };
}

/** "45 sec", "12 min", "3 hr", "4 days" */
export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.round(hours / 24)} days`;
}

export function formatAge(ageMs: number | null) {
  if (ageMs == null) return null;
  if (ageMs < -clockToleranceMs) return "in the future (device clock ahead)";
  if (ageMs < 60_000) return "just now";
  return `${formatDuration(ageMs)} ago`;
}

export function formatCadence(intervalMs: number | null | undefined) {
  const cadence = validCadenceMs(intervalMs);
  if (cadence == null) return null;
  if (cadence < 60_000) return `every ${Math.round(cadence / 1000)} sec`;
  const minutes = cadence / 60_000;
  return `every ${Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(1))} min`;
}

export function measurementFreshness(input: FreshnessInput): Freshness {
  const nowMs = input.nowMs ?? Date.now();
  const measuredAtMs = parseTimestampMs(input.measuredAt);
  const { currentMs, delayedMs, cadence } = freshnessThresholds(input.expectedIntervalMs);
  const expectation = cadence == null ? "reporting cadence unknown" : `expected ${formatCadence(cadence)}`;

  if (measuredAtMs == null) {
    return {
      state: input.completed ? "historical" : "unknown",
      tone: input.completed ? "info" : "unknown",
      label: input.completed ? "Completed" : "No readings",
      detail: input.completed ? "Experiment completed; no readings are loaded." : "No valid readings have been loaded.",
      measuredAtMs: null,
      ageMs: null,
      expectedIntervalMs: cadence,
    };
  }

  const ageMs = nowMs - measuredAtMs;
  const age = formatAge(ageMs);

  if (input.completed) {
    return {
      state: "historical",
      tone: "info",
      label: "Completed",
      detail: `Experiment completed; last reading ${age}.`,
      measuredAtMs,
      ageMs,
      expectedIntervalMs: cadence,
    };
  }

  // A device clock well ahead of the browser cannot be judged current.
  if (ageMs < -clockToleranceMs) {
    return {
      state: "unknown",
      tone: "warning",
      label: "Clock mismatch",
      detail: `The newest reading is timestamped ${formatDuration(-ageMs)} in the future; check the controller clock.`,
      measuredAtMs,
      ageMs,
      expectedIntervalMs: cadence,
    };
  }

  if (ageMs <= currentMs) {
    return {
      state: "current",
      tone: "ok",
      label: "Current",
      detail: `Latest reading ${age} (${expectation}).`,
      measuredAtMs,
      ageMs,
      expectedIntervalMs: cadence,
    };
  }

  if (input.controllerOffline) {
    return {
      state: "offline",
      tone: "bad",
      label: "Controller offline",
      detail: `Controller is offline; latest reading ${age}.`,
      measuredAtMs,
      ageMs,
      expectedIntervalMs: cadence,
    };
  }

  if (ageMs <= delayedMs) {
    return {
      state: "delayed",
      tone: "warning",
      label: "Delayed",
      detail: `Latest reading ${age} (${expectation}).`,
      measuredAtMs,
      ageMs,
      expectedIntervalMs: cadence,
    };
  }

  return {
    state: "stale",
    tone: "bad",
    label: "Stale",
    detail: `No new reading for ${formatDuration(ageMs)} (${expectation}).`,
    measuredAtMs,
    ageMs,
    expectedIntervalMs: cadence,
  };
}

/** The most conservative of several freshness judgements (e.g. server and client). */
export function worstFreshness(items: Freshness[]): Freshness | null {
  const rank: Record<FreshnessState, number> = {
    current: 0,
    historical: 1,
    partial: 2,
    delayed: 2,
    unknown: 3,
    stale: 4,
    offline: 5,
  };
  return items.reduce<Freshness | null>(
    (worst, item) => (!worst || rank[item.state] > rank[worst.state] ? item : worst),
    null,
  );
}

/**
 * Absolute timestamp with an explicit time zone, e.g. "Oct 7, 3:23 PM EDT".
 * Times are shown in the viewer's zone; the abbreviation makes it explicit.
 */
export function formatMeasurementTime(
  value: string | number | null | undefined,
  options: { timeZone?: string; withYear?: boolean } = {},
) {
  const ms = parseTimestampMs(value);
  if (ms == null) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(options.withYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: options.timeZone,
  }).format(ms);
}

/** "Checked 3:24 PM" — when the portal last asked for data, distinct from measurement time. */
export function formatCheckedAt(value: string | number | null | undefined, timeZone?: string) {
  const ms = parseTimestampMs(value);
  if (ms == null) return null;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone }).format(ms);
}
