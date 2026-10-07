import { healthNumber, healthString, healthTimestampMs } from "../healthValues";
import { wateringOverlayMaxSampleSpanMs } from "../portalConstants";
import { type ChartPoint, type ChartSeries, type HealthWateringEvent, type TimeBounds, type TimeWindow, type WateringOverlayMarker } from "../portalTypes";
import { lowerBound, pointsInRange } from "../seriesStatistics";
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

/** Y-axis domain for VWC from the plotted points plus any reference values (e.g. targets). */
export function vwcDomain(points: readonly ChartPoint[], extraValues: readonly number[] = []) {
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const point of points) {
    if (point.value < rawMin) rawMin = point.value;
    if (point.value > rawMax) rawMax = point.value;
  }
  for (const value of extraValues) {
    if (!Number.isFinite(value)) continue;
    if (value < rawMin) rawMin = value;
    if (value > rawMax) rawMax = value;
  }
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    return {
      yMin: 0,
      yMax: 60,
      ySpan: 60,
      yTicks: [0, 15, 30, 45, 60],
    };
  }

  rawMin = Math.max(0, rawMin);
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

export type ChartBounds = ReturnType<typeof chartBounds>;

export function chartBounds(
  series: readonly ChartSeries[],
  width: number,
  height: number,
  xDomain: TimeBounds | null = null,
  extraValues: readonly number[] = [],
  compact = false,
  headerSpace = 0,
) {
  const margin = compact
    ? { top: 12 + headerSpace, right: 12, bottom: 30, left: 44 }
    : { top: 22 + headerSpace, right: 24, bottom: 54, left: 68 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const domainIsValid = Boolean(xDomain && xDomain.endMs > xDomain.startMs);
  let firstTime = Infinity;
  let lastTime = -Infinity;
  const inDomain: ChartPoint[] = [];
  for (const item of series) {
    if (!item.points.length) continue;
    firstTime = Math.min(firstTime, item.points[0].timestampMs);
    lastTime = Math.max(lastTime, item.points[item.points.length - 1].timestampMs);
    const points = domainIsValid && xDomain
      ? pointsInRange(item.points, xDomain.startMs, xDomain.endMs)
      : item.points;
    for (const point of points) inDomain.push(point);
  }
  const yDomain = vwcDomain(inDomain, extraValues);
  const minX = domainIsValid && xDomain ? xDomain.startMs : Number.isFinite(firstTime) ? firstTime : 0;
  const maxX = domainIsValid && xDomain ? xDomain.endMs : Number.isFinite(lastTime) ? lastTime : 1;
  const spanX = Math.max(1, maxX - minX);

  const xScale = (timestampMs: number) =>
    margin.left + ((timestampMs - minX) / spanX) * plotWidth;
  const yScale = (value: number) => {
    const clamped = Math.max(yDomain.yMin, Math.min(yDomain.yMax, value));
    return margin.top + ((yDomain.yMax - clamped) / yDomain.ySpan) * plotHeight;
  };
  const timeAt = (x: number) => minX + ((x - margin.left) / plotWidth) * spanX;

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
    timeAt,
  };
}

export function timeBoundsForSeries(series: readonly ChartSeries[]): TimeBounds | null {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const item of series) {
    if (!item.points.length) continue;
    startMs = Math.min(startMs, item.points[0].timestampMs);
    endMs = Math.max(endMs, item.points[item.points.length - 1].timestampMs);
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null;
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
      // Keep one point beyond each edge so lines and overlays reach the window boundary.
      const firstInside = lowerBound(item.points, startMs);
      if (firstInside >= item.points.length) return item.points.slice(-1);
      let firstAfter = lowerBound(item.points, endMs);
      while (firstAfter < item.points.length && item.points[firstAfter].timestampMs <= endMs) firstAfter += 1;
      const from = Math.max(0, firstInside - 1);
      const to = Math.min(item.points.length, firstAfter + 1);
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
