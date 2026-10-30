import { describe, expect, it } from "vitest";
import { wateringTimelineMarkers, wateringZoomBounds } from "./wateringTimeline";

const bounds = { startMs: 1_000_000, endMs: 87_400_000 };
const event = (fraction: number, physicalPot = 65) => ({ physicalPot, t: new Date(bounds.startMs + fraction * (bounds.endMs - bounds.startMs)).toISOString() });

describe("watering timeline", () => {
  it("preserves every in-range opening without combining different pots", () => {
    const events = [event(0), event(0.5), event(0.501), event(0.501, 66), event(1), event(2)];
    const markers = wateringTimelineMarkers(events, bounds, 940);
    expect(markers.flatMap(marker => marker.events)).toHaveLength(5);
    expect(markers.every(marker => new Set(marker.events.map(item => item.physicalPot)).size === 1)).toBe(true);
    expect(markers.some(marker => marker.events.length === 2)).toBe(true);
  });

  it("keeps dense markers separate even across bucket edges", () => {
    const events = Array.from({ length: 1000 }, (_, index) => event(index / 1000));
    const markers = wateringTimelineMarkers(events, bounds, 940).sort((a, b) => a.fraction - b.fraction);
    expect(markers.flatMap(marker => marker.events)).toHaveLength(1000);
    for (let index = 1; index < markers.length; index++) {
      expect((markers[index].fraction - markers[index - 1].fraction) * 940).toBeGreaterThanOrEqual(32);
    }
    expect(wateringTimelineMarkers([event(1 / 26 - 0.0001), event(1 / 26 + 0.0001)], bounds, 940)).toHaveLength(1);
  });

  it("zooms into the complete group while staying inside the selected range", () => {
    for (const events of [[event(0), event(0.01)], [event(0.99), event(1)], [event(0.5), event(0.5)]]) {
      const zoom = wateringZoomBounds(events, bounds);
      expect(zoom.startMs).toBeGreaterThanOrEqual(bounds.startMs);
      expect(zoom.endMs).toBeLessThanOrEqual(bounds.endMs);
      expect(zoom.startMs).toBeLessThanOrEqual(Date.parse(events[0].t));
      expect(zoom.endMs).toBeGreaterThanOrEqual(Date.parse(events.at(-1)!.t));
      expect(zoom.endMs - zoom.startMs).toBeGreaterThanOrEqual(60_000);
      expect(zoom.endMs - zoom.startMs).toBeLessThan(bounds.endMs - bounds.startMs);
    }
  });
});
