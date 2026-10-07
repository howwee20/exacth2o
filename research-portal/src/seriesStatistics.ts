/**
 * Scientific summaries and display preparation for sensor time series.
 *
 * Summaries are always computed from every valid measurement. Display
 * decimation (fewer points for drawing) is a separate step that never feeds
 * back into a statistic, and it keeps each bucket's extremes so spikes and
 * rapid watering responses stay visible. Gaps longer than the expected
 * cadence break the drawn line instead of implying continuity across an outage.
 */

export type TimedValue = {
  timestampMs: number;
  value: number;
};

export type PreparedSeries<T extends TimedValue> = {
  /** Valid points, ascending by time, one per timestamp. */
  points: T[];
  /** Points with a non-finite value or timestamp; excluded from everything. */
  invalidCount: number;
  /** Same timestamp and same value as another point; collapsed to one. */
  duplicateCount: number;
  /** Same timestamp, different value. The last point in input order is kept. */
  conflictingDuplicateCount: number;
  /** Points that arrived earlier in the input than an older measurement. */
  outOfOrderCount: number;
};

export type CadenceSource = "configured" | "observed" | "unknown";

export type SeriesSummary<T extends TimedValue = TimedValue> = {
  count: number;
  first: T | null;
  latest: T | null;
  min: T | null;
  max: T | null;
  /** Arithmetic mean of every valid measurement in range (not time weighted). */
  mean: number | null;
  /** Net change per day between the first and latest point; null under one hour of data. */
  changePerDay: number | null;
  sharpDrops: {
    count: number;
    first: { from: T; to: T } | null;
  };
  cadence: { intervalMs: number | null; source: CadenceSource };
  gaps: { count: number; longestMs: number; thresholdMs: number | null };
  /** Estimated readings missing inside the range, from the cadence; null when the cadence is unknown. */
  missingEstimate: number | null;
  /** Readings outside the physical 0-100 % range. Kept in the statistics, reported here. */
  outOfRangeCount: number;
};

/** A decrease of at least this many VWC percentage points... */
export const sharpDropPoints = 3;
/** ...between consecutive readings no more than this far apart. */
export const sharpDropWindowMs = 45 * 60_000;
/** Fallback break for drawn lines when the cadence is unknown. */
export const unknownCadenceGapMs = 30 * 60_000;

export function prepareSeries<T extends TimedValue>(input: readonly T[]): PreparedSeries<T> {
  let invalidCount = 0;
  let outOfOrderCount = 0;
  let newestSeen = -Infinity;
  const valid: Array<{ point: T; index: number }> = [];

  input.forEach((point, index) => {
    if (!point || !Number.isFinite(point.timestampMs) || !Number.isFinite(point.value)) {
      invalidCount += 1;
      return;
    }
    if (point.timestampMs < newestSeen) outOfOrderCount += 1;
    newestSeen = Math.max(newestSeen, point.timestampMs);
    valid.push({ point, index });
  });

  valid.sort((left, right) => left.point.timestampMs - right.point.timestampMs || left.index - right.index);

  const points: T[] = [];
  let duplicateCount = 0;
  let conflictingDuplicateCount = 0;
  for (const { point } of valid) {
    const previous = points[points.length - 1];
    if (previous && previous.timestampMs === point.timestampMs) {
      if (previous.value === point.value) duplicateCount += 1;
      else conflictingDuplicateCount += 1;
      points[points.length - 1] = point;
      continue;
    }
    points.push(point);
  }

  return { points, invalidCount, duplicateCount, conflictingDuplicateCount, outOfOrderCount };
}

/** Median spacing between consecutive points, or null with fewer than three points. */
export function observedCadenceMs(points: readonly TimedValue[]) {
  if (points.length < 3) return null;
  const deltas: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].timestampMs - points[index - 1].timestampMs;
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
}

export function resolveCadence(points: readonly TimedValue[], configuredIntervalMs?: number | null) {
  if (configuredIntervalMs != null && Number.isFinite(configuredIntervalMs) && configuredIntervalMs >= 1_000) {
    return { intervalMs: configuredIntervalMs, source: "configured" as const };
  }
  const observed = observedCadenceMs(points);
  return observed == null
    ? { intervalMs: null, source: "unknown" as const }
    : { intervalMs: observed, source: "observed" as const };
}

/** Spacing beyond which consecutive readings are treated as an outage. */
export function gapThresholdMs(intervalMs: number | null) {
  if (intervalMs == null || !Number.isFinite(intervalMs) || intervalMs <= 0) return unknownCadenceGapMs;
  return Math.max(intervalMs * 2.5, intervalMs + 5 * 60_000);
}

/** Points inside [startMs, endMs], found by binary search on a time-sorted array. */
export function pointsInRange<T extends TimedValue>(points: readonly T[], startMs: number, endMs: number) {
  const from = lowerBound(points, startMs);
  let to = lowerBound(points, endMs);
  while (to < points.length && points[to].timestampMs === endMs) to += 1;
  return points.slice(from, to);
}

