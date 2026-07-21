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
    isIgnoredDiagnosticNumber(pairing.source_sensor_id, ignoredDiagnosticSensorIds)
  );
}

export function visibleExperimentPairings(pairings: PairingRow[]) {
  return pairings.filter((pairing) => !isIgnoredDiagnosticPairing(pairing));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert the controller's mirrored config into the portal's normalized shape.
 * device_config_state is the authoritative live configuration; public.pairings
 * is retained only as a legacy fallback because it can drift from the device.
 */
export function pairingsFromDeviceConfigState(
  pairings: unknown,
  groups: unknown,
): PairingRow[] {
  if (!Array.isArray(pairings)) return [];

  const groupNames = new Map<number, string>();
  if (Array.isArray(groups)) {
    for (const rawGroup of groups) {
      const group = recordValue(rawGroup);
      const id = finiteNumber(group?.id);
      const name = typeof group?.name === "string" ? group.name.trim() : "";
      if (id !== null && name) groupNames.set(id, name);
    }
  }

  const normalized: PairingRow[] = [];
  for (const rawPairing of pairings) {
    const pairing = recordValue(rawPairing);
    if (!pairing) continue;

    const name = typeof pairing.name === "string" ? pairing.name.trim() : "";
    const label = /^Zone(\d+)-Pot(\d+)$/i.exec(name);
    const sensor = recordValue(pairing.Sensor);
    const valve = recordValue(pairing.Valve);
    const calibration = recordValue(pairing.Calibration);
    const sourceSensorId = finiteNumber(pairing.sensorId);
    const sourceValveId = finiteNumber(pairing.valveId);
    const zone = label ? Number(label[1]) : null;
    const potNumber = label ? Number(label[2]) : null;
    const sensorBoard = typeof sensor?.boardSerialId === "string" ? sensor.boardSerialId.trim() : "";
    const sensorAddress = typeof sensor?.address === "string" ? sensor.address.trim() : String(sensor?.address ?? "").trim();
    const relayAddress = typeof valve?.relayAddress === "string" ? valve.relayAddress.trim() : "";
    const valveAddress = typeof valve?.address === "string" ? valve.address.trim() : String(valve?.address ?? "").trim();
    const target = finiteNumber(pairing.WTCPercentLimit);
    const openTime = finiteNumber(pairing.ValveOpenTime);
    const interval = finiteNumber(pairing.MeasurementInterval);

    if (
      !name || zone === null || potNumber === null ||
      sourceSensorId === null || sourceValveId === null ||
      !sensorBoard || !sensorAddress || !relayAddress || !valveAddress ||
      target === null || openTime === null || interval === null
    ) continue;

    const groupId = finiteNumber(pairing.groupId);
    const groupName = groupId === null ? null : groupNames.get(groupId) ?? null;
    const calibrationName = typeof calibration?.name === "string" ? calibration.name.trim() : null;

    normalized.push({
      id: sourceSensorId,
      name,
      zone,
      pot_number: potNumber,
      group_name: groupName,
      source_sensor_id: sourceSensorId,
      sensor_key: `${sensorBoard}:${sensorAddress}`,
      source_valve_id: sourceValveId,
      valve_key: `${relayAddress}:${valveAddress}`,
      wtc_percent_limit: target,
      valve_open_time_ms: openTime,
      measurement_interval_ms: interval,
      calibration_name: calibrationName,
      calibration_id: finiteNumber(pairing.calibrationId),
    });
  }

  return normalized;
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
  const pairingIdentity = normalizedDiagnosticText(event.pairing_name) ||
    normalizedDiagnosticText(event.pairing);
  return (
    isIgnoredDiagnosticPairingName(event.pairing_name) ||
    isIgnoredDiagnosticPairingName(event.pairing) ||
    (!pairingIdentity && (
      isIgnoredDiagnosticValveKey(event.valve_key) ||
      isIgnoredDiagnosticValveKey(event.valve) ||
      isIgnoredDiagnosticNumber(event.source_valve_id, ignoredDiagnosticValveIds)
    ))
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
