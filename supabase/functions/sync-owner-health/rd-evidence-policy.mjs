export function normalizePairToken(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.replace(/[;,:]+$/g, "");
}

function asFiniteNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function researcherPairingMap(health) {
  const rows = health?.api?.researcherMap?.rows;
  const result = new Map();
  if (!Array.isArray(rows)) return result;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const sensorId = asFiniteNumber(row.sensorId);
    const valveId = asFiniteNumber(row.valveId);
    const pairingName = row.actualName || row.softwarePairing;
    if (
      sensorId == null || valveId == null || typeof pairingName !== "string"
    ) continue;
    result.set(`${sensorId}-${valveId}`, pairingName.trim());
  }
  return result;
}

export function resolveEvidencePairing(rawPairing, health) {
  const normalized = normalizePairToken(rawPairing);
  const pairingMap = researcherPairingMap(health);
  const mapped = pairingMap.get(normalized);
  const configuredName = [...pairingMap.values()].find((name) =>
    name === normalized
  );
  return {
    raw: typeof rawPairing === "string" ? rawPairing.trim() : "",
    normalized,
    pairingName: mapped || configuredName || normalized || "unknown",
    resolved: Boolean(mapped || configuredName),
  };
}

export function collectLiveReadingRows(health, context) {
  const rows = health?.api?.researcherMap?.rows;
  if (!Array.isArray(rows)) return [];
  const readings = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.ok !== true) continue;
    const latest = row.latestReading;
    if (!latest || typeof latest !== "object") continue;
    const deviceRecordedAt = typeof latest.createdAt === "string"
      ? latest.createdAt
      : null;
    const pairingName = row.actualName || row.softwarePairing;
    const sensorId = asFiniteNumber(row.sensorId);
    const calibratedValue = asFiniteNumber(latest.calibratedValue);
    const rawValue = asFiniteNumber(latest.rawValue);
    if (
      !deviceRecordedAt || typeof pairingName !== "string" ||
      sensorId == null || calibratedValue == null
    ) {
      continue;
    }
    readings.push({
      organization_id: context.organizationId,
      project_id: context.projectId,
      device_id: context.deviceId,
      event_id:
        `live-device:${context.deviceId}:${sensorId}:${deviceRecordedAt}`,
      pairing_name: pairingName.trim(),
      sensor_key: String(row.actualSensor || sensorId),
      raw_value: rawValue ?? calibratedValue,
      calibrated_value: calibratedValue,
      temperature: asFiniteNumber(latest.temperature),
      electrical_conductivity: asFiniteNumber(latest.electricalConductivity),
      device_recorded_at: deviceRecordedAt,
      server_received_at: context.serverReceivedAt,
    });
  }
  return readings;
}

const evidencePriority = {
  owner_health_direct: 3,
  owner_health_history: 2,
  owner_health_scalar: 1,
  unknown: 0,
};

export function semanticDedupeValveEvents(events) {
  const deduped = new Map();
  for (const event of events) {
    const second = String(event.device_recorded_at || "").replace(
      /\.\d{3}(?=Z|[+-])/u,
      "",
    );
    const key = [event.pairing_name, event.action, second].join("|");
    const previous = deduped.get(key);
    if (
      !previous ||
      (evidencePriority[event.evidence_source] ?? 0) >
        (evidencePriority[previous.evidence_source] ?? 0)
    ) {
      deduped.set(key, event);
    }
  }
  return [...deduped.values()];
}
