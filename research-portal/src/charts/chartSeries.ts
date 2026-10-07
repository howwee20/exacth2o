import { type PortalExperiment } from "../experimentRegistry";
import { dayMs, maxPointsPerSeries, staleAfterMs, tenMinutesMs } from "../portalConstants";
import { colorForPairing, metricValue, plantGroupForPairing, treatmentForPairing } from "../portalPresentation";
import { type ChartPoint, type ChartSeries, type PotStats } from "../portalTypes";
import { type PairingRow, type SensorReading } from "../types";

export function samplePoints(points: ChartPoint[]) {
  if (points.length <= maxPointsPerSeries) return points;
  const sampled: ChartPoint[] = [];
  const stride = (points.length - 1) / (maxPointsPerSeries - 1);
  for (let index = 0; index < maxPointsPerSeries; index += 1) {
    sampled.push(points[Math.round(index * stride)]);
  }
  return sampled;
}

export function chartSeries(
  pairings: PairingRow[],
  readings: SensorReading[],
  experiment?: PortalExperiment | null,
): ChartSeries[] {
  const grouped = new Map<string, ChartPoint[]>();

  for (const reading of readings) {
    if (!reading.pairing_name) continue;
    const value = metricValue(reading);
    if (value == null) continue;
    const timestampMs = new Date(reading.device_recorded_at).getTime();
    if (!Number.isFinite(timestampMs)) continue;

    const points = grouped.get(reading.pairing_name) ?? [];
    points.push({ timestampMs, value, reading });
    grouped.set(reading.pairing_name, points);
  }

  return pairings.map((pairing) => {
    const points = (grouped.get(pairing.name) ?? []).sort(
      (a, b) => a.timestampMs - b.timestampMs,
    );

    return {
      name: pairing.name,
      kind: "pot",
      zone: pairing.zone,
      potNumber: pairing.pot_number,
      treatment: treatmentForPairing(pairing, experiment),
      plantGroup: plantGroupForPairing(pairing, experiment),
      color: colorForPairing(pairing),
      points: samplePoints(points),
      rawPointCount: points.length,
    };
  });
}

export function average(values: number[]) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function formatPercent(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "none" : `${value.toFixed(digits)}%`;
}

export function statsForSeries(item?: ChartSeries | null): PotStats {
  if (!item || item.points.length === 0) {
    return {
      latestValue: null,
      latestAt: null,
      mean: null,
      min: null,
      max: null,
      dryingRatePerDay: null,
      missingReadings: 0,
      sharpDropCount: 0,
      status: "empty",
      warning: null,
    };
  }

  const values = item.points.map((point) => point.value);
  const first = item.points[0];
  const latest = item.points[item.points.length - 1];
  const spanMs = Math.max(1, latest.timestampMs - first.timestampMs);
  const expected = Math.max(0, Math.floor(spanMs / tenMinutesMs) + 1);
  let sharpDropCount = 0;
  let sharpDropMessage: string | null = null;

  for (let index = 1; index < item.points.length; index += 1) {
    const previous = item.points[index - 1];
    const current = item.points[index];
    const delta = current.value - previous.value;
    const elapsedMinutes = (current.timestampMs - previous.timestampMs) / 60_000;
    if (delta <= -3 && elapsedMinutes <= 45) {
      sharpDropCount += 1;
      if (!sharpDropMessage) {
        sharpDropMessage = `Sharp drop: ${previous.value.toFixed(1)}% to ${current.value.toFixed(1)}% in ${Math.max(1, Math.round(elapsedMinutes))} min`;
      }
    }
  }

  const latestAge = Date.now() - latest.timestampMs;
  const missingReadings = Math.max(0, expected - item.rawPointCount);
  const status =
    sharpDropCount > 0 || latest.value < 8 || missingReadings > 6
      ? "warning"
      : latestAge > staleAfterMs
        ? "stale"
        : "live";
  const warning =
    sharpDropMessage ??
    (latest.value < 8 ? `Low moisture: ${latest.value.toFixed(1)}% VWC` : null) ??
    (missingReadings > 6 ? `${missingReadings} estimated missing readings` : null);

  return {
    latestValue: latest.value,
    latestAt: latest.reading.device_recorded_at,
    mean: average(values),
    min: Math.min(...values),
    max: Math.max(...values),
    dryingRatePerDay: ((latest.value - first.value) / spanMs) * dayMs,
    missingReadings,
    sharpDropCount,
    status,
    warning,
  };
}
