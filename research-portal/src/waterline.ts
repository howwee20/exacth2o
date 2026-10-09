import type { PotGroup } from "./experimentFactors";
import { freshnessThresholds, validCadenceMs } from "./measurementFreshness";
import { gapThresholdMs, resolveCadence } from "./seriesStatistics";
import type { PairingRow, SensorReading } from "./types";

/**
 * Waterline statistics. The pot is the experimental unit: every pot contributes at most one value
 * per time bucket (the mean of its own readings in that bucket), so a pot that reports more often
 * never outweighs one that reports less often. The group line is the median of those pot values;
 * the band is the lowest to highest pot value in the bucket. The band is a range, not a
 * confidence interval. A bucket where fewer than half of the group's pots reported is a gap.
 */

export type Measure = "vwc" | "raw" | "temperature" | "ec";

export type MeasureInfo = {
  id: Measure;
  label: string;
  /** Axis/unit text. Raw, temperature and EC are shown as the sensor reports them. */
  unit: string;
  shortUnit: string;
  digits: number;
  /** Only calibrated VWC is what the controller's targets apply to. */
  hasTargets: boolean;
  definition: string;
};

export const measures: Record<Measure, MeasureInfo> = {
  vwc: {
    id: "vwc",
    label: "Calibrated VWC",
    unit: "% VWC",
    shortUnit: "%",
    digits: 1,
    hasTargets: true,
    definition: "Volumetric water content after the pot's calibration is applied (calibrated_value).",
  },
  raw: {
    id: "raw",
    label: "Raw sensor output",
    unit: "sensor units",
    shortUnit: "",
    digits: 1,
    hasTargets: false,
    definition: "The sensor's uncalibrated output (raw_value), before any calibration. Use it to tell a calibration change from a change in the pot.",
  },
  temperature: {
    id: "temperature",
    label: "Temperature",
    unit: "as reported by the sensor",
    shortUnit: "",
    digits: 1,
    hasTargets: false,
    definition: "The sensor's temperature channel (temperature), as reported.",
  },
  ec: {
    id: "ec",
    label: "Electrical conductivity",
    unit: "as reported by the sensor",
    shortUnit: "",
    digits: 2,
    hasTargets: false,
    definition: "The sensor's electrical conductivity channel (electrical_conductivity), as reported.",
  },
};

