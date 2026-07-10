import type { PairingRow, SensorReading } from "./types";

export type DataMode = "auto" | "live" | "snapshot" | "combined";
export type EffectiveMode = Exclude<DataMode, "auto">;

const graphReadLimit = 12_000;
const ignoredDiagnosticPairingNames = new Set(["cwd-lowercaset", "720-1539"]);
const ignoredDiagnosticSensorKeys = new Set(["t", "d30gqn2d:t"]);
const ignoredDiagnosticValveKeys = new Set(["1539", "0x20:3", "d30gqn2d:0x20:3"]);
const ignoredDiagnosticSensorIds = new Set([720]);
const ignoredDiagnosticValveIds = new Set([1539]);

function normalizedDiagnosticText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isIgnoredDiagnosticPairingName(value: unknown) {
  return ignoredDiagnosticPairingNames.has(normalizedDiagnosticText(value));
}

function isIgnoredDiagnosticSensorKey(value: unknown) {
  return ignoredDiagnosticSensorKeys.has(normalizedDiagnosticText(value));
}

function isIgnoredDiagnosticValveKey(value: unknown) {
  return ignoredDiagnosticValveKeys.has(normalizedDiagnosticText(value));
}

function isIgnoredDiagnosticNumber(value: unknown, ignored: Set<number>) {
  if (typeof value === "number") return ignored.has(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return ignored.has(Number(value));
  }
  return false;
}

function isIgnoredDiagnosticPairing(pairing: Partial<PairingRow>) {
  return (
    isIgnoredDiagnosticPairingName(pairing.name) ||
    isIgnoredDiagnosticSensorKey(pairing.sensor_key) ||
    isIgnoredDiagnosticValveKey(pairing.valve_key) ||
    isIgnoredDiagnosticNumber(pairing.source_sensor_id, ignoredDiagnosticSensorIds) ||
    isIgnoredDiagnosticNumber(pairing.source_valve_id, ignoredDiagnosticValveIds)
  );
}

export function visibleExperimentPairings(pairings: PairingRow[]) {
  return pairings.filter((pairing) => !isIgnoredDiagnosticPairing(pairing));
}

export function isIgnoredDiagnosticReading(reading: Partial<SensorReading>) {
  return (
    isIgnoredDiagnosticPairingName(reading.pairing_name) ||
    isIgnoredDiagnosticSensorKey(reading.sensor_key)
  );
}

export function isIgnoredDiagnosticValveEvent(event: {
  pairing_name?: unknown;
  pairing?: unknown;
  valve_key?: unknown;
  valve?: unknown;
  source_valve_id?: unknown;
}) {
  return (
    isIgnoredDiagnosticPairingName(event.pairing_name) ||
    isIgnoredDiagnosticPairingName(event.pairing) ||
    isIgnoredDiagnosticValveKey(event.valve_key) ||
    isIgnoredDiagnosticValveKey(event.valve) ||
    isIgnoredDiagnosticNumber(event.source_valve_id, ignoredDiagnosticValveIds)
  );
}

export function resolveEffectiveMode(mode: DataMode, hasLiveReadings: boolean): EffectiveMode {
  if (mode === "auto") return hasLiveReadings ? "live" : "snapshot";
  return mode;
}

export function dedupeReadings(readings: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const reading of readings) {
    if (isIgnoredDiagnosticReading(reading)) continue;
    byKey.set(reading.event_id || String(reading.id), reading);
  }

  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        new Date(b.device_recorded_at).getTime() -
        new Date(a.device_recorded_at).getTime(),
    )
    .slice(0, graphReadLimit);
}

export function mergeReadings(base: SensorReading[], incoming: SensorReading[]) {
  return dedupeReadings([...base, ...incoming]);
}

export function booleanMarker(
  value: unknown,
  trueValue = 1,
  falseValue = 0,
): number | null {
  if (typeof value !== "boolean") return null;
  return value ? trueValue : falseValue;
}

export function sumKnownCounts(
  ...values: Array<number | null | undefined>
): number | null {
  if (values.some((value) => value == null || !Number.isFinite(value))) return null;
  return values.reduce<number>((total, value) => total + (value as number), 0);
}

type HealthEvidenceRecords = {
  snapshotStatus?: Record<string, unknown> | null;
  snapshotHealth?: Record<string, unknown> | null;
  runtimeStatus?: Record<string, unknown> | null;
  runtimeHealth?: Record<string, unknown> | null;
  runtimeFresh: boolean;
};

function nestedHealthRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
) {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

function firstKnownHealthValue(
  sources: Array<Record<string, unknown> | null | undefined>,
  key: string,
) {
  for (const source of sources) {
    const value = source?.[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

export function healthEvidenceValue(
  records: HealthEvidenceRecords,
  key: string,
) {
  const snapshotOwner = nestedHealthRecord(records.snapshotHealth, "ownerStatus");
  const runtimeOwner = records.runtimeFresh
    ? nestedHealthRecord(records.runtimeHealth, "ownerStatus")
    : null;

  return firstKnownHealthValue([
    runtimeOwner,
    records.runtimeFresh ? records.runtimeHealth : null,
    records.runtimeFresh ? records.runtimeStatus : null,
    snapshotOwner,
    records.snapshotHealth,
    records.snapshotStatus,
  ], key);
}
