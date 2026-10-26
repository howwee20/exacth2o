import { useCallback, useEffect, useState } from "react";
import { loadExportExperiment, loadExportReadings } from "./experimentExportClient";
import type { PortalExperiment } from "./experimentRegistry";
import { incrementalCursorOverlapMs } from "./portalConstants";
import type { SensorReading, ValveEvent } from "./types";
import { loadExperimentValveEvents } from "./experimentValveHistory";

type Result = { key: string; readings: SensorReading[]; valveEvents: ValveEvent[]; loading: boolean; progress: number; error: string | null };
type Archive = { revisionId?: string; pairingNames: readonly string[]; readings: SensorReading[]; valveEvents: ValveEvent[]; readingsSince: string | null; valveEventsSince: string | null };
type Query = { projectId: string; deviceId: string; pairingNames: readonly string[]; startMs: number | null; endMs: number; signal: AbortSignal };
const emptyReadings: SensorReading[] = [];
const emptyValveEvents: ValveEvent[] = [];
// Completed archives for the signed-in account, in memory only, least recently used first.
const archives = new Map<string, Archive>();
let archiveOwner: string | null | undefined;
const keptArchives = 2;
const concurrentSlices = 4;
const rowsPerSlice = 8_000;

/** Forget every held archive, e.g. when the session ends. */
export function clearExperimentArchives() {
  archives.clear();
}

/**
 * A server time from which an incremental read cannot miss a row this snapshot lacks: the newest
 * arrival seen, less the commit overlap and the time the read itself took.
 */
function receivedCursor(rows: readonly { server_received_at: string }[], readMs: number) {
  let newest = -Infinity;
  for (const row of rows) newest = Math.max(newest, Date.parse(row.server_received_at));
  return Number.isFinite(newest) ? new Date(newest - incrementalCursorOverlapMs - readMs).toISOString() : null;
}

/** Newest first by recorded time, then id, like one keyset-paged read; rows already held stay once, in place. */
function mergeNewest<T extends { id: number; device_recorded_at: string }>(held: T[], incoming: readonly T[]) {
  const at = (row: T) => Date.parse(row.device_recorded_at);
  const precedes = (a: T, b: T) => at(a) > at(b) || (at(a) === at(b) && a.id > b.id);
  const added: Array<{ index: number; row: T }> = [];
  for (const row of incoming) {
    let low = 0;
    let high = held.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (precedes(held[middle], row)) low = middle + 1;
      else high = middle;
    }
    // Stored times carry microseconds; Date.parse keeps milliseconds, so look across that millisecond.
    const atMs = at(row);
    let known = false;
    for (let index = low; !known && index < held.length && at(held[index]) === atMs; index += 1) known = held[index].id === row.id;
    for (let index = low - 1; !known && index >= 0 && at(held[index]) === atMs; index -= 1) known = held[index].id === row.id;
    if (!known) added.push({ index: low, row });
  }
  if (!added.length) return held;
  added.sort((a, b) => a.index - b.index || (precedes(a.row, b.row) ? -1 : 1));
  const merged: T[] = [];
  let from = 0;
  for (const { index, row } of added) {
    while (from < index) merged.push(held[from++]);
    merged.push(row);
  }
  while (from < held.length) merged.push(held[from++]);
  return merged;
}

const sameNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * The full archive in time slices, newest first, a few read at once. While older slices load, only
 * the unbroken run back from the newest reading is shown, so a slice still in flight never looks
 * like a gap in the record. The result is in the order of one keyset-paged read.
 */
async function loadReadingSlices(query: Query, intervalMs: number, show: (readings: SensorReading[] | null, fetched: number) => void) {
  const { startMs, endMs } = query;
  const count = startMs === null || !(endMs > startMs) ? 1
    : Math.min(64, Math.max(1, Math.ceil((query.pairingNames.length * (endMs - startMs)) / intervalMs / rowsPerSlice)));
  const edge = (index: number) => index === 0 ? endMs : index === count ? startMs : Math.round(endMs - ((endMs - startMs!) * index) / count);
  const slices = Array.from({ length: count }, () => ({ rows: [] as SensorReading[], done: false }));
  let next = 0;
  let fetched = 0;
  let shown = 0;
  let shownAt = 0;
  const update = () => {
    let run = 0;
    let complete = true;
    for (const slice of slices) {
      run += slice.rows.length;
      if (!slice.done) { complete = false; break; }
    }
    if (complete) return;
    // Every publish rebuilds the chart from all readings, so grow it in geometric steps.
    if (run >= Math.max(1, shown * 1.5)) {
      shown = run;
      shownAt = Date.now();
      const readings: SensorReading[] = [];
      for (const slice of slices) {
        for (const row of slice.rows) readings.push(row);
        if (!slice.done) break;
      }
      show(readings, fetched);
    } else if (Date.now() - shownAt >= 250) {
      shownAt = Date.now();
      show(null, fetched);
    }
  };
  const work = async () => {
    while (next < count) {
      const index = next++;
      const slice = slices[index];
      await loadExportReadings({ ...query, startMs: edge(index + 1), endMs: edge(index) as number, endExclusive: index > 0, onPage: (rows) => {
        for (const row of rows) slice.rows.push(row);
        fetched += rows.length;
        update();
      } });
      slice.done = true;
      update();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrentSlices, count) }, work));
  return slices.flatMap((slice) => slice.rows);
}

