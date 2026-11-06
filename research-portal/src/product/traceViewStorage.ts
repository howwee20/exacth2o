import type { TimeBounds, TimeWindow } from '../portalTypes';
export type TraceView = { id: string; name: string; pairingNames: string[]; range: TimeBounds | null; replayWindow?: TimeWindow };
export function readTraceViews(raw: string | null): TraceView[] {
  try {
    const rows: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(rows)) return [];
    return rows.filter((v): v is TraceView => Boolean(v && typeof v.id === 'string' && typeof v.name === 'string' && v.name.trim() && v.name.length <= 60 && Array.isArray(v.pairingNames) && v.pairingNames.length && v.pairingNames.every((n: unknown) => typeof n === 'string') && (v.range === null || (Number.isFinite(v.range?.startMs) && Number.isFinite(v.range?.endMs) && v.range.startMs < v.range.endMs)) && (!v.replayWindow || (Number.isFinite(v.replayWindow.start) && Number.isFinite(v.replayWindow.end) && v.replayWindow.start >= 0 && v.replayWindow.end <= 100 && v.replayWindow.start < v.replayWindow.end)))).slice(0, 12);
  } catch { return []; }
}
export function captureTraceRange(bounds: TimeBounds | null, window: TimeWindow): TimeBounds | null {
  if (!bounds || bounds.endMs <= bounds.startMs) return null;
  const span = bounds.endMs - bounds.startMs;
  return { startMs: bounds.startMs + span * window.start / 100, endMs: bounds.startMs + span * window.end / 100 };
}
export function restoreTraceView(view: TraceView, available: string[], bounds: TimeBounds | null) {
  const names = view.pairingNames.filter(n => available.includes(n));
  if (!names.length) return { error: 'The pots in this view are no longer available.' };
  if (view.range && (!bounds || view.range.startMs < bounds.startMs - 1000 || view.range.endMs > bounds.endMs + 1000)) return { error: 'This view uses dates outside the loaded readings. Load those dates before applying it.' };
  const span = bounds ? bounds.endMs - bounds.startMs : 0;
  const window = view.replayWindow ?? (view.range && bounds && span > 0 ? { start: Math.max(0, (view.range.startMs - bounds.startMs) / span * 100), end: Math.min(100, (view.range.endMs - bounds.startMs) / span * 100) } : { start: 0, end: 100 });
  return { names, window, warning: names.length < view.pairingNames.length ? 'Some pots in this view are no longer available.' : '' };
}