export function measureValue(reading: Pick<SensorReading, "calibrated_value" | "raw_value" | "temperature" | "electrical_conductivity">, measure: Measure): number | null {
  const value = measure === "vwc"
    ? reading.calibrated_value
    : measure === "raw"
      ? reading.raw_value
      : measure === "temperature"
        ? reading.temperature
        : reading.electrical_conductivity;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Measures that actually have values in the readings (VWC first). */
export function availableMeasures(readings: readonly SensorReading[]): Measure[] {
  const found = new Set<Measure>();
  for (const reading of readings) {
    for (const measure of ["vwc", "raw", "temperature", "ec"] as Measure[]) {
      if (!found.has(measure) && measureValue(reading, measure) != null) found.add(measure);
    }
    if (found.size === 4) break;
  }
  return (["vwc", "raw", "temperature", "ec"] as Measure[]).filter((measure) => found.has(measure));
}

export type TimedPoint = { timestampMs: number; value: number };

export type PotTrace = {
  name: string;
  measure?: Measure;
  potNumber: number | null;
  points: TimedPoint[];
  /** Configured cadence, or the observed one when the controller did not report it. */
  intervalMs: number | null;
  cadenceSource: "configured" | "observed" | "unknown";
  gapMs: number;
  lastAt: number | null;
};

/** One ascending, de-duplicated trace per pot for a measure. */
export function potTraces(
  readings: readonly SensorReading[],
  pairings: readonly Pick<PairingRow, "name" | "pot_number" | "measurement_interval_ms">[],
  measure: Measure,
): Map<string, PotTrace> {
  const byPot = new Map<string, Map<number, number>>();
  for (const reading of readings) {
    const value = measureValue(reading, measure);
    const at = Date.parse(reading.device_recorded_at);
    if (value == null || !Number.isFinite(at)) continue;
    const pot = byPot.get(reading.pairing_name) ?? new Map<number, number>();
    pot.set(at, value);
    byPot.set(reading.pairing_name, pot);
  }
  const traces = new Map<string, PotTrace>();
  for (const pairing of pairings) {
    const raw = byPot.get(pairing.name);
    const points = raw ? Array.from(raw, ([timestampMs, value]) => ({ timestampMs, value })).sort((a, b) => a.timestampMs - b.timestampMs) : [];
    const configured = validCadenceMs(pairing.measurement_interval_ms);
    const cadence = resolveCadence(points, configured);
    traces.set(pairing.name, {
      name: pairing.name,
      measure,
      potNumber: Number.isFinite(pairing.pot_number) ? pairing.pot_number : null,
      points,
      intervalMs: cadence.intervalMs,
      cadenceSource: cadence.source,
      gapMs: gapThresholdMs(cadence.intervalMs),
      lastAt: points.length ? points[points.length - 1].timestampMs : null,
    });
  }
  return traces;
}

export type WaterlineBucket = {
  startMs: number;
  endMs: number;
  /** Pots with at least one reading in the bucket. */
  potCount: number;
  median: number | null;
  low: number | null;
  high: number | null;
  /** True when the bucket has values but too few pots to draw the group line. */
  thin: boolean;
};

export type GroupWaterline = {
  group: PotGroup;
  buckets: WaterlineBucket[];
  bucketMs: number;
  /** Pots configured in the group. */
  potTotal: number;
  /** Pots whose newest reading is current against their own cadence, as of `asOfMs`. */
  reporting: number;
  silent: { name: string; potNumber: number | null; lastAt: number | null; invalid?: boolean }[];
  /** Median and range of each reporting pot's newest value. */
  latest: { median: number; low: number; high: number; pots: number; atMs: number } | null;
  /** Newest observation time among the group's pots. */
  lastObservationMs: number | null;
  /** Readings that went into the buckets. */
  readingCount: number;
};

export function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Bucket width that gives roughly `target` buckets over the window, rounded to friendly minutes. */
export function bucketSizeMs(windowMs: number, target = 144) {
  const steps = [5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);
  const ideal = windowMs / Math.max(1, target);
  return steps.find((step) => step >= ideal) ?? steps[steps.length - 1];
}

export function groupWaterline(
  group: PotGroup,
  traces: ReadonlyMap<string, PotTrace>,
  window: { startMs: number; endMs: number },
  options: { bucketMs?: number; asOfMs: number },
): GroupWaterline {
  const bucketMs = options.bucketMs ?? bucketSizeMs(window.endMs - window.startMs);
  const first = Math.floor(window.startMs / bucketMs) * bucketMs;
  const count = Math.max(1, Math.ceil((window.endMs - first) / bucketMs));
  const sums = Array.from({ length: count }, () => new Map<string, { sum: number; n: number }>());
  let readingCount = 0;
  let lastObservationMs: number | null = null;
  const silent: GroupWaterline["silent"] = [];
  const latestValues: number[] = [];
  let latestAt = -Infinity;
  let reporting = 0;

  for (const name of group.pairingNames) {
    const trace = traces.get(name);
    const points = trace?.points ?? [];
    for (const point of points) {
      if (point.timestampMs < window.startMs || point.timestampMs > window.endMs) continue;
      if (trace?.measure === "vwc" && (point.value < 0 || point.value > 100)) continue;
      const index = Math.min(count - 1, Math.floor((point.timestampMs - first) / bucketMs));
      const cell = sums[index].get(name) ?? { sum: 0, n: 0 };
      cell.sum += point.value;
      cell.n += 1;
      sums[index].set(name, cell);
      readingCount += 1;
    }
    const lastPoint = [...points].reverse().find((point) => point.timestampMs <= options.asOfMs) ?? null;
    if (lastPoint && (lastObservationMs == null || lastPoint.timestampMs > lastObservationMs)) lastObservationMs = lastPoint.timestampMs;
    const { currentMs } = freshnessThresholds(trace?.intervalMs ?? null);
    const invalid = lastPoint != null && trace?.measure === "vwc" && (lastPoint.value < 0 || lastPoint.value > 100);
    const isCurrent = lastPoint != null && !invalid && options.asOfMs - lastPoint.timestampMs <= currentMs;
    if (isCurrent && lastPoint) {
      reporting += 1;
      latestValues.push(lastPoint.value);
      latestAt = Math.max(latestAt, lastPoint.timestampMs);
    } else {
      silent.push({ name, potNumber: trace?.potNumber ?? null, lastAt: lastPoint?.timestampMs ?? null, ...(invalid ? { invalid: true } : {}) });
    }
  }

  const potTotal = group.pairingNames.length;
  const minimumPots = Math.max(1, Math.ceil(potTotal / 2));
  const buckets: WaterlineBucket[] = sums.map((cells, index) => {
    const values = Array.from(cells.values(), (cell) => cell.sum / cell.n);
    const startMs = first + index * bucketMs;
    const enough = values.length >= minimumPots;
    return {
      startMs,
      endMs: startMs + bucketMs,
      potCount: values.length,
      median: enough ? median(values) : null,
      low: enough ? Math.min(...values) : null,
      high: enough ? Math.max(...values) : null,
      thin: values.length > 0 && !enough,
    };
  });

  const latestMedian = median(latestValues);
  return {
    group,
    buckets,
    bucketMs,
    potTotal,
    reporting,
    silent,
    latest: latestMedian == null ? null : {
      median: latestMedian,
      low: Math.min(...latestValues),
      high: Math.max(...latestValues),
      pots: latestValues.length,
      atMs: latestAt,
    },
    lastObservationMs,
    readingCount,
  };
}

/** Contiguous runs of drawable buckets; a gap or thin bucket breaks the line. */
export function waterlineSegments(buckets: readonly WaterlineBucket[]) {
  const segments: WaterlineBucket[][] = [];
  let current: WaterlineBucket[] = [];
  for (const bucket of buckets) {
    if (bucket.median == null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(bucket);
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Value domain covering bands, medians and (optionally) targets, padded and rounded. */
export function waterlineDomain(lines: readonly GroupWaterline[], targets: readonly number[] = [], minSpan = 4): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const line of lines) {
    for (const bucket of line.buckets) {
      if (bucket.low != null) low = Math.min(low, bucket.low);
      if (bucket.high != null) high = Math.max(high, bucket.high);
    }
  }
  for (const target of targets) {
    if (Number.isFinite(target)) {
      low = Math.min(low, target);
      high = Math.max(high, target);
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 50];
  if (high - low < minSpan) {
    const middle = (high + low) / 2;
    low = middle - minSpan / 2;
    high = middle + minSpan / 2;
  }
  const pad = (high - low) * 0.08;
  return [Math.floor(low - pad), Math.ceil(high + pad)];
}
