import type { Reading } from "./types";

// Incremental telemetry for a long commissioning run.
//
// The API returns at most `pageSize` rows per request (PostgREST max-rows, 1000 on
// this project). A run re-reads the same lookback window many times; asking for
// "everything since the window began" with a row limit returns the EARLIEST rows
// over and over and eventually never sees a new reading. Instead:
//  - the first read pages through the window by (device_recorded_at, id);
//  - later reads page forward by (server_received_at, id) from the newest receipt
//    seen, overlapping a little so late or reordered uploads are not skipped;
//  - rows are de-duplicated by id, and ids older than the overlap are forgotten,
//    so memory stays bounded however long the run lasts.

export type TelemetryRow = {
  id: number;
  sensorKey: string;
  recordedAt: string;
  receivedAt: string;
  vwc: number;
};

export type TelemetryPageRequest = {
  sensorKeys: string[];
  order: "recorded" | "received";
  /** Lower bound: device_recorded_at >= since (recorded) or server_received_at >= since (received). */
  since: string;
  /** Keyset position: rows strictly after (timestamp, id) in the chosen order. */
  after: { at: string; id: number } | null;
  limit: number;
};

export type TelemetryPageFetcher = (request: TelemetryPageRequest) => Promise<TelemetryRow[]>;

export type TelemetryReaderOptions = {
  pageSize?: number;
  overlapMs?: number;
  /** Safety bound on work per call; the cursor continues on the next call. */
  maxPagesPerCall?: number;
  /** Sensor keys per request, so a 100-pot filter never builds an oversized URL. */
  keysPerRequest?: number;
};

export function createTelemetryReader(fetchPage: TelemetryPageFetcher, options: TelemetryReaderOptions = {}) {
  const pageSize = options.pageSize ?? 1000;
  const overlapMs = options.overlapMs ?? 2 * 60_000;
  const maxPagesPerCall = options.maxPagesPerCall ?? 60;
  const keysPerRequest = options.keysPerRequest ?? 100;
  // Per key-group state, so adding sensors later does not reset the others.
  const groups = new Map<string, { coveredSinceMs: number; receivedCursorMs: number | null; seen: Map<number, number>; resumeAfter: { at: string; id: number } | null; backfilling: boolean }>();
  let pagesRequested = 0;

  const toReading = (row: TelemetryRow): Reading | null => {
    const atMs = Date.parse(row.recordedAt);
    return Number.isFinite(atMs) && Number.isFinite(row.vwc) ? { sensorKey: row.sensorKey, atMs, vwc: row.vwc } : null;
  };

  async function readGroup(keys: string[], sinceMs: number): Promise<Reading[]> {
    const groupKey = keys.join("|");
    let state = groups.get(groupKey);
    const out: Reading[] = [];
    const accept = (rows: TelemetryRow[]) => {
      for (const row of rows) {
        if (state!.seen.has(row.id)) continue;
        const receivedMs = Date.parse(row.receivedAt);
        state!.seen.set(row.id, Number.isFinite(receivedMs) ? receivedMs : 0);
        if (Number.isFinite(receivedMs) && (state!.receivedCursorMs == null || receivedMs > state!.receivedCursorMs)) state!.receivedCursorMs = receivedMs;
        const reading = toReading(row);
        if (reading && reading.atMs >= sinceMs) out.push(reading);
      }
    };

    if (!state || sinceMs < state.coveredSinceMs) {
      // Backfill the window by recording time, page after page.
      state = { coveredSinceMs: sinceMs, receivedCursorMs: state?.receivedCursorMs ?? null, seen: state?.seen ?? new Map(), resumeAfter: null, backfilling: true };
      groups.set(groupKey, state);
    }

    let pages = 0;
    if (state.backfilling) {
      let after = state.resumeAfter;
      for (;;) {
        if (pages >= maxPagesPerCall) {
          state.resumeAfter = after;
          return out;
        }
        const rows = await fetchPage({ sensorKeys: keys, order: "recorded", since: new Date(state.coveredSinceMs).toISOString(), after, limit: pageSize });
        pages += 1;
        pagesRequested += 1;
        accept(rows);
        if (rows.length < pageSize) break;
        const last = rows[rows.length - 1];
        after = { at: last.recordedAt, id: last.id };
      }
      state.backfilling = false;
      state.resumeAfter = null;
    }

    // Then follow new receipts, overlapping so late uploads are still seen.
    let after: { at: string; id: number } | null = null;
    const startMs = (state.receivedCursorMs ?? sinceMs) - overlapMs;
    for (;;) {
      if (pages >= maxPagesPerCall) break;
      const rows = await fetchPage({ sensorKeys: keys, order: "received", since: new Date(startMs).toISOString(), after, limit: pageSize });
      pages += 1;
      pagesRequested += 1;
      accept(rows);
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1];
      after = { at: last.receivedAt, id: last.id };
    }

    // Forget ids that can no longer recur in an overlapping read.
    const forgetBefore = (state.receivedCursorMs ?? 0) - 3 * overlapMs;
    for (const [id, receivedMs] of state.seen) if (receivedMs < forgetBefore) state.seen.delete(id);
    return out;
  }

  return {
    async read(sensorKeys: readonly string[], sinceMs: number): Promise<Reading[]> {
      const keys = Array.from(new Set(sensorKeys)).sort();
      const out: Reading[] = [];
      for (let start = 0; start < keys.length; start += keysPerRequest) {
        out.push(...await readGroup(keys.slice(start, start + keysPerRequest), sinceMs));
      }
      return out;
    },
    stats() {
      let remembered = 0;
      groups.forEach((group) => { remembered += group.seen.size; });
      return { pagesRequested, rememberedIds: remembered, groups: groups.size };
    },
  };
}
