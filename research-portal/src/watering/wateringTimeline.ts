import { healthTimestampMs } from "../healthValues";
import type { HealthWateringEvent, TimeBounds } from "../portalTypes";
import { wateringEventLabel } from "../wateringEvents";

export type WateringMarker = {
  key: string;
  label: string;
  events: HealthWateringEvent[];
  fraction: number;
};

/** Group only openings that cannot be shown separately at this chart width. */
export function wateringTimelineMarkers(events: HealthWateringEvent[], bounds: TimeBounds, plotWidth: number): WateringMarker[] {
  const columns = Math.max(1, Math.floor(plotWidth / 36));
  const span = Math.max(1, bounds.endMs - bounds.startMs);
  const markers = new Map<string, WateringMarker>();
  for (const event of events) {
    const time = healthTimestampMs(event.t);
    if (time == null || time < bounds.startMs || time > bounds.endMs) continue;
    const fraction = (time - bounds.startMs) / span;
    const column = Math.min(columns - 1, Math.floor(fraction * columns));
    const label = wateringEventLabel(event);
    const key = `${label}:${column}`;
    const marker = markers.get(key);
    if (marker) {
      marker.events.push(event);
      marker.fraction = (column + 0.5) / columns;
    } else {
      markers.set(key, { key, label, events: [event], fraction });
    }
  }
  const rows = new Map<string, WateringMarker[]>();
  for (const marker of markers.values()) {
    const row = rows.get(marker.label) ?? [];
    row.push(marker);
    rows.set(marker.label, row);
  }
  const result: WateringMarker[] = [];
  for (const row of rows.values()) {
    const arranged: WateringMarker[] = [];
    for (let marker of row.sort((left, right) => left.fraction - right.fraction)) {
      let previous = arranged.at(-1);
      // Openings on opposite sides of a bin boundary can still collide.
      while (previous && (marker.fraction - previous.fraction) * plotWidth <
        (marker.events.length > 1 ? 14 : 4) + (previous.events.length > 1 ? 14 : 4) + 4) {
        arranged.pop();
        marker = { key: previous.key, label: marker.label, events: [...previous.events, ...marker.events], fraction: (previous.fraction + marker.fraction) / 2 };
        previous = arranged.at(-1);
      }
      arranged.push(marker);
    }
    result.push(...arranged);
  }
  return result;
}

export function wateringZoomBounds(events: HealthWateringEvent[], bounds: TimeBounds): TimeBounds {
  const times = events.map(event => healthTimestampMs(event.t)).filter((time): time is number => time != null);
  if (!times.length) return bounds;
  const first = times.reduce((min, time) => Math.min(min, time), Infinity);
  const last = times.reduce((max, time) => Math.max(max, time), -Infinity);
  const span = Math.min(bounds.endMs - bounds.startMs, Math.max(60_000, (last - first) * 1.5));
  const startMs = Math.max(bounds.startMs, Math.min((first + last - span) / 2, bounds.endMs - span));
  return { startMs, endMs: startMs + span };
}
