export type OverlayTimeBounds = {
  startMs: number;
  endMs: number;
};

export type OverlayTimeWindow = {
  start: number;
  end: number;
};

export type OverlayTimedValue = {
  timestampMs: number;
  value: number;
};

export type OverlayInterpolation<T extends OverlayTimedValue> = {
  value: number;
  exact: boolean;
  before: T;
  after: T;
};

export function partitionOverlayMarkers<T extends { value: number | null }>(markers: T[]) {
  const visible: Array<T & { value: number }> = [];
  let omittedCount = 0;

  for (const marker of markers) {
    if (marker.value == null) {
      omittedCount += 1;
      continue;
    }
    visible.push(marker as T & { value: number });
  }

  return { visible, omittedCount };
}

export function overlayTimeBounds(
  bounds: OverlayTimeBounds | null,
  window: OverlayTimeWindow,
): OverlayTimeBounds | null {
  if (!bounds) return null;
  const span = Math.max(1, bounds.endMs - bounds.startMs);
  const start = Math.max(0, Math.min(window.start, window.end));
  const end = Math.min(100, Math.max(window.start, window.end));
  return {
    startMs: bounds.startMs + span * (start / 100),
    endMs: bounds.startMs + span * (end / 100),
  };
}

/**
 * Returns the value drawn on the line at an event timestamp.
 *
 * Exact observations win. Interpolation is only allowed between nearby real
 * samples; large gaps return null so the UI never invents a precise VWC value
 * where the controller did not provide adequate evidence.
 */
export function interpolateOverlayValue<T extends OverlayTimedValue>(
  points: T[],
  timestampMs: number,
  maxSampleSpanMs: number,
): OverlayInterpolation<T> | null {
  if (!Number.isFinite(timestampMs) || !points.length || maxSampleSpanMs <= 0) return null;

  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point.timestampMs === timestampMs) {
      return { value: point.value, exact: true, before: point, after: point };
    }
    if (point.timestampMs < timestampMs) low = middle + 1;
    else high = middle - 1;
  }

  const before = points[Math.max(0, high)];
  const after = points[Math.min(points.length - 1, low)];
  if (!before || !after) return null;

  if (before === after) {
    return Math.abs(before.timestampMs - timestampMs) <= maxSampleSpanMs / 2
      ? { value: before.value, exact: false, before, after }
      : null;
  }

  const sampleSpan = after.timestampMs - before.timestampMs;
  if (sampleSpan <= 0 || sampleSpan > maxSampleSpanMs) return null;
  const ratio = (timestampMs - before.timestampMs) / sampleSpan;
  return {
    value: before.value + (after.value - before.value) * ratio,
    exact: false,
    before,
    after,
  };
}
