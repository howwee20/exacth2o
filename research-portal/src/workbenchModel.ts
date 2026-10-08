/**
 * Workbench comparisons. Everything a reader sees or exports — statistics, the figure, the CSV and
 * the methods sidecar — is computed here from the same per-pot buckets, after the same exclusions,
 * so they cannot disagree. Pure: no network, no DOM.
 */
import { experimentFactors, groupPattern, parseGrouping, potGroups, potNumberFromPairingName, potRangeText, type PotGroup } from "./experimentFactors";
import type { PortalExperiment } from "./experimentRegistry";
import { measures, median, type Measure } from "./waterline";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

// ---------------------------------------------------------------- definition

export type ComparisonWindow =
  | { kind: "last"; days: number }
  | { kind: "range"; startIso: string; endIso: string }
  | { kind: "around"; beforeDays: number; afterDays: number };

export type ComparisonAlignment =
  | { kind: "calendar" }
  | { kind: "event"; eventKey: string; label: string; atIso: string };

export type ComparisonDefinition = {
  version: 1;
  experimentId: string;
  measure: Measure;
  /** A factor list ("treatment", "treatment,crop"), "none" for all pots together, or "pot". */
  grouping: string;
  window: ComparisonWindow;
  alignment: ComparisonAlignment;
  bucketMinutes: number | null;
  /** Hidden in the figure only; still in the statistics and every export. */
  hiddenGroups: string[];
  weighting: "pot-equal";
};

export const weightingStatement =
  "Each pot counts once. A pot's value in a bucket is the mean of its readings in that bucket; a group's value is the median across its pots, and the band runs from the lowest to the highest pot. A pot's window value is the mean of its bucket values, so every bucket counts equally however many readings it had.";
export const rangeStatement = "The band is the range across pots (lowest to highest), not a confidence interval.";
export const gapStatement = "A bucket in which fewer than half of a group's pots reported is a gap: no median is drawn and nothing is interpolated.";
export const significanceStatement = "No significance test is computed. Differences are shown as measured.";

/** A first comparison for an experiment: its default grouping over the last week, or over its whole run once it has ended. */
export function defaultDefinition(experiment: Pick<PortalExperiment, "id" | "assignments" | "startedAt" | "endedAt">, completed = false): ComparisonDefinition {
  const factors = experimentFactors(experiment);
  return {
    version: 1,
    experimentId: experiment.id,
    measure: "vwc",
    grouping: parseGrouping(null, factors).join(",") || "none",
    window: completed && experiment.startedAt && experiment.endedAt
      ? { kind: "range", startIso: experiment.startedAt, endIso: experiment.endedAt }
      : { kind: "last", days: 7 },
    alignment: { kind: "calendar" },
    bucketMinutes: null,
    hiddenGroups: [],
    weighting: "pot-equal",
  };
}

/** Accepts a stored definition only when it has the expected shape; otherwise null. */
export function parseDefinition(value: unknown): ComparisonDefinition | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ComparisonDefinition>;
  if (candidate.version !== 1 || typeof candidate.experimentId !== "string") return null;
  if (!candidate.measure || !(candidate.measure in measures)) return null;
  if (typeof candidate.grouping !== "string" || !candidate.window || !candidate.alignment) return null;
  const window = candidate.window;
  const windowOk = (window.kind === "last" && Number.isFinite(window.days) && window.days > 0 && window.days <= 120)
    || (window.kind === "range" && typeof window.startIso === "string" && typeof window.endIso === "string"
      && Number.isFinite(Date.parse(window.startIso)) && Date.parse(window.endIso) > Date.parse(window.startIso))
    || (window.kind === "around" && Number.isFinite(window.beforeDays) && Number.isFinite(window.afterDays)
      && window.beforeDays >= 0 && window.afterDays >= 0 && window.beforeDays + window.afterDays > 0
      && window.beforeDays + window.afterDays <= 120);
  const alignment = candidate.alignment;
  const alignmentOk = alignment.kind === "calendar" || (alignment.kind === "event" && !Number.isNaN(Date.parse(alignment.atIso)));
  if (!windowOk || !alignmentOk) return null;
  if (candidate.bucketMinutes != null && !bucketChoicesMinutes.includes(candidate.bucketMinutes)) return null;
  return {
    version: 1,
    experimentId: candidate.experimentId,
    measure: candidate.measure,
    grouping: candidate.grouping,
    window,
    alignment,
    bucketMinutes: typeof candidate.bucketMinutes === "number" ? candidate.bucketMinutes : null,
    hiddenGroups: Array.isArray(candidate.hiddenGroups) ? candidate.hiddenGroups.filter((item): item is string => typeof item === "string") : [],
    weighting: "pot-equal",
  };
}

