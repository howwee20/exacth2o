import { healthEventText, healthFirstEventText, healthNumber, healthString, healthTimestampMs } from "./healthValues";
import { dayMs, maxValveEventRows, wateringEventDedupeBucketMs, wateringHistoryMs } from "./portalConstants";
import { isIgnoredDiagnosticValveEvent } from "./portalData";
import { treatmentForPairing } from "./portalPresentation";
import { type HealthWateringEvent } from "./portalTypes";
import { type PairingRow, type ValveEvent } from "./types";

export function wateringEventPhysicalKey(event: HealthWateringEvent) {
  const timeMs = healthTimestampMs(event.t);
  if (timeMs == null) return null;

  const record = event as Record<string, unknown>;
  const sourceSensorId =
    healthNumber(record.source_sensor_id) ??
    healthNumber(record.sourceSensorId) ??
    healthNumber(record.sensor_id) ??
    healthNumber(record.sensorId);
  const sourceValveId =
    healthNumber(record.source_valve_id) ??
    healthNumber(record.sourceValveId) ??
    healthNumber(record.valve_id) ??
    healthNumber(record.valveId);
  const sourcePair = sourcePairKey(sourceSensorId, sourceValveId);
  const pot =
    healthNumber(event.physicalPot) ??
    healthNumber(record.physical_pot) ??
    healthNumber(record.pot_number) ??
    healthNumber(record.pot);
  const valve =
    normalizedWateringToken(event.valve) ||
    normalizedWateringToken(record.valve_key) ||
    normalizedWateringToken(record.valveKey) ||
    normalizedWateringToken(record.valve_id) ||
    normalizedWateringToken(record.valveId);
  const pairing =
    normalizedWateringToken(event.pairing) ||
    normalizedWateringToken(event.pairingName) ||
    normalizedWateringToken(record.pairing_name) ||
    normalizedWateringToken(record.pairingName) ||
    normalizedWateringToken(record.name);
  const identity =
    pot != null ? `pot:${Math.trunc(pot)}` :
    sourcePair ? `pair:${sourcePair}` :
    sourceValveId != null ? `source-valve:${Math.trunc(sourceValveId)}` :
    valve ? `valve:${valve}` :
    pairing ? `pairing:${pairing}` :
    null;
  if (!identity) return null;

  const duration =
    healthNumber(event.valveOpenTimeMs) ??
    healthNumber(record.valve_open_time_ms) ??
    healthNumber(record.duration_ms) ??
    healthNumber(record.durationMs);
  const action = normalizedWateringToken(record.action) || "open";
  const timeBucket = Math.floor(timeMs / wateringEventDedupeBucketMs);
  const durationBucket = duration == null ? "unknown-duration" : String(Math.round(duration / 1000));

  return `${timeBucket}:${identity}:${action}:${durationBucket}`;
}