/** First index whose timestamp is >= timestampMs. */
export function lowerBound(points: readonly TimedValue[], timestampMs: number) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].timestampMs < timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Summary of an ascending, de-duplicated series (use prepareSeries first). */
export function summarizeSeries<T extends TimedValue>(
  points: readonly T[],
  options: { configuredIntervalMs?: number | null } = {},
): SeriesSummary<T> {
  const cadence = resolveCadence(points, options.configuredIntervalMs);
  const threshold = cadence.intervalMs == null ? null : gapThresholdMs(cadence.intervalMs);
  if (!points.length) {
    return {
      count: 0,
      first: null,
      latest: null,
      min: null,
      max: null,
      mean: null,
      changePerDay: null,
      sharpDrops: { count: 0, first: null },
      cadence,
      gaps: { count: 0, longestMs: 0, thresholdMs: threshold },
      missingEstimate: cadence.intervalMs == null ? null : 0,
      outOfRangeCount: 0,
    };
  }

  let min = points[0];
  let max = points[0];
  let sum = 0;
  let outOfRangeCount = 0;
  let sharpDropCount = 0;
  let firstDrop: { from: T; to: T } | null = null;
  let gapCount = 0;
  let longestGap = 0;
  let missing = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    sum += point.value;
    if (point.value < min.value) min = point;
    if (point.value > max.value) max = point;
    if (point.value < 0 || point.value > 100) outOfRangeCount += 1;
    if (index === 0) continue;

    const previous = points[index - 1];
    const delta = point.timestampMs - previous.timestampMs;
    if (point.value - previous.value <= -sharpDropPoints && delta <= sharpDropWindowMs) {
      sharpDropCount += 1;
      firstDrop ??= { from: previous, to: point };
    }
    if (threshold != null && delta > threshold) {
      gapCount += 1;
      longestGap = Math.max(longestGap, delta);
    }
    if (cadence.intervalMs != null) {
      missing += Math.max(0, Math.round(delta / cadence.intervalMs) - 1);
    }
  }

  const first = points[0];
  const latest = points[points.length - 1];
  const spanMs = latest.timestampMs - first.timestampMs;
  return {
    count: points.length,
    first,
    latest,
    min,
    max,
    mean: sum / points.length,
    changePerDay: spanMs >= 60 * 60_000 ? ((latest.value - first.value) / spanMs) * 86_400_000 : null,
    sharpDrops: { count: sharpDropCount, first: firstDrop },
    cadence,
    gaps: { count: gapCount, longestMs: longestGap, thresholdMs: threshold },
    missingEstimate: cadence.intervalMs == null ? null : missing,
    outOfRangeCount,
  };
}

/**
 * Reduce a series for drawing only. Each time bucket keeps its first, lowest,
 * highest and last point in time order, so extremes survive. A spacing larger
 * than gapMs starts a new segment, so outages are drawn as breaks.
 */
export function decimateForDisplay<T extends TimedValue>(
  points: readonly T[],
  options: { startMs: number; endMs: number; buckets: number; gapMs: number },
): T[][] {
  const { startMs, endMs, gapMs } = options;
  const buckets = Math.max(1, Math.floor(options.buckets));
  const segments: T[][] = [];
  if (!points.length) return segments;

  const span = Math.max(1, endMs - startMs);
  let segment: T[] = [];
  let bucketIndex = Number.NaN;
  let bucket: T[] = [];

  const flushBucket = () => {
    if (!bucket.length) return;
    if (bucket.length <= 4) {
      segment.push(...bucket);
    } else {
      let low = bucket[0];
      let high = bucket[0];
      for (const point of bucket) {
        if (point.value < low.value) low = point;
        if (point.value > high.value) high = point;
      }
      const kept = [bucket[0], low, high, bucket[bucket.length - 1]];
      const unique = Array.from(new Set(kept)).sort((a, b) => a.timestampMs - b.timestampMs);
      segment.push(...unique);
    }
    bucket = [];
  };

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previous = index > 0 ? points[index - 1] : null;
    if (previous && point.timestampMs - previous.timestampMs > gapMs) {
      flushBucket();
      if (segment.length) segments.push(segment);
      segment = [];
      bucketIndex = Number.NaN;
    }
    const nextBucket = Math.min(buckets - 1, Math.max(0, Math.floor(((point.timestampMs - startMs) / span) * buckets)));
    if (nextBucket !== bucketIndex) {
      flushBucket();
      bucketIndex = nextBucket;
    }
    bucket.push(point);
  }
  flushBucket();
  if (segment.length) segments.push(segment);
  return segments;
}

/** Index of the point closest in time, or -1 for an empty series. */
export function nearestIndexByTime(points: readonly TimedValue[], timestampMs: number) {
  if (!points.length) return -1;
  const index = lowerBound(points, timestampMs);
  if (index <= 0) return 0;
  if (index >= points.length) return points.length - 1;
  return timestampMs - points[index - 1].timestampMs <= points[index].timestampMs - timestampMs ? index - 1 : index;
}