// ---------------------------------------------------------------- window and buckets

export const bucketChoicesMinutes = [10, 30, 60, 120, 180, 360, 720, 1440];
export const maxWindowMs = 120 * day;

export function chooseBucketMs(spanMs: number, maxBuckets = 200) {
  const choice = bucketChoicesMinutes.find((minutes) => spanMs / (minutes * minute) <= maxBuckets) ?? bucketChoicesMinutes[bucketChoicesMinutes.length - 1];
  return choice * minute;
}

function localMidnight(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export type ResolvedWindow = {
  /** First bucket start sent to the server (aligned to the origin). */
  queryStartMs: number;
  endMs: number;
  bucketMs: number;
  /** Bucket boundaries fall on originMs + k × bucketMs; for an aligned comparison, the event. */
  originMs: number;
  aligned: boolean;
  /** True when the requested window was cut to the longest allowed. */
  clipped: boolean;
};

export function resolveWindow(definition: ComparisonDefinition, nowMs: number): ResolvedWindow {
  const eventMs = definition.alignment.kind === "event" ? Date.parse(definition.alignment.atIso) : null;
  let startMs: number;
  let endMs: number;
  const window = definition.window;
  if (window.kind === "around" && eventMs != null) {
    startMs = eventMs - window.beforeDays * day;
    endMs = Math.min(nowMs, eventMs + window.afterDays * day);
  } else if (window.kind === "range") {
    startMs = Date.parse(window.startIso);
    endMs = Math.min(nowMs, Date.parse(window.endIso));
  } else {
    const days = window.kind === "last" ? window.days : 7;
    endMs = nowMs;
    startMs = nowMs - days * day;
  }
  let clipped = false;
  if (endMs - startMs > maxWindowMs) {
    startMs = endMs - maxWindowMs;
    clipped = true;
  }
  if (endMs <= startMs) endMs = startMs + hour;
  const bucketMs = definition.bucketMinutes ? Math.max(10, definition.bucketMinutes) * minute : chooseBucketMs(endMs - startMs);
  const originMs = eventMs ?? localMidnight(startMs);
  const queryStartMs = originMs + Math.floor((startMs - originMs) / bucketMs) * bucketMs;
  return { queryStartMs, endMs, bucketMs, originMs, aligned: eventMs != null, clipped };
}

export function bucketStarts(window: Pick<ResolvedWindow, "queryStartMs" | "endMs" | "bucketMs">) {
  const out: number[] = [];
  for (let at = window.queryStartMs; at < window.endMs && out.length < 20_000; at += window.bucketMs) out.push(at);
  return out;
}

/** Calls of at most `rowLimit` pot-buckets each: pots split into chunks, long windows into segments. */
export function bucketRequestPlan(pairingNames: readonly string[], window: Pick<ResolvedWindow, "queryStartMs" | "endMs" | "bucketMs">, rowLimit = 1000) {
  const plan: { pairingNames: string[]; startMs: number; endMs: number }[] = [];
  const segmentSpan = rowLimit * window.bucketMs;
  for (let segmentStart = window.queryStartMs; segmentStart < window.endMs; segmentStart += segmentSpan) {
    const segmentEnd = Math.min(window.endMs, segmentStart + segmentSpan);
    const buckets = Math.ceil((segmentEnd - segmentStart) / window.bucketMs);
    const perCall = Math.max(1, Math.floor(rowLimit / Math.max(1, buckets)));
    for (let index = 0; index < pairingNames.length; index += perCall) {
      plan.push({ pairingNames: pairingNames.slice(index, index + perCall), startMs: segmentStart, endMs: segmentEnd });
    }
  }
  return plan;
}

// ---------------------------------------------------------------- groups

export function comparisonGroups(experiment: Pick<PortalExperiment, "assignments" | "pairingNames">, grouping: string): PotGroup[] {
  if (grouping === "pot") {
    const names = experiment.pairingNames.slice().sort((a, b) => (potNumberFromPairingName(a) ?? 0) - (potNumberFromPairingName(b) ?? 0));
    return names.map((name, index) => ({
      id: name,
      label: `Pot ${potNumberFromPairingName(name) ?? name}`,
      levels: {},
      pairingNames: [name],
      potNumbers: [potNumberFromPairingName(name) ?? 0],
      plannedTargets: [],
      pattern: groupPattern(index),
    }));
  }
  return potGroups(experiment, parseGrouping(grouping, experimentFactors(experiment)));
}

// ---------------------------------------------------------------- exclusions

export type Exclusion = {
  id: string;
  pairingName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  reason: string;
  authorLabel: string;
  createdAt: string;
  revokedAt: string | null;
  revokedByLabel: string | null;
  revokeReason: string | null;
};

export const activeExclusions = (list: readonly Exclusion[]) => list.filter((item) => !item.revokedAt);

/** The ranges the server leaves out of the aggregates (the same rule the figure and exports use). */
export function exclusionRanges(list: readonly Exclusion[]) {
  return activeExclusions(list).map((item) => ({ pairing_name: item.pairingName, starts_at: item.startsAt, ends_at: item.endsAt }));
}

export function exclusionScopeText(item: Pick<Exclusion, "pairingName" | "startsAt" | "endsAt">, formatTime: (iso: string) => string) {
  const pot = item.pairingName ? `Pot ${potNumberFromPairingName(item.pairingName) ?? item.pairingName}` : "Every pot";
  const from = item.startsAt ? formatTime(item.startsAt) : "the start";
  const to = item.endsAt ? formatTime(item.endsAt) : "until revoked";
  return `${pot}, ${from} – ${to}`;
}

// ---------------------------------------------------------------- statistics

export type PotBucket = {
  pairingName: string;
  startMs: number;
  readings: number;
  excluded: number;
  values: Record<Measure, number | null>;
};

export type GroupBucket = {
  startMs: number;
  median: number | null;
  low: number | null;
  high: number | null;
  reporting: number;
  planned: number;
  gap: boolean;
};

export type GroupSummary = {
  groupId: string;
  label: string;
  planned: number;
  contributing: number;
  windowMedian: number | null;
  windowLow: number | null;
  windowHigh: number | null;
  coverage: number;
  readings: number;
  excluded: number;
  potsWithoutData: number[];
  hidden: boolean;
};

export type ComparisonResult = {
  bucketStarts: number[];
  series: { group: PotGroup; buckets: GroupBucket[] }[];
  summaries: GroupSummary[];
  /** Pot bucket values used (pairing → bucket start → value), for the CSV. */
  potValues: Map<string, Map<number, PotBucket>>;
  totals: { readings: number; excluded: number; potBuckets: number };
};

export function computeComparison({
  groups,
  buckets,
  measure,
  window,
  hiddenGroups = [],
}: {
  groups: readonly PotGroup[];
  buckets: readonly PotBucket[];
  measure: Measure;
  window: Pick<ResolvedWindow, "queryStartMs" | "endMs" | "bucketMs">;
  hiddenGroups?: readonly string[];
}): ComparisonResult {
  const starts = bucketStarts(window);
  const potValues = new Map<string, Map<number, PotBucket>>();
  for (const bucket of buckets) {
    const byStart = potValues.get(bucket.pairingName) ?? new Map<number, PotBucket>();
    byStart.set(bucket.startMs, bucket);
    potValues.set(bucket.pairingName, byStart);
  }
  const valueOf = (bucket: PotBucket | undefined) => (bucket && bucket.readings > 0 ? bucket.values[measure] : null);
  const series = groups.map((group) => {
    const planned = group.pairingNames.length;
    const needed = Math.max(1, Math.ceil(planned / 2));
    const groupBuckets: GroupBucket[] = starts.map((startMs) => {
      const values = group.pairingNames
        .map((name) => valueOf(potValues.get(name)?.get(startMs)))
        .filter((value): value is number => value != null && Number.isFinite(value));
      const gap = values.length < needed;
      return {
        startMs,
        median: gap ? null : median(values),
        low: gap ? null : Math.min(...values),
        high: gap ? null : Math.max(...values),
        reporting: values.length,
        planned,
        gap,
      };
    });
    return { group, buckets: groupBuckets };
  });
  const summaries = series.map(({ group, buckets: groupBuckets }) => {
    const potMeans: number[] = [];
    const without: number[] = [];
    let readings = 0;
    let excluded = 0;
    group.pairingNames.forEach((name, index) => {
      const byStart = potValues.get(name);
      const values: number[] = [];
      for (const startMs of starts) {
        const bucket = byStart?.get(startMs);
        if (!bucket) continue;
        readings += bucket.readings;
        excluded += bucket.excluded;
        const value = valueOf(bucket);
        if (value != null && Number.isFinite(value)) values.push(value);
      }
      if (values.length) potMeans.push(values.reduce((sum, value) => sum + value, 0) / values.length);
      else without.push(group.potNumbers[index] ?? potNumberFromPairingName(name) ?? 0);
    });
    const covered = groupBuckets.filter((bucket) => !bucket.gap).length;
    return {
      groupId: group.id,
      label: group.label,
      planned: group.pairingNames.length,
      contributing: potMeans.length,
      windowMedian: median(potMeans),
      windowLow: potMeans.length ? Math.min(...potMeans) : null,
      windowHigh: potMeans.length ? Math.max(...potMeans) : null,
      coverage: groupBuckets.length ? covered / groupBuckets.length : 0,
      readings,
      excluded,
      potsWithoutData: without,
      hidden: hiddenGroups.includes(group.id),
    };
  });
  const groupPots = new Set(groups.flatMap((group) => group.pairingNames));
  const counted = buckets.filter((bucket) => groupPots.has(bucket.pairingName));
  return {
    bucketStarts: starts,
    series,
    summaries,
    potValues,
    totals: {
      readings: counted.reduce((sum, bucket) => sum + bucket.readings, 0),
      excluded: counted.reduce((sum, bucket) => sum + bucket.excluded, 0),
      potBuckets: counted.length,
    },
  };
}

/** Median lines split at gaps, and band segments, in chart form. */
export function seriesSegments(buckets: readonly GroupBucket[], bucketMs: number) {
  const lines: { timestampMs: number; value: number }[][] = [];
  const bands: { timestampMs: number; low: number; high: number }[][] = [];
  let line: { timestampMs: number; value: number }[] = [];
  let band: { timestampMs: number; low: number; high: number }[] = [];
  for (const bucket of buckets) {
    if (bucket.gap || bucket.median == null || bucket.low == null || bucket.high == null) {
      if (line.length) lines.push(line);
      if (band.length) bands.push(band);
      line = [];
      band = [];
      continue;
    }
    const at = bucket.startMs + bucketMs / 2;
    line.push({ timestampMs: at, value: bucket.median });
    band.push({ timestampMs: at, low: bucket.low, high: bucket.high });
  }
  if (line.length) lines.push(line);
  if (band.length) bands.push(band);
  return { lines, bands };
}

export function valueDomain(result: ComparisonResult, hiddenGroups: readonly string[] = [], minSpan = 2): [number, number] {
  const values: number[] = [];
  for (const { group, buckets } of result.series) {
    if (hiddenGroups.includes(group.id)) continue;
    for (const bucket of buckets) {
      if (bucket.low != null) values.push(bucket.low);
      if (bucket.high != null) values.push(bucket.high);
    }
  }
  if (!values.length) return [0, 1];
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < minSpan) {
    const middle = (high + low) / 2;
    low = middle - minSpan / 2;
    high = middle + minSpan / 2;
  }
  const pad = (high - low) * 0.06;
  return [low - pad, high + pad];
}