export function dedupeWateringEvents(events: HealthWateringEvent[]) {
  const seen = new Set<string>();
  return events
    .filter((event) => healthTimestampMs(event.t) != null)
    .filter((event) => {
      const record = event as Record<string, unknown>;
      const key = wateringEventPhysicalKey(event) ??
        healthFirstEventText(record, ["event_id", "eventId", "id"]) ??
        `${event.t}-${healthString(event.pairing) ?? wateringEventLabel(event)}-${healthFirstEventText(record, ["valve", "valve_key", "valveKey"]) ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0));
}

export function pairingLabel(pairing: PairingRow) {
  return `Pot ${pairing.pot_number}`;
}

export function wateringAxisLabel(pairing: PairingRow) {
  const treatment = treatmentForPairing(pairing);
  const shortTreatment =
    treatment === "control" ? "C" :
    treatment === "drought" ? "D" :
    "";
  return shortTreatment ? `${pairingLabel(pairing)} ${shortTreatment}` : pairingLabel(pairing);
}

export type WateringPairingIndex = {
  byLabel: Map<string, PairingRow>;
  bySourcePair: Map<string, PairingRow>;
  bySensorId: Map<string, PairingRow>;
  byValveId: Map<string, PairingRow>;
  bySensorKey: Map<string, PairingRow>;
  byValveKey: Map<string, PairingRow>;
  byPot: Map<number, PairingRow>;
};

export function normalizedWateringToken(value: unknown) {
  const text = healthEventText(value);
  return text ? text.trim().replace(/;+$/g, "").trim().toLowerCase() : "";
}

export function sourcePairKey(sensorId: unknown, valveId: unknown) {
  const sensorNumber = healthNumber(sensorId);
  const valveNumber = healthNumber(valveId);
  if (sensorNumber == null || valveNumber == null) return null;
  return `${Math.trunc(sensorNumber)}-${Math.trunc(valveNumber)}`;
}

export function sourcePairKeyFromText(value: unknown) {
  const text = healthEventText(value);
  if (!text) return null;
  const match = text.match(/(?:^|[^\d])(\d+)\s*-\s*(\d+)\s*;?(?=$|[^\d])/);
  if (!match) return null;
  return sourcePairKey(match[1], match[2]);
}

export function hardwareKeyVariants(value: unknown) {
  const token = normalizedWateringToken(value);
  if (!token) return [];
  const variants = new Set([token]);
  const parts = token.split(":");
  if (parts.length >= 2) {
    variants.add(parts.slice(-2).join(":"));
  }
  return Array.from(variants);
}

export function addPairingLookup(map: Map<string, PairingRow>, key: unknown, pairing: PairingRow) {
  const token = normalizedWateringToken(key);
  if (token) map.set(token, pairing);
}

export function addPairingHardwareLookup(map: Map<string, PairingRow>, key: unknown, pairing: PairingRow) {
  for (const variant of hardwareKeyVariants(key)) {
    map.set(variant, pairing);
  }
}

export function buildWateringPairingIndex(pairings: PairingRow[]): WateringPairingIndex {
  const index: WateringPairingIndex = {
    byLabel: new Map(),
    bySourcePair: new Map(),
    bySensorId: new Map(),
    byValveId: new Map(),
    bySensorKey: new Map(),
    byValveKey: new Map(),
    byPot: new Map(),
  };

  pairings.forEach((pairing) => {
    addPairingLookup(index.byLabel, pairing.name, pairing);
    addPairingLookup(index.byLabel, pairingLabel(pairing), pairing);
    addPairingLookup(index.byLabel, String(pairing.pot_number), pairing);
    addPairingHardwareLookup(index.bySensorKey, pairing.sensor_key, pairing);
    addPairingHardwareLookup(index.byValveKey, pairing.valve_key, pairing);
    index.byPot.set(pairing.pot_number, pairing);

    const sensorId = healthNumber(pairing.source_sensor_id);
    const valveId = healthNumber(pairing.source_valve_id);
    const pairKey = sourcePairKey(sensorId, valveId);
    if (pairKey) index.bySourcePair.set(pairKey, pairing);
    if (sensorId != null) index.bySensorId.set(String(Math.trunc(sensorId)), pairing);
    if (valveId != null) index.byValveId.set(String(Math.trunc(valveId)), pairing);
  });

  return index;
}

export function resolveWateringEventPairing(event: HealthWateringEvent, index: WateringPairingIndex) {
  const record = event as Record<string, unknown>;
  const pot = healthNumber(event.physicalPot ?? record.physical_pot ?? record.pot_number ?? record.pot);
  if (pot != null) {
    const pairing = index.byPot.get(Math.trunc(pot));
    if (pairing) return pairing;
  }

  const textCandidates = [
    event.pairing,
    event.pairingName,
    record.pairing_name,
    record.pairingName,
    record.name,
    record.label,
    record.pot,
    record.valve,
    record.valve_key,
    record.valveKey,
    record.valve_id,
    record.valveId,
    record.sensor,
    record.sensor_key,
    record.sensorKey,
    record.sensor_id,
    record.sensorId,
    record.id,
    record.event_id,
    record.eventId,
  ];

  for (const value of textCandidates) {
    const sourcePair = sourcePairKeyFromText(value);
    if (sourcePair && index.bySourcePair.has(sourcePair)) return index.bySourcePair.get(sourcePair);

    const token = normalizedWateringToken(value);
    if (token && index.byLabel.has(token)) return index.byLabel.get(token);
  }

  const sourceSensorId =
    healthNumber(record.source_sensor_id) ??
    healthNumber(record.sourceSensorId) ??
    healthNumber(record.sensor_id) ??
    healthNumber(record.sensorId);
  const sourceValveId =
    healthNumber(record.source_valve_id) ??
    healthNumber(record.sourceValveId) ??
    healthNumber(record.valve_id) ??
    healthNumber(record.valveId);
  const pairKey = sourcePairKey(sourceSensorId, sourceValveId);
  if (pairKey && index.bySourcePair.has(pairKey)) return index.bySourcePair.get(pairKey);
  if (sourceValveId != null) {
    const pairing = index.byValveId.get(String(Math.trunc(sourceValveId)));
    if (pairing) return pairing;
  }
  if (sourceSensorId != null) {
    const pairing = index.bySensorId.get(String(Math.trunc(sourceSensorId)));
    if (pairing) return pairing;
  }

  for (const value of [record.valve, record.valve_key, record.valveKey, event.valve]) {
    for (const variant of hardwareKeyVariants(value)) {
      const pairing = index.byValveKey.get(variant);
      if (pairing) return pairing;
    }
  }
  for (const value of [record.sensor, record.sensor_key, record.sensorKey, event.sensor]) {
    for (const variant of hardwareKeyVariants(value)) {
      const pairing = index.bySensorKey.get(variant);
      if (pairing) return pairing;
    }
  }

  return null;
}

export function withResolvedWateringPairing(event: HealthWateringEvent, pairing: PairingRow): HealthWateringEvent {
  return {
    ...event,
    originalPairing: event.originalPairing ?? event.pairing,
    pairing: pairingLabel(pairing),
    pairingName: pairing.name,
    physicalPot: pairing.pot_number,
    valveOpenTimeMs: event.valveOpenTimeMs ?? pairing.valve_open_time_ms,
    sensor: pairing.sensor_key,
    valve: pairing.valve_key,
    source_sensor_id: pairing.source_sensor_id,
    source_valve_id: pairing.source_valve_id,
  };
}

export function resolveHealthWateringEvents(events: HealthWateringEvent[], pairings: PairingRow[]) {
  const index = buildWateringPairingIndex(pairings);
  return dedupeWateringEvents(events
    .map((event) => {
      const pairing = resolveWateringEventPairing(event, index);
      return pairing ? withResolvedWateringPairing(event, pairing) : null;
    })
    .filter((event): event is HealthWateringEvent => event != null));
}

export function valveEventsToHealthWateringEvents(events: ValveEvent[], pairings: PairingRow[]) {
  const pairingByNameLocal = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  const pairingByValve = new Map(pairings.map((pairing) => [pairing.valve_key, pairing]));

  return dedupeWateringEvents(events
    .filter((event) => event.action === "open")
    .filter((event) => !isIgnoredDiagnosticValveEvent(event))
    .map((event) => {
      const pairing = pairingByNameLocal.get(event.pairing_name) ?? pairingByValve.get(event.valve_key);
      return {
        ...event,
        id: event.event_id ?? event.id,
        t: event.device_recorded_at ?? event.server_received_at,
        pairing: event.pairing_name || pairing?.name,
        physicalPot: pairing?.pot_number,
        valveOpenTimeMs: event.duration_ms ?? pairing?.valve_open_time_ms,
        sensor: pairing?.sensor_key,
        valve: event.valve_key,
      } satisfies HealthWateringEvent;
    }));
}

export function valveEventTimestampMs(event: ValveEvent) {
  const timestamp = Date.parse(event.device_recorded_at ?? event.server_received_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeValveEventRows(current: ValveEvent[], incoming: ValveEvent[]) {
  const cutoff = Date.now() - wateringHistoryMs;
  const byEvent = new Map<string, ValveEvent>();
  [...current, ...incoming].forEach((event) => {
    if (!event.event_id || valveEventTimestampMs(event) < cutoff || isIgnoredDiagnosticValveEvent(event)) return;
    byEvent.set(event.event_id, event);
  });
  return Array.from(byEvent.values())
    .sort((left, right) => valveEventTimestampMs(right) - valveEventTimestampMs(left))
    .slice(0, maxValveEventRows);
}

export function wateringEventsLastDay(events: HealthWateringEvent[]) {
  const since = Date.now() - dayMs;
  return events.filter((event) => {
    const time = healthTimestampMs(event.t);
    return time != null && time >= since;
  });
}

export function recentWateringEvents(events: HealthWateringEvent[], hours: number, maxFallback = 40) {
  if (!events.length) return [];
  const last = healthTimestampMs(events[events.length - 1]?.t);
  if (last == null) return events.slice(-maxFallback);
  const recent = events.filter((event) => {
    const time = healthTimestampMs(event.t);
    return time != null && time >= last - hours * 60 * 60 * 1000;
  });
  return recent.length ? recent : events.slice(-maxFallback);
}

export function wateringEventLabel(event: HealthWateringEvent) {
  const pot = healthNumber(event.physicalPot);
  if (pot != null) return `Pot ${Math.trunc(pot)}`;
  const pairing = healthString(event.pairing);
  const match = pairing?.match(/Pot\\s*(\\d+)/i);
  if (match) return `Pot ${match[1]}`;
  return pairing ?? "Event";
}
