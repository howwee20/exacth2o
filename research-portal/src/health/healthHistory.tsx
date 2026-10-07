import { ArrowLeft, ArrowRight } from "lucide-react";
import { healthBoolean, healthNumber, healthRecord, healthString, healthTimestampMs } from "../healthValues";
import { healthChartWindowHours } from "../portalConstants";
import { healthEvidenceValue, sumKnownCounts } from "../portalData";
import { runtimeStateIsFresh } from "../portalFormat";
import { type DeviceHealthSnapshot, type DeviceRuntimeState, type HealthChartPoint, type HealthChartWindow, type HealthHistoryRecord } from "../portalTypes";

export function healthDurationText(secondsValue: unknown) {
  const seconds = healthNumber(secondsValue);
  if (seconds == null) return "--";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours) return `uptime ${hours}h ${minutes}m`;
  if (minutes) return `uptime ${minutes}m`;
  return `uptime ${rounded}s`;
}

export function healthCompactDuration(msValue: number | null) {
  if (msValue == null || !Number.isFinite(msValue)) return "--";
  const seconds = Math.max(0, Math.round(msValue / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

export function healthHistoryRecords(
  snapshot: DeviceHealthSnapshot | null,
  snapshots: DeviceHealthSnapshot[] = [],
): HealthHistoryRecord[] {
  const records = snapshot?.raw_history?.records;
  if (Array.isArray(records) && records.length > 0) {
    return records
      .map((record) => healthRecord(record) as HealthHistoryRecord)
      .filter((record) => healthTimestampMs(record.t) != null)
      .sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0));
  }

  return snapshots
    .map((item) => ({
      t: item.captured_at ?? item.created_at,
      uptimeSeconds: item.uptime_seconds,
      ethUp: item.ethernet_link,
      cpuTempC: item.cpu_temp_c,
      undervoltage: item.undervoltage,
      undervoltageOccurred: null,
      staleOrMissingSensors:
        item.sensors_stale == null || item.sensors_missing == null
          ? null
          : item.sensors_stale + item.sensors_missing,
      sensorRows: item.sensors_current,
    }))
    .filter((record) => healthTimestampMs(record.t) != null)
    .sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0));
}

export function healthRecentRecords(records: HealthHistoryRecord[], hours: number) {
  if (records.length < 3) return records;
  const last = healthTimestampMs(records[records.length - 1]?.t);
  if (last == null) return records;
  const start = last - hours * 60 * 60 * 1000;
  const recent = records.filter((record) => {
    const time = healthTimestampMs(record.t);
    return time != null && time >= start;
  });
  return recent.length >= 3 ? recent : records;
}

export function healthChartPoint(record: HealthHistoryRecord, key: string, fallback: number | null = null): HealthChartPoint {
  const time = healthTimestampMs(record.t) ?? Date.now();
  return {
    t: time,
    iso: healthString(record.t) ?? new Date(time).toISOString(),
    value: healthNumber(record[key]) ?? fallback,
  };
}

export function healthChartWindow(times: number[], offset: number, windowHours = healthChartWindowHours): HealthChartWindow {
  const spanMs = windowHours * 60 * 60 * 1000;
  const validTimes = times.filter((time) => Number.isFinite(time)).sort((a, b) => a - b);
  const now = Date.now();

  if (!validTimes.length) {
    return {
      startMs: now - spanMs,
      endMs: now,
      maxOffset: 0,
    };
  }

  const first = validTimes[0];
  const last = validTimes[validTimes.length - 1];
  if (last <= first || last - first <= spanMs) {
    return {
      startMs: first,
      endMs: Math.max(first + 1, last),
      maxOffset: 0,
    };
  }

  const maxOffset = Math.max(0, Math.ceil((last - first) / spanMs) - 1);
  const safeOffset = Math.max(0, Math.min(offset, maxOffset));
  let endMs = last - safeOffset * spanMs;
  let startMs = endMs - spanMs;

  if (startMs < first) {
    startMs = first;
    endMs = Math.min(last, first + spanMs);
  }

  return {
    startMs,
    endMs: Math.max(startMs + 1, endMs),
    maxOffset,
  };
}

export function HealthChartControls({
  windowOffset,
  maxOffset,
  onChange,
}: {
  windowOffset: number;
  maxOffset: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="health-chart-controls" aria-label="Chart time window">
      <button
        type="button"
        aria-label="Older samples"
        title="Older samples"
        disabled={windowOffset >= maxOffset}
        onClick={() => onChange(Math.min(maxOffset, windowOffset + 1))}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        type="button"
        aria-label="Newer samples"
        title="Newer samples"
        disabled={windowOffset <= 0}
        onClick={() => onChange(Math.max(0, windowOffset - 1))}
      >
        <ArrowRight size={14} />
      </button>
      <button
        type="button"
        className="health-chart-reset"
        disabled={windowOffset === 0}
        onClick={() => onChange(0)}
      >
        Reset
      </button>
    </div>
  );
}

