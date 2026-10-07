import { healthNumber, healthString, healthTimestampMs } from "../healthValues";
import { wateringOverlayMaxSampleSpanMs } from "../portalConstants";
import { type ChartPoint, type ChartSeries, type HealthWateringEvent, type TimeBounds, type TimeWindow, type WateringOverlayMarker } from "../portalTypes";
import { interpolateOverlayValue } from "../wateringOverlay";

export function axisLabel(timestampMs: number, spanMs: number) {
  const date = new Date(timestampMs);
  if (spanMs > 36 * 60 * 60 * 1000) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}
export function niceStep(range: number, targetTicks: number) {
  const roughStep = range / Math.max(1, targetTicks - 1);
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(roughStep, 0.1))));
  const normalized = roughStep / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

export function vwcDomain(points: ChartPoint[]) {
  if (points.length === 0) {
    return {
      yMin: 0,
      yMax: 60,
      ySpan: 60,
      yTicks: [0, 15, 30, 45, 60],
    };
  }

  const values = points.map((point) => point.value);
  const rawMin = Math.max(0, Math.min(...values));
  const rawMax = Math.max(...values);
  const rawSpan = Math.max(1, rawMax - rawMin);
  const yPadding = Math.max(3, rawSpan * 0.12);
  const center = (rawMin + rawMax) / 2;
  const paddedSpan = Math.max(6, rawSpan + yPadding * 2);
  const paddedMin = Math.max(0, center - paddedSpan / 2);
  const paddedMax = Math.max(rawMax + yPadding, center + paddedSpan / 2);
  const step = niceStep(Math.max(1, paddedMax - paddedMin), 8);
  const yMin = Math.max(0, Math.floor(paddedMin / step) * step);
  const yMax = Math.max(yMin + step, Math.ceil(paddedMax / step) * step);
  const yTicks: number[] = [];

  for (let tick = yMin; tick <= yMax + step / 2; tick += step) {
    yTicks.push(Number(tick.toFixed(3)));
  }

  return {
    yMin,
    yMax,
    ySpan: Math.max(1, yMax - yMin),
    yTicks: yTicks.length >= 3 ? yTicks : [yMin, (yMin + yMax) / 2, yMax],
  };
}

export function formatAxisTick(value: number) {
  return Math.abs(value - Math.round(value)) < 0.001 ? String(Math.round(value)) : value.toFixed(1);
}

export function crispLine(value: number) {
  return Math.round(value) + 0.5;
}

export function chartBounds(
  series: ChartSeries[],
  width: number,
  height: number,
  xDomain: TimeBounds | null = null,
) {
  const margin = { top: 22, right: 24, bottom: 54, left: 68 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const allPoints = series.flatMap((item) => item.points);
  const yDomain = vwcDomain(allPoints);
  const domainIsValid = xDomain && xDomain.endMs > xDomain.startMs;
  const minX = domainIsValid
    ? xDomain.startMs
    : allPoints.length ? Math.min(...allPoints.map((point) => point.timestampMs)) : 0;
  const maxX = domainIsValid
    ? xDomain.endMs
    : allPoints.length ? Math.max(...allPoints.map((point) => point.timestampMs)) : 1;
  const spanX = Math.max(1, maxX - minX);

  const xScale = (timestampMs: number) =>
    margin.left + ((timestampMs - minX) / spanX) * plotWidth;
  const yScale = (value: number) => {
    const clamped = Math.max(yDomain.yMin, Math.min(yDomain.yMax, value));
    return margin.top + ((yDomain.yMax - clamped) / yDomain.ySpan) * plotHeight;
  };

  return {
    margin,
    plotWidth,
    plotHeight,
    ...yDomain,
    minX,
    maxX,
    spanX,
    xScale,
    yScale,
  };
}

export function timeBoundsForSeries(series: ChartSeries[]): TimeBounds | null {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return null;
  return {
    startMs: Math.min(...points.map((point) => point.timestampMs)),
    endMs: Math.max(...points.map((point) => point.timestampMs)),
  };
}

export function timeFromPercent(bounds: TimeBounds, percent: number) {
  const span = Math.max(1, bounds.endMs - bounds.startMs);
  return bounds.startMs + (span * percent) / 100;
}

export function filterSeriesByTime(series: ChartSeries[], bounds: TimeBounds | null, window: TimeWindow) {
  if (!bounds || (window.start <= 0 && window.end >= 100)) return series;
  const startMs = timeFromPercent(bounds, window.start);
  const endMs = timeFromPercent(bounds, window.end);

  return series.map((item) => ({
    ...item,
    points: (() => {
      const firstInside = item.points.findIndex((point) => point.timestampMs >= startMs);
      if (firstInside < 0) return item.points.slice(-1);
      const firstAfter = item.points.findIndex((point) => point.timestampMs > endMs);
      const from = Math.max(0, firstInside - 1);
      const to = firstAfter < 0 ? item.points.length : Math.min(item.points.length, firstAfter + 1);
      return item.points.slice(from, to);
    })(),
  }));
}

export function wateringOverlaySeriesForEvent(
  event: HealthWateringEvent,
  series: ChartSeries[],
) {
  const pairingName = healthString(event.pairingName);
  if (pairingName) {
    const matchingName = series.find((item) => item.kind === "pot" && item.name === pairingName);
    if (matchingName) return matchingName;
  }
  const potNumber = healthNumber(event.physicalPot);
  return potNumber == null
    ? null
    : series.find((item) => item.kind === "pot" && item.potNumber === Math.trunc(potNumber)) ?? null;
}

export function buildWateringOverlayMarkers(
  events: HealthWateringEvent[],
  series: ChartSeries[],
  xDomain: TimeBounds | null,
) {
  if (!xDomain) return [];
  return events.flatMap((event): WateringOverlayMarker[] => {
    const timestampMs = healthTimestampMs(event.t);
    if (timestampMs == null || timestampMs < xDomain.startMs || timestampMs > xDomain.endMs) return [];
    const matchingSeries = wateringOverlaySeriesForEvent(event, series);
    if (!matchingSeries) return [];
    const interpolation = interpolateOverlayValue(
      matchingSeries.points,
      timestampMs,
      wateringOverlayMaxSampleSpanMs,
    );
    return [{
      event,
      series: matchingSeries,
      timestampMs,
      value: interpolation?.value ?? null,
      exactValue: interpolation?.exact ?? false,
      before: interpolation?.before ?? null,
      after: interpolation?.after ?? null,
    }];
  });
}
