import type { PairingRow, SensorReading, ValveEvent } from "./types";

type Identity = { name: string; sensor_key?: string | null; valve_key?: string | null };

/** Match the full hardware key, including the board, rather than a mutable pot label. */
export function alignPairingHistory<T extends { pairing_name: string }>(
  records: readonly T[],
  identities: readonly Identity[],
  key: "sensor_key" | "valve_key",
): T[] {
  const byKey = new Map<string, Set<string>>();
  const byName = new Map(identities.map((identity) => [identity.name, identity]));
  for (const identity of identities) {
    const hardwareKey = identity[key];
    if (!hardwareKey) continue;
    const names = byKey.get(hardwareKey) ?? new Set<string>();
    names.add(identity.name);
    byKey.set(hardwareKey, names);
  }
  return records.flatMap((record) => {
    const hardwareKey = (record as T & { sensor_key?: string; valve_key?: string })[key];
    const matches = hardwareKey ? byKey.get(hardwareKey) : undefined;
    // A shared valve cannot unambiguously identify a pot. Retain its name if it matches.
    const name = matches?.size === 1 ? [...matches][0]
      : matches?.has(record.pairing_name) ? record.pairing_name : undefined;
    if (name) return [name === record.pairing_name ? record : { ...record, pairing_name: name }];
    const named = byName.get(record.pairing_name);
    if (named && !named[key]) return [record];
    return [];
  });
}

export function readingsForPairings(readings: readonly SensorReading[], pairings: readonly PairingRow[]) {
  return alignPairingHistory(readings, pairings, "sensor_key");
}

export function valveEventsForPairings(events: readonly ValveEvent[], pairings: readonly PairingRow[]) {
  return alignPairingHistory(events, pairings, "valve_key");
}