export function healthOwnerValue(
  snapshot: DeviceHealthSnapshot | null,
  runtimeState: DeviceRuntimeState | null,
  key: string,
) {
  return healthEvidenceValue({
    snapshotStatus: snapshot?.raw_status,
    snapshotHealth: snapshot?.raw_health,
    runtimeStatus: runtimeState?.raw_status,
    runtimeHealth: runtimeState?.raw_health,
    runtimeFresh: runtimeStateIsFresh(runtimeState),
  }, key);
}

export function currentUptimeSeconds(
  snapshot: DeviceHealthSnapshot | null,
  runtimeState: DeviceRuntimeState | null,
  records: HealthHistoryRecord[],
) {
  return (
    healthNumber(healthOwnerValue(snapshot, runtimeState, "current_uptime_seconds")) ??
    healthNumber(healthOwnerValue(snapshot, runtimeState, "uptime_seconds")) ??
    snapshot?.uptime_seconds ??
    healthNumber(records[records.length - 1]?.uptimeSeconds)
  );
}

export function currentHealthObservation(
  snapshot: DeviceHealthSnapshot | null,
  runtimeState: DeviceRuntimeState | null,
  uptimeSeconds: number | null,
): HealthHistoryRecord | null {
  if (!runtimeStateIsFresh(runtimeState) || !runtimeState?.state_observed_at) return null;
  const staleOrMissingSensors = sumKnownCounts(
    runtimeState.sensors_stale ?? snapshot?.sensors_stale,
    runtimeState.sensors_missing ?? snapshot?.sensors_missing,
  );
  return {
    t: runtimeState.state_observed_at,
    uptimeSeconds,
    ethUp:
      healthBoolean(healthOwnerValue(snapshot, runtimeState, "ethernet_link")) ??
      snapshot?.ethernet_link ??
      null,
    cpuTempC:
      healthNumber(healthOwnerValue(snapshot, runtimeState, "cpu_temp_c")) ??
      snapshot?.cpu_temp_c ??
      null,
    undervoltage:
      healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_current")) ??
      snapshot?.undervoltage ??
      null,
    undervoltageOccurred: healthBoolean(
      healthOwnerValue(snapshot, runtimeState, "undervoltage_occurred"),
    ),
    staleOrMissingSensors,
    sensorRows: runtimeState.sensors_current ?? snapshot?.sensors_current ?? null,
  };
}

export function mergeHealthObservation(
  records: HealthHistoryRecord[],
  observation: HealthHistoryRecord | null,
) {
  if (!observation || healthTimestampMs(observation.t) == null) return records;
  const byTimestamp = new Map<number, HealthHistoryRecord>();
  records.forEach((record) => {
    const timestamp = healthTimestampMs(record.t);
    if (timestamp != null) byTimestamp.set(timestamp, record);
  });
  const observationTimestamp = healthTimestampMs(observation.t) as number;
  byTimestamp.set(observationTimestamp, {
    ...(byTimestamp.get(observationTimestamp) ?? {}),
    ...observation,
  });
  return Array.from(byTimestamp.entries())
    .sort(([left], [right]) => left - right)
    .map(([, record]) => record);
}

export function restartEvents(records: HealthHistoryRecord[]) {
  const events: Array<{ t: string; detectedAt: string; previous: string; uptimeSeconds: number; previousUptimeSeconds: number }> = [];
  let previous: HealthHistoryRecord | null = null;
  records.forEach((record) => {
    const uptime = healthNumber(record.uptimeSeconds);
    const previousUptime = previous ? healthNumber(previous.uptimeSeconds) : null;
    const recordTime = healthTimestampMs(record.t);
    if (previous && previousUptime != null && uptime != null && uptime + 90 < previousUptime && recordTime != null) {
      const bootMs = recordTime - uptime * 1000;
      events.push({
        t: new Date(bootMs).toISOString(),
        detectedAt: healthString(record.t) ?? new Date(recordTime).toISOString(),
        previous: healthString(previous.t) ?? "",
        uptimeSeconds: uptime,
        previousUptimeSeconds: previousUptime,
      });
    }
    previous = record;
  });
  return events;
}

export function monitoringGaps(records: HealthHistoryRecord[], sampleIntervalSeconds = 300) {
  const thresholdMs = Math.max(8 * 60 * 1000, sampleIntervalSeconds * 2.25 * 1000);
  const gaps: Array<{ start: string; end: string; durationMs: number }> = [];
  records.forEach((record, index) => {
    if (!index) return;
    const previous = records[index - 1];
    const start = healthTimestampMs(previous.t);
    const end = healthTimestampMs(record.t);
    if (start == null || end == null) return;
    const durationMs = end - start;
    if (durationMs > thresholdMs) {
      gaps.push({
        start: healthString(previous.t) ?? new Date(start).toISOString(),
        end: healthString(record.t) ?? new Date(end).toISOString(),
        durationMs,
      });
    }
  });
  return gaps;
}
