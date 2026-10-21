import { potRangeSummary } from "../aerialLayout";
import type { PotBinding } from "../benchClient";
import { commissioningIntervalSeconds, isWateringDisabled } from "../commissioning/topologyPlan";
import type { SelectedPot } from "../commissioning/types";
import type { PairingRow } from "../types";

// Which pots can take part in an autocalibration run, and the selection itself.
//
// Every selected pot is identified by its controller pairing: its own sensor key and
// valve key, exactly as the controller reports them. A pot's number or where it is
// drawn on the aerial view never stands in for a hardware address.

export type PotAvailability = {
  available: boolean;
  /** Why the pot cannot take part now (shown on the aerial view and read aloud). */
  reason?: string;
  /** What preparation will change, or what deserves attention. */
  notes: string[];
  lastReadingAtMs: number | null;
};

const minute = 60_000;

/** A sensor is stale when it has missed about three of its reports (at least 30 min). */
export function staleAfterMs(pairing: Pick<PairingRow, "measurement_interval_ms">) {
  return Math.max(3 * Math.max(30_000, pairing.measurement_interval_ms || 0), 30 * minute);
}

/** How far back to look for each sensor's latest reading. */
export function readingLookbackMs(pairings: readonly Pick<PairingRow, "measurement_interval_ms">[]) {
  return Math.min(3 * 60 * minute, Math.max(30 * minute, ...pairings.map(staleAfterMs)));
}

function ago(nowMs: number, atMs: number) {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / minute));
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function potAvailability(input: {
  pairings: readonly PairingRow[];
  /** Latest reading per sensor key; null while readings have not been checked. */
  lastReadingAt: ReadonlyMap<string, number> | null;
  nowMs: number;
  /** Pots an earlier run left sensing-only, with a note. They can be selected again. */
  heldBack?: ReadonlyMap<string, string>;
}): Map<string, PotAvailability> {
  const { pairings, lastReadingAt, nowMs } = input;
  const owners = (key: (pairing: PairingRow) => string) => {
    const map = new Map<string, string[]>();
    for (const pairing of pairings) {
      const value = key(pairing).trim();
      if (value) map.set(value, [...(map.get(value) ?? []), pairing.name]);
    }
    return map;
  };
  const valveOwners = owners((pairing) => pairing.valve_key ?? "");
  const sensorOwners = owners((pairing) => pairing.sensor_key ?? "");
  const lookback = readingLookbackMs(pairings);
  const out = new Map<string, PotAvailability>();
  for (const pairing of pairings) {
    const valve = (pairing.valve_key ?? "").trim();
    const sensor = (pairing.sensor_key ?? "").trim();
    const last = lastReadingAt?.get(sensor) ?? null;
    const notes: string[] = [];
    let reason: string | undefined;
    if (!valve) reason = "No valve is configured for this pairing on the controller.";
    else if (!sensor) reason = "No sensor is configured for this pairing on the controller.";
    else if ((valveOwners.get(valve) ?? []).length > 1) {
      reason = `Valve ${valve} is also configured on ${valveOwners.get(valve)!.filter((name) => name !== pairing.name).join(", ")}, so their water could not be told apart. Correct the pairings first.`;
    } else if ((sensorOwners.get(sensor) ?? []).length > 1) {
      reason = `Sensor ${sensor} is also configured on ${sensorOwners.get(sensor)!.filter((name) => name !== pairing.name).join(", ")}, so their readings could not be told apart. Correct the pairings first.`;
    } else if (lastReadingAt) {
      if (last == null) reason = `No reading from sensor ${sensor} in the last ${Math.round(lookback / (60 * minute)) || 1} h. Check that it is connected and reporting.`;
      else if (nowMs - last > staleAfterMs(pairing)) reason = `Sensor ${sensor} last reported ${ago(nowMs, last)}. Check that it is connected and reporting.`;
    }
    if (!isWateringDisabled(pairing)) notes.push(`Automatic watering is on (target ${pairing.wtc_percent_limit}%). Preparation turns it off for the run and the recorded setting is restored afterwards.`);
    if (pairing.measurement_interval_ms > commissioningIntervalSeconds * 1000) {
      notes.push(`Measures every ${Math.round(pairing.measurement_interval_ms / minute)} min. Preparation measures every ${commissioningIntervalSeconds} s during the run.`);
    }
    const held = input.heldBack?.get(pairing.name);
    if (held) notes.push(held);
    if (!lastReadingAt && !reason) notes.push("Recent readings have not been checked yet.");
    out.set(pairing.name, { available: !reason, reason, notes, lastReadingAtMs: last });
  }
  return out;
}