/**
 * The experiment's full archive. A completed archive stays in memory for this account and is shown
 * at once when the experiment reopens; only rows stored since are then read. Live polling stays
 * small and independent.
 */
export function useExperimentReadings(experiment: PortalExperiment, projectId: string, deviceId: string, enabled: boolean, userId?: string | null) {
  const key = JSON.stringify([userId ?? null, projectId, deviceId, experiment.id, experiment.startedAt, experiment.endedAt]);
  const [result, setResult] = useState<Result | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled || !projectId || !deviceId) return;
    if (archiveOwner !== userId) {
      archives.clear();
      archiveOwner = userId;
    }
    const controller = new AbortController();
    let active = true;
    const held = archives.get(key);
    let shown = held?.readings ?? emptyReadings;
    setResult({ key, readings: shown, valveEvents: held?.valveEvents ?? emptyValveEvents, loading: true, progress: shown.length, error: null });
    void (async () => {
      const startedAt = Date.now();
      // The plan's reading scope only changes with a new revision.
      const pairingNames = held && held.revisionId === experiment.currentRevisionId ? held.pairingNames : (await loadExportExperiment(experiment)).pairingNames;
      if (!active) return;
      const query = {
        projectId, deviceId, pairingNames,
        startMs: experiment.startedAt ? Date.parse(experiment.startedAt) : null,
        endMs: experiment.endedAt ? Date.parse(experiment.endedAt) : Date.now(),
        signal: controller.signal,
      };
      const base = held && sameNames(held.pairingNames, pairingNames) ? held : null;
      const minutes = (experiment.assignments ?? []).map((item) => item.measurement_interval_minutes ?? 0).filter((value) => value > 0);
      const intervalMs = (minutes.length ? Math.min(...minutes) : 5) * 60_000;
      const [readings, valveEvents] = await Promise.all([
        base?.readingsSince
          ? loadExportReadings({ ...query, receivedSince: base.readingsSince }).then((fresh) => mergeNewest(base.readings, fresh.readings))
          : loadReadingSlices(query, intervalMs, (rows, progress) => {
            if (!active) return;
            if (rows) shown = rows;
            setResult((old) => old && { ...old, readings: shown, progress });
          }),
        base?.valveEventsSince
          ? loadExperimentValveEvents({ ...query, receivedSince: base.valveEventsSince }).then((fresh) => mergeNewest(base.valveEvents, fresh))
          : loadExperimentValveEvents(query),
      ]);
      if (!active) return;
      const readMs = Date.now() - startedAt;
      archives.delete(key);
      archives.set(key, { revisionId: experiment.currentRevisionId, pairingNames, readings, valveEvents, readingsSince: receivedCursor(readings, readMs), valveEventsSince: receivedCursor(valveEvents, readMs) });
      while (archives.size > keptArchives) archives.delete(archives.keys().next().value!);
      setResult({ key, readings, valveEvents, loading: false, progress: readings.length, error: null });
    })().catch((failure: unknown) => {
      controller.abort();
      if (active) setResult({ key, readings: shown, valveEvents: held?.valveEvents ?? emptyValveEvents, loading: false, progress: 0, error: failure instanceof Error ? failure.message : "Could not load experiment readings." });
    });
    return () => { active = false; controller.abort(); };
  }, [deviceId, enabled, experiment, key, projectId, revision, userId]);
  const current = result?.key === key && enabled ? result : null;
  return { readings: current?.readings ?? emptyReadings, valveEvents: current?.valveEvents ?? emptyValveEvents, loading: current?.loading ?? enabled, progress: current?.progress ?? 0, error: current?.error ?? null, retry };
}
