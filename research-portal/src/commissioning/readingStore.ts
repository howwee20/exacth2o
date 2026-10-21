import type { Reading } from "./types";

// Readings held by a run, indexed by sensor and kept in time order. A 100-pot run at
// one reading per minute produces ~60,000 readings over ten hours; only the window a
// decision can still use is kept, so memory and per-pulse work stay bounded.
export class ReadingStore {
  private readonly bySensor = new Map<string, Reading[]>();
  private readonly seen = new Map<string, Set<number>>();
  private count = 0;

  add(readings: readonly Reading[]) {
    let added = 0;
    for (const reading of readings) {
      if (!Number.isFinite(reading.vwc) || !Number.isFinite(reading.atMs)) continue;
      let seen = this.seen.get(reading.sensorKey);
      if (!seen) {
        seen = new Set();
        this.seen.set(reading.sensorKey, seen);
        this.bySensor.set(reading.sensorKey, []);
      }
      if (seen.has(reading.atMs)) continue;
      seen.add(reading.atMs);
      const list = this.bySensor.get(reading.sensorKey)!;
      // Readings usually arrive in order; insert in place when one arrives late.
      if (list.length === 0 || list[list.length - 1].atMs <= reading.atMs) list.push(reading);
      else {
        let index = list.length - 1;
        while (index > 0 && list[index - 1].atMs > reading.atMs) index -= 1;
        list.splice(index, 0, reading);
      }
      this.count += 1;
      added += 1;
    }
    return added;
  }

  /** Time-ordered readings for one sensor. Do not mutate. */
  forSensor(sensorKey: string): readonly Reading[] {
    return this.bySensor.get(sensorKey) ?? [];
  }

  latestAt(sensorKey: string): number | null {
    const list = this.bySensor.get(sensorKey);
    return list && list.length ? list[list.length - 1].atMs : null;
  }

  /** Drops readings older than beforeMs. Their keys are forgotten too: they cannot recur. */
  prune(beforeMs: number) {
    for (const [sensorKey, list] of this.bySensor) {
      let drop = 0;
      while (drop < list.length && list[drop].atMs < beforeMs) drop += 1;
      if (drop === 0) continue;
      const seen = this.seen.get(sensorKey)!;
      for (const reading of list.slice(0, drop)) seen.delete(reading.atMs);
      list.splice(0, drop);
      this.count -= drop;
    }
  }

  get size() {
    return this.count;
  }
}