const isAvailable = (availability: ReadonlyMap<string, PotAvailability>, name: string) => availability.get(name)?.available !== false;

export function toggleSelection(selected: ReadonlySet<string>, name: string, availability: ReadonlyMap<string, PotAvailability>) {
  const next = new Set(selected);
  if (next.has(name)) next.delete(name);
  else if (isAvailable(availability, name)) next.add(name);
  return next;
}

/** Selects every available pot of a group, or clears the group when all of them are selected. */
export function toggleGroupSelection(selected: ReadonlySet<string>, names: readonly string[], availability: ReadonlyMap<string, PotAvailability>) {
  const eligible = names.filter((name) => isAvailable(availability, name));
  const next = new Set(selected);
  if (eligible.length && eligible.every((name) => next.has(name))) names.forEach((name) => next.delete(name));
  else eligible.forEach((name) => next.add(name));
  return next;
}

export function selectAvailable(pairings: readonly PairingRow[], availability: ReadonlyMap<string, PotAvailability>) {
  return new Set(pairings.filter((pairing) => isAvailable(availability, pairing.name)).map((pairing) => pairing.name));
}

/**
 * After the controller configuration changes: keep only pots that still exist and can
 * still take part, and say which were dropped.
 */
export function pruneSelection(selected: ReadonlySet<string>, pairings: readonly PairingRow[], availability: ReadonlyMap<string, PotAvailability>) {
  const present = new Set(pairings.map((pairing) => pairing.name));
  const selection = new Set<string>();
  const removed: string[] = [];
  selected.forEach((name) => {
    if (present.has(name) && isAvailable(availability, name)) selection.add(name);
    else removed.push(name);
  });
  return { selection, removed };
}

/** The run's pots, in bench order (zone, then pot number), each with its own identities. */
export function buildSelectedPots(pairings: readonly PairingRow[], selected: ReadonlySet<string>, references: ReadonlySet<string> = new Set()): SelectedPot[] {
  return pairings
    .filter((pairing) => selected.has(pairing.name))
    .slice()
    .sort((a, b) => a.zone - b.zone || a.pot_number - b.pot_number || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((pairing) => ({
      pairingName: pairing.name,
      potNumber: Number.isFinite(pairing.pot_number) ? pairing.pot_number : null,
      valveKey: pairing.valve_key,
      sensorKey: pairing.sensor_key,
      ...(references.has(pairing.name) ? { reference: true } : {}),
    }));
}

export type SelectionSummary = {
  count: number;
  total: number;
  available: number;
  unavailable: number;
  zones: Array<{ zone: number; selected: number; total: number; available: number }>;
  potRanges: string;
  references: number;
};

export function summarizeSelection(pairings: readonly PairingRow[], selected: ReadonlySet<string>, availability: ReadonlyMap<string, PotAvailability>, references: ReadonlySet<string> = new Set()): SelectionSummary {
  const zones = Array.from(new Set(pairings.map((pairing) => pairing.zone))).sort((a, b) => a - b).map((zone) => {
    const inZone = pairings.filter((pairing) => pairing.zone === zone);
    return {
      zone,
      selected: inZone.filter((pairing) => selected.has(pairing.name)).length,
      total: inZone.length,
      available: inZone.filter((pairing) => isAvailable(availability, pairing.name)).length,
    };
  });
  const chosen = pairings.filter((pairing) => selected.has(pairing.name));
  const available = pairings.filter((pairing) => isAvailable(availability, pairing.name)).length;
  return {
    count: chosen.length,
    total: pairings.length,
    available,
    unavailable: pairings.length - available,
    zones,
    potRanges: potRangeSummary(chosen.map((pairing) => pairing.pot_number).filter((value) => Number.isFinite(value))),
    references: chosen.filter((pairing) => references.has(pairing.name)).length,
  };
}

/**
 * Pots whose current wiring a researcher confirmed at the bench: suggested as
 * known-correct references. A confirmation only counts while the controller still
 * reports the same sensor and valve it was made for.
 */
export function confirmedReferences(pairings: readonly PairingRow[], bindings: readonly PotBinding[]) {
  const byName = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  return bindings
    .filter((binding) => binding.physicalStatus === "researcher_confirmed" || binding.physicalStatus === "delivery_verified")
    .filter((binding) => {
      const pairing = byName.get(binding.pairingName);
      return pairing && pairing.sensor_key === binding.sensorKey && pairing.valve_key === binding.valveKey;
    })
    .map((binding) => binding.pairingName);
}
