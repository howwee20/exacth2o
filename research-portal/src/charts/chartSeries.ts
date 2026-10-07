import { type PortalExperiment } from "../experimentRegistry";
import { validCadenceMs } from "../measurementFreshness";
import { colorForPairing, metricValue, plantGroupForPairing, treatmentForPairing } from "../portalPresentation";
import { type ChartPoint, type ChartSeries, type TimeBounds } from "../portalTypes";
import { pointsInRange, prepareSeries, summarizeSeries } from "../seriesStatistics";
import { type PairingRow, type SensorReading } from "../types";

/**
 * One series per pot holding every valid reading at full resolution.
 * Drawing reduces points separately (see decimateForDisplay); statistics and
 * exports never see a display-reduced series.
 */
export function chartSeries(
  pairings: PairingRow[],
  readings: SensorReading[],
  experiment?: PortalExperiment | null,
): ChartSeries[] {
  const grouped = new Map<string, Array<ChartPoint>>();
  const invalid = new Map<string, number>();

  for (const reading of readings) {
    if (!reading.pairing_name) continue;
    const value = metricValue(reading);
    const timestampMs = Date.parse(reading.device_recorded_at);
    if (value == null || !Number.isFinite(timestampMs)) {
      invalid.set(reading.pairing_name, (invalid.get(reading.pairing_name) ?? 0) + 1);
      continue;
    }
    const points = grouped.get(reading.pairing_name) ?? [];
    points.push({ timestampMs, value, reading });
    grouped.set(reading.pairing_name, points);
  }

  return pairings.map((pairing) => {
    const prepared = prepareSeries(grouped.get(pairing.name) ?? []);
    return {
      name: pairing.name,
      kind: "pot",
      zone: pairing.zone,
      potNumber: pairing.pot_number,
      treatment: treatmentForPairing(pairing, experiment),
      plantGroup: plantGroupForPairing(pairing, experiment),
      color: colorForPairing(pairing),
      points: prepared.points,
      rawPointCount: prepared.points.length,
      expectedIntervalMs: validCadenceMs(pairing.measurement_interval_ms),
      invalidCount: (invalid.get(pairing.name) ?? 0) + prepared.invalidCount,
      duplicateCount: prepared.duplicateCount,
      conflictingDuplicateCount: prepared.conflictingDuplicateCount,
    };
  });
}

export function latestPoint(series?: ChartSeries | null) {
  return series?.points.length ? series.points[series.points.length - 1] : null;
}

/** Full-resolution summary of a series, optionally limited to a time window. */
export function seriesSummary(series: ChartSeries, window?: TimeBounds | null) {
  const points = window ? pointsInRange(series.points, window.startMs, window.endMs) : series.points;
  return summarizeSeries(points, { configuredIntervalMs: series.expectedIntervalMs });
}

/** "31.2%" for a measured value; an em dash, never zero, when there is no reading. */
export function formatVwcReading(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}%`;
}

/** Spoken form for labels: "31.2 percent VWC" or "no reading". */
export function describeVwcReading(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "no reading" : `${value.toFixed(1)} percent VWC`;
}

export type GroupComparison = {
  potCount: number;
  reportingCount: number;
  latestMedian: number | null;
  latestMin: number | null;
  latestMax: number | null;
  windowMean: number | null;
  newestAt: number | null;
};

/**
 * Compare a group of pots: the median of each pot's latest reading inside the
 * window, the spread of those readings, and the mean of every reading in the
 * window (full resolution).
 */
export function compareGroup(series: readonly ChartSeries[], window?: TimeBounds | null): GroupComparison {
  const latest: number[] = [];
  let sum = 0;
  let count = 0;
  let newestAt: number | null = null;
  for (const item of series) {
    const points = window ? pointsInRange(item.points, window.startMs, window.endMs) : item.points;
    if (!points.length) continue;
    const last = points[points.length - 1];
    latest.push(last.value);
    newestAt = newestAt == null ? last.timestampMs : Math.max(newestAt, last.timestampMs);
    for (const point of points) {
      sum += point.value;
      count += 1;
    }
  }
  latest.sort((a, b) => a - b);
  const middle = Math.floor(latest.length / 2);
  return {
    potCount: series.length,
    reportingCount: latest.length,
    latestMedian: latest.length ? (latest.length % 2 ? latest[middle] : (latest[middle - 1] + latest[middle]) / 2) : null,
    latestMin: latest.length ? latest[0] : null,
    latestMax: latest.length ? latest[latest.length - 1] : null,
    windowMean: count ? sum / count : null,
    newestAt,
  };
}