// ---------------------------------------------------------------- axis

/** Ticks labelled as days from the event ("day −2", "day 0", …). */
export function eventDayTicks(domain: { startMs: number; endMs: number }, originMs: number, plotWidth: number, minGapPx = 64) {
  const span = Math.max(1, domain.endMs - domain.startMs);
  const steps = [6 * hour, 12 * hour, day, 2 * day, 7 * day, 14 * day];
  const step = steps.find((candidate) => (candidate / span) * plotWidth >= minGapPx) ?? steps[steps.length - 1];
  const ticks: { at: number; label: string }[] = [];
  let at = originMs + Math.ceil((domain.startMs - originMs) / step) * step;
  for (let guard = 0; at <= domain.endMs && guard < 400; guard += 1, at += step) {
    ticks.push({ at, label: offsetLabel(at - originMs) });
  }
  return ticks;
}

export function offsetLabel(offsetMs: number) {
  const whole = Math.round(offsetMs / day);
  if (Math.abs(offsetMs - whole * day) < minute) return whole === 0 ? "day 0" : `day ${whole > 0 ? "+" : "−"}${Math.abs(whole)}`;
  const hours = Math.round(offsetMs / hour);
  return `${hours >= 0 ? "+" : "−"}${Math.abs(hours)} h`;
}

