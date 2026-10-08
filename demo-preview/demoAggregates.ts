// Read-only stand-ins for the portal's aggregate functions (portal_reading_buckets,
// portal_reading_gaps, portal_valve_open_buckets), computed in the browser from the demo's sample
// readings. They mirror the database functions' bucketing; nothing is saved and nothing leaves
// the page. Saving comparisons, exclusions and notes stays unavailable in the demos.
type Reading = { pairing_name: string; device_recorded_at: string; calibrated_value?: number | null; raw_value?: number | null; temperature?: number | null; electrical_conductivity?: number | null };
type ValveEvent = { pairing_name: string | null; device_recorded_at: string; action?: string; duration_ms?: number | null };

const round = (value: number) => Number(value.toFixed(4));

export function demoAggregate(name: string, args: Record<string, unknown>, readings: readonly Reading[], valveEvents: readonly ValveEvent[]): unknown[] | null {
  const start = Date.parse(String(args.p_start));
  const end = Date.parse(String(args.p_end));
  const size = Number(args.p_bucket_seconds) * 1000;
  const pots = new Set(Array.isArray(args.p_pairing_names) ? args.p_pairing_names.map(String) : []);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(size > 0) || end <= start) return null;
  const bucketOf = (at: number) => Math.floor((at - start) / size);

  if (name === "portal_reading_buckets") {
    const keys = ["calibrated_value", "raw_value", "temperature", "electrical_conductivity"] as const;
    const buckets = new Map<string, { pot: string; bucket: number; count: number; sums: number[]; counts: number[] }>();
    for (const reading of readings) {
      const at = Date.parse(reading.device_recorded_at);
      if (!pots.has(reading.pairing_name) || at < start || at >= end) continue;
      const key = `${reading.pairing_name}|${bucketOf(at)}`;
      const entry = buckets.get(key) ?? { pot: reading.pairing_name, bucket: bucketOf(at), count: 0, sums: [0, 0, 0, 0], counts: [0, 0, 0, 0] };
      entry.count += 1;
      keys.forEach((field, index) => {
        const value = reading[field];
        if (typeof value === "number" && Number.isFinite(value)) {
          entry.sums[index] += value;
          entry.counts[index] += 1;
        }
      });
      buckets.set(key, entry);
    }
    return Array.from(buckets.values())
      .sort((a, b) => a.pot.localeCompare(b.pot) || a.bucket - b.bucket)
      .map((entry) => {
        const mean = (index: number) => (entry.counts[index] ? round(entry.sums[index] / entry.counts[index]) : null);
        return {
          pairing_name: entry.pot,
          bucket_start: new Date(start + entry.bucket * size).toISOString(),
          readings: entry.count,
          excluded: 0,
          vwc_mean: mean(0),
          raw_mean: mean(1),
          temperature_mean: mean(2),
          ec_mean: mean(3),
        };
      });
  }

  if (name === "portal_valve_open_buckets") {
    const buckets = new Map<string, { pot: string; bucket: number; openings: number; ms: number }>();
    for (const event of valveEvents) {
      const at = Date.parse(event.device_recorded_at);
      if (!event.pairing_name || !pots.has(event.pairing_name) || (event.action && event.action !== "open") || at < start || at >= end) continue;
      const key = `${event.pairing_name}|${bucketOf(at)}`;
      const entry = buckets.get(key) ?? { pot: event.pairing_name, bucket: bucketOf(at), openings: 0, ms: 0 };
      entry.openings += 1;
      entry.ms += Number(event.duration_ms) || 0;
      buckets.set(key, entry);
    }
    return Array.from(buckets.values()).map((entry) => ({
      pairing_name: entry.pot,
      bucket_start: new Date(start + entry.bucket * size).toISOString(),
      openings: entry.openings,
      commanded_open_ms: entry.ms,
    }));
  }

  if (name === "portal_reading_gaps") {
    const complete = Math.floor((end - start) / size);
    const minimum = Math.max(1, Number(args.p_min_buckets) || 2);
    const present = new Map<string, Set<number>>();
    for (const reading of readings) {
      const at = Date.parse(reading.device_recorded_at);
      if (!pots.has(reading.pairing_name) || at < start || at >= end) continue;
      const set = present.get(reading.pairing_name) ?? new Set<number>();
      set.add(bucketOf(at));
      present.set(reading.pairing_name, set);
    }
    const gaps: unknown[] = [];
    for (const [pot, seen] of present) {
      let runStart: number | null = null;
      const close = (bucket: number) => {
        if (runStart != null && bucket - runStart >= minimum) {
          gaps.push({ pairing_name: pot, gap_start: new Date(start + runStart * size).toISOString(), gap_end: new Date(start + bucket * size).toISOString(), ongoing: bucket === complete });
        }
        runStart = null;
      };
      for (let bucket = Math.min(...seen); bucket < complete; bucket += 1) {
        if (seen.has(bucket)) close(bucket);
        else if (runStart == null) runStart = bucket;
      }
      close(complete);
    }
    return gaps;
  }
  return null;
}
