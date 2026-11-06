import type { TimeBounds, TimeWindow } from "../portalTypes";

export const timeRangePresets = [
  { label: "Entire experiment", hours: null },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "14d", hours: 336 },
] as const;

export function presetTimeWindow(bounds: TimeBounds, hours: number | null): TimeWindow {
  const duration = bounds.endMs - bounds.startMs;
  return { start: hours === null || duration <= 0 ? 0 : Math.max(0, 100 - hours * 3_600_000 / duration * 100), end: 100 };
}

export function customTimeWindow(bounds: TimeBounds, startMs: number, endMs: number): TimeWindow | null {
  const duration = bounds.endMs - bounds.startMs;
  if (duration <= 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || startMs < bounds.startMs || endMs > bounds.endMs) return null;
  return { start: (startMs - bounds.startMs) / duration * 100, end: (endMs - bounds.startMs) / duration * 100 };
}