// ---------------------------------------------------------------- exports

export function csvCell(value: string | number | boolean | null | undefined) {
  if (value == null) return "";
  const raw = typeof value === "number" ? (Number.isFinite(value) ? String(Number(value.toFixed(4))) : "") : String(value);
  // Spreadsheet applications interpret formula-leading text even in quoted CSV fields.
  // Keep actual numeric measurements numeric, including negative values and offsets.
  // eslint-disable-next-line no-control-regex -- skip leading control characters before formula markers
  const text = typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvColumns = [
  "row_type", "group_id", "group_label", "pairing_name", "pot_number", "bucket_start_utc", "offset_hours",
  "measure", "unit", "value", "readings", "excluded_readings", "pots_reporting", "pots_planned", "group_low", "group_high", "gap",
] as const;

/**
 * Long-format CSV: one row per pot-bucket used, then one row per group-bucket. Excluded readings
 * are not in any value; their count is reported. Hidden groups are included (hiding is visual).
 */
export function comparisonCsv(result: ComparisonResult, measure: Measure, window: Pick<ResolvedWindow, "bucketMs" | "originMs" | "aligned">) {
  const info = measures[measure];
  const offset = (startMs: number) => (window.aligned ? (startMs - window.originMs) / hour : null);
  const rows: string[] = [csvColumns.join(",")];
  for (const { group } of result.series) {
    group.pairingNames.forEach((name, index) => {
      const byStart = result.potValues.get(name);
      for (const startMs of result.bucketStarts) {
        const bucket = byStart?.get(startMs);
        if (!bucket || (bucket.readings === 0 && bucket.excluded === 0)) continue;
        const value = bucket.readings > 0 ? bucket.values[measure] : null;
        rows.push([
          "pot", group.id, group.label, name, group.potNumbers[index] ?? potNumberFromPairingName(name), new Date(startMs).toISOString(), offset(startMs),
          measure, info.unit, value, bucket.readings, bucket.excluded, null, null, null, null, null,
        ].map(csvCell).join(","));
      }
    });
  }
  for (const { group, buckets } of result.series) {
    for (const bucket of buckets) {
      rows.push([
        "group", group.id, group.label, null, null, new Date(bucket.startMs).toISOString(), offset(bucket.startMs),
        measure, info.unit, bucket.median, null, null, bucket.reporting, bucket.planned, bucket.low, bucket.high, bucket.gap,
      ].map(csvCell).join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}

export type SidecarInput = {
  question: string;
  comparisonId: string | null;
  sharing: "private" | "project" | null;
  authorLabel: string | null;
  generatedAtIso: string;
  build: string;
  projectId: string;
  deviceId: string;
  experiment: { id: string; databaseId: string | null; name: string; revision: number | null };
  pots: { pairingName: string; potNumber: number; groupId: string; calibrationNow: string | null }[];
  definition: ComparisonDefinition;
  window: ResolvedWindow;
  exclusions: readonly Exclusion[];
  result: ComparisonResult;
  calibrationEvents: { atIso: string; label: string; pots: string[] }[];
  query: { requests: number; rows: number; bytes: number; failed: number };
};

export function comparisonSidecar(input: SidecarInput) {
  const info = measures[input.definition.measure];
  const active = activeExclusions(input.exclusions);
  const revoked = input.exclusions.filter((item) => item.revokedAt);
  const describe = (item: Exclusion) => ({
    id: item.id,
    pot: item.pairingName,
    starts_at: item.startsAt,
    ends_at: item.endsAt,
    reason: item.reason,
    added_by: item.authorLabel,
    added_at: item.createdAt,
    ...(item.revokedAt ? { revoked_at: item.revokedAt, revoked_by: item.revokedByLabel, revoke_reason: item.revokeReason } : {}),
  });
  return {
    schema: "exacth2o.comparison-sidecar/1",
    question: input.question,
    comparison_id: input.comparisonId,
    saved: input.comparisonId != null,
    sharing: input.sharing,
    author: input.authorLabel,
    generated_at: input.generatedAtIso,
    generated_by: `Exact H2O research portal (${input.build})`,
    source: {
      project_id: input.projectId,
      controller_id: input.deviceId,
      experiment: input.experiment,
      pots: input.pots,
      data: "sensor_readings, aggregated by public.portal_reading_buckets (per pot, per bucket; readings in active exclusions removed before averaging)",
    },
    measure: { id: info.id, label: info.label, unit: info.unit, definition: info.definition },
    window: {
      start_utc: new Date(input.window.queryStartMs).toISOString(),
      end_utc: new Date(input.window.endMs).toISOString(),
      bucket_minutes: input.window.bucketMs / minute,
      clipped_to_120_days: input.window.clipped,
      alignment: input.definition.alignment.kind === "event"
        ? { kind: "days since a recorded event", event: input.definition.alignment.label, event_at: input.definition.alignment.atIso }
        : { kind: "calendar time" },
    },
    method: {
      weighting: weightingStatement,
      band: rangeStatement,
      gaps: gapStatement,
      significance: significanceStatement,
      interpolation: "None.",
    },
    exclusions: {
      rule: "Readings inside an active exclusion are left out of the statistics, the figure and the CSV alike. Revoked exclusions are listed for the record and are not applied.",
      applied: active.map(describe),
      revoked: revoked.map(describe),
    },
    presentation: {
      hidden_groups: input.definition.hiddenGroups,
      note: "Hidden groups are left out of the figure only; their data remains in the statistics and the CSV.",
    },
    completeness: {
      buckets: input.result.bucketStarts.length,
      readings_used: input.result.totals.readings,
      readings_excluded: input.result.totals.excluded,
      groups: input.result.summaries.map((summary) => ({
        group: summary.label,
        pots_planned: summary.planned,
        pots_with_data: summary.contributing,
        pots_without_data: summary.potsWithoutData,
        bucket_coverage: Number(summary.coverage.toFixed(4)),
      })),
      failed_requests: input.query.failed,
    },
    calibration_events_in_window: input.calibrationEvents,
    query: { function: "public.portal_reading_buckets", requests: input.query.requests, rows: input.query.rows, approx_bytes: input.query.bytes },
  };
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A standalone SVG of the visible groups, with the question, method and exclusions written on it. */
export function comparisonSvg({
  question,
  subtitle,
  result,
  window,
  measure,
  hiddenGroups,
  xTicks,
  footer,
  width = 960,
  height = 560,
}: {
  question: string;
  subtitle: string;
  result: ComparisonResult;
  window: ResolvedWindow;
  measure: Measure;
  hiddenGroups: readonly string[];
  xTicks: { at: number; label: string }[];
  footer: string[];
  width?: number;
  height?: number;
}) {
  const info = measures[measure];
  // Legend entries wrap onto as many rows as they need.
  const visible = result.series.filter(({ group }) => !hiddenGroups.includes(group.id));
  const legendPlaces: { x: number; row: number }[] = [];
  let cursorX = 64;
  let row = 0;
  for (const { group } of visible) {
    const itemWidth = 40 + group.label.length * 7;
    if (cursorX + itemWidth > width - 24 && cursorX > 64) {
      row += 1;
      cursorX = 64;
    }
    legendPlaces.push({ x: cursorX, row });
    cursorX += itemWidth;
  }
  const legendRows = visible.length ? row + 1 : 0;
  const margin = { left: 64, right: 24, top: 84, bottom: 48 + legendRows * 20 + footer.length * 16 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const domain = { startMs: window.queryStartMs, endMs: window.endMs };
  const [low, high] = valueDomain(result, hiddenGroups);
  const x = (t: number) => margin.left + ((t - domain.startMs) / Math.max(1, domain.endMs - domain.startMs)) * plotW;
  const y = (v: number) => margin.top + (1 - (v - low) / Math.max(1e-9, high - low)) * plotH;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`);
  parts.push(`<title>${escapeXml(question)}</title>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${margin.left}" y="32" font-size="20" fill="#0f1a14">${escapeXml(question)}</text>`);
  parts.push(`<text x="${margin.left}" y="56" font-size="13" fill="#4b5a52">${escapeXml(subtitle)}</text>`);
  const step = (high - low) / 4;
  for (let index = 0; index <= 4; index += 1) {
    const value = low + step * index;
    parts.push(`<line x1="${margin.left}" x2="${margin.left + plotW}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" stroke="#e3e0d8"/>`);
    parts.push(`<text x="${margin.left - 8}" y="${(y(value) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#4b5a52">${value.toFixed(info.digits)}</text>`);
  }
  parts.push(`<text x="16" y="${margin.top + plotH / 2}" font-size="11" fill="#4b5a52" transform="rotate(-90 16 ${margin.top + plotH / 2})" text-anchor="middle">${escapeXml(`${info.label} (${info.unit})`)}</text>`);
  for (const tick of xTicks) {
    if (tick.at < domain.startMs || tick.at > domain.endMs) continue;
    parts.push(`<line x1="${x(tick.at).toFixed(1)}" x2="${x(tick.at).toFixed(1)}" y1="${margin.top + plotH}" y2="${margin.top + plotH + 5}" stroke="#4b5a52"/>`);
    parts.push(`<text x="${x(tick.at).toFixed(1)}" y="${margin.top + plotH + 18}" font-size="11" text-anchor="middle" fill="#4b5a52">${escapeXml(tick.label)}</text>`);
  }
  if (window.aligned && window.originMs >= domain.startMs && window.originMs <= domain.endMs) {
    parts.push(`<line x1="${x(window.originMs).toFixed(1)}" x2="${x(window.originMs).toFixed(1)}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="#0f1a14" stroke-dasharray="2 3"/>`);
  }
  const legend: string[] = [];
  visible.forEach(({ group, buckets }, index) => {
    const { lines, bands } = seriesSegments(buckets, window.bucketMs);
    for (const band of bands) {
      const top = band.map((point) => `${x(point.timestampMs).toFixed(1)},${y(point.high).toFixed(1)}`);
      const bottom = band.slice().reverse().map((point) => `${x(point.timestampMs).toFixed(1)},${y(point.low).toFixed(1)}`);
      parts.push(`<polygon points="${[...top, ...bottom].join(" ")}" fill="${group.pattern.color}" fill-opacity="0.14" stroke="none"/>`);
    }
    for (const line of lines) {
      const d = line.map((point, index) => `${index ? "L" : "M"}${x(point.timestampMs).toFixed(1)} ${y(point.value).toFixed(1)}`).join("");
      parts.push(`<path d="${d}" fill="none" stroke="${group.pattern.color}" stroke-width="2"${group.pattern.dash ? ` stroke-dasharray="${group.pattern.dash}"` : ""}/>`);
    }
    const place = legendPlaces[index];
    const legendY = margin.top + plotH + 40 + place.row * 20;
    legend.push(`<line x1="${place.x}" x2="${place.x + 22}" y1="${legendY - 4}" y2="${legendY - 4}" stroke="${group.pattern.color}" stroke-width="2.5"${group.pattern.dash ? ` stroke-dasharray="${group.pattern.dash}"` : ""}/>`);
    legend.push(`<text x="${place.x + 28}" y="${legendY}" font-size="12" fill="#0f1a14">${escapeXml(group.label)}</text>`);
  });
  parts.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#c9c4b8"/>`);
  parts.push(...legend);
  footer.forEach((line, index) => {
    parts.push(`<text x="${margin.left}" y="${margin.top + plotH + 44 + legendRows * 20 + index * 16}" font-size="11" fill="#4b5a52">${escapeXml(line)}</text>`);
  });
  parts.push("</svg>");
  return parts.join("\n");
}

/** One-line summary of which pots a set of pairing names covers. */
export function potsText(pairingNames: readonly string[]) {
  return potRangeText(pairingNames.map((name) => potNumberFromPairingName(name) ?? 0).filter(Boolean));
}
