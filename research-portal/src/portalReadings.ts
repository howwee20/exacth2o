import { importedPrefix, incrementalCursorOverlapMs, livePrefix, pageSize, readingSelectColumns, supabaseQueryTimeoutMs } from "./portalConstants";
import { dedupeReadings, type EffectiveMode, isIgnoredDiagnosticReading, rollingExperimentHistoryStart, rollingExperimentReadLimit } from "./portalData";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { type SensorReading } from "./types";

export function newestByTime<T extends { device_recorded_at: string }>(items: T[]) {
  return (
    items.slice().sort(
      (a, b) =>
        new Date(b.device_recorded_at).getTime() -
        new Date(a.device_recorded_at).getTime(),
    )[0] ?? null
  );
}

export function incrementalReadingCursor(readings: SensorReading[]) {
  const timestamps = readings
    .map((reading) => Date.parse(reading.server_received_at))
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps) - incrementalCursorOverlapMs).toISOString();
}
export async function fetchReadingsPageByPrefix(
  projectId: string,
  deviceId: string,
  prefix: string,
  limit: number,
  options: {
    newerThan?: string | null;
    before?: { timestamp: string; id: number } | null;
    recordedAtOrAfter?: string | null;
  } = {},
) {
  const orderColumn = options.newerThan ? "server_received_at" : "device_recorded_at";
  let query = supabase
    .from("sensor_readings")
    .select(readingSelectColumns)
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .like("event_id", prefix)
    .order(orderColumn, { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(limit, pageSize));

  const { newerThan, before, recordedAtOrAfter } = options;
  if (newerThan) {
    query = query.gte("server_received_at", newerThan);
  }
  if (recordedAtOrAfter) {
    query = query.gte("device_recorded_at", recordedAtOrAfter);
  }
  if (before) {
    query = query.or(
      `${orderColumn}.lt.${before.timestamp},and(${orderColumn}.eq.${before.timestamp},id.lt.${before.id})`,
    );
  }

  const response = await withSupabaseTimeout(query, supabaseQueryTimeoutMs, "Sensor readings");
  if (response.error) throw response.error;
  return (response.data ?? []) as SensorReading[];
}

export async function fetchReadingsByPrefix(
  projectId: string,
  deviceId: string,
  prefix: string,
  maxRows: number,
  newerThan?: string | null,
  onBatch?: (batch: SensorReading[]) => void,
  recordedAtOrAfter?: string | null,
) {
  const readings: SensorReading[] = [];
  let before: { timestamp: string; id: number } | null = null;
  const orderColumn = newerThan ? "server_received_at" : "device_recorded_at";

  while (readings.length < maxRows) {
    const batchLimit = Math.min(pageSize, maxRows - readings.length);
    const rawBatch = await fetchReadingsPageByPrefix(
      projectId,
      deviceId,
      prefix,
      batchLimit,
      { newerThan, before, recordedAtOrAfter },
    );
    if (rawBatch.length === 0) break;

    const visibleBatch = rawBatch
      .filter((reading) => !isIgnoredDiagnosticReading(reading))
      .slice(0, maxRows - readings.length);
    readings.push(...visibleBatch);
    onBatch?.(visibleBatch);

    const lastRow = rawBatch[rawBatch.length - 1];
    const timestamp = lastRow?.[orderColumn];
    const id = Number(lastRow?.id);
    const nextBefore = typeof timestamp === "string" && Number.isFinite(id)
      ? { timestamp, id }
      : null;
    if (!nextBefore || (before?.timestamp === nextBefore.timestamp && before.id === nextBefore.id)) break;
    before = nextBefore;
    if (rawBatch.length < batchLimit) break;
  }

  return readings;
}

export async function fetchReadingsForMode(
  projectId: string,
  deviceId: string,
  mode: EffectiveMode,
  newerThan?: string | null,
  onBatch?: (batch: SensorReading[]) => void,
) {
  const recordedAtOrAfter = rollingExperimentHistoryStart();
  if (mode === "live") {
    return fetchReadingsByPrefix(
      projectId,
      deviceId,
      livePrefix,
      rollingExperimentReadLimit,
      newerThan,
      onBatch,
      recordedAtOrAfter,
    );
  }

  if (mode === "snapshot") {
    return fetchReadingsByPrefix(
      projectId,
      deviceId,
      importedPrefix,
      rollingExperimentReadLimit,
      newerThan,
      onBatch,
      recordedAtOrAfter,
    );
  }

  const [liveReadings, importedReadings] = await Promise.all([
    fetchReadingsByPrefix(
      projectId,
      deviceId,
      livePrefix,
      rollingExperimentReadLimit,
      newerThan,
      onBatch,
      recordedAtOrAfter,
    ),
    fetchReadingsByPrefix(
      projectId,
      deviceId,
      importedPrefix,
      rollingExperimentReadLimit,
      newerThan,
      onBatch,
      recordedAtOrAfter,
    ),
  ]);

  return dedupeReadings([...liveReadings, ...importedReadings]);
}

export function loadedReadingCounts(readings: SensorReading[]) {
  return readings.reduce(
    (counts, reading) => {
      if (reading.event_id.startsWith("live-device:")) counts.live += 1;
      if (reading.event_id.startsWith("balena-export-v2:")) counts.imported += 1;
      return counts;
    },
    { imported: 0, live: 0 },
  );
}

export function sourceLabelForReading(reading: SensorReading) {
  if (reading.event_id.startsWith("live-device:")) return "live";
  if (reading.event_id.startsWith("balena-export-v2:")) return "snapshot";
  return "unknown";
}
