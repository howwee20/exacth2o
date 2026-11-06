import type { SettingsCommandDraft, SettingsPlan } from "../settingsSpec";
import type { PairingRow } from "../types";
import type { ProposedMapping, UnclaimedSensor, UnresolvedValve } from "./types";

// Builds reviewed settings plans for the portal's EXISTING settings-batch path
// (stop -> change -> restore, config-hash precondition, server-side role checks,
// executor readback). Nothing here sends anything: a plan is only data until an
// operator reviews it and the portal queues it.
//
// Full scale: each step is ONE controller command, whatever the number of pots.
//  - prepare: bulk_update_pairings (watering off, 60 s measuring) for every selected pot
//  - apply:   remap_pairing_valves, applied by the controller in one transaction, so a
//             swap or a cycle of any length (up to every pot) never half-applies
//  - restore: restore_pairing_settings with each pot's own recorded values, exactly

export const maxPlanPots = 200;
export const commissioningIntervalSeconds = 60;

export type PotSettingsSnapshot = {
  pairingName: string;
  sensorKey: string;
  valveKey: string;
  zone: number | null;
  potNumber: number | null;
  groupName: string;
  calibrationName: string | null;
  /** Exact controller values, restored as recorded. */
  wtcPercentLimit: number;
  valveOpenTimeMs: number;
  measurementIntervalMs: number;
  /** The controller's rule: a target outside 0-100 or no pulse time means watering is off. */
  wateringDisabled: boolean;
  // Display conveniences.
  targetVwc: number | null;
  openSeconds: number;
  intervalSeconds: number;
};

function groupNameOf(pairing: PairingRow) {
  return (pairing.group_name ?? pairing.group ?? pairing.group_label ?? "").trim();
}

function calibrationNameOf(pairing: PairingRow) {
  return (pairing.calibration_name ?? pairing.calibration ?? pairing.calibration_label ?? "")?.toString().trim() || null;
}

export function isWateringDisabled(pairing: Pick<PairingRow, "wtc_percent_limit" | "valve_open_time_ms">) {
  return !(pairing.wtc_percent_limit >= 0 && pairing.wtc_percent_limit <= 100) || pairing.valve_open_time_ms <= 0;
}

// The previous topology and settings, kept (server-side, immutable) for provenance,
// restoration and rollback.
export function snapshotPots(pairings: readonly PairingRow[], pairingNames: readonly string[]): PotSettingsSnapshot[] {
  const wanted = new Set(pairingNames);
  return pairings.filter((pairing) => wanted.has(pairing.name)).map((pairing) => ({
    pairingName: pairing.name,
    sensorKey: pairing.sensor_key,
    valveKey: pairing.valve_key,
    zone: Number.isFinite(pairing.zone) ? pairing.zone : null,
    potNumber: Number.isFinite(pairing.pot_number) ? pairing.pot_number : null,
    groupName: groupNameOf(pairing),
    calibrationName: calibrationNameOf(pairing),
    wtcPercentLimit: pairing.wtc_percent_limit,
    valveOpenTimeMs: Math.round(pairing.valve_open_time_ms),
    measurementIntervalMs: Math.round(pairing.measurement_interval_ms),
    wateringDisabled: isWateringDisabled(pairing),
    targetVwc: isWateringDisabled(pairing) ? null : pairing.wtc_percent_limit,
    openSeconds: Math.max(0, Math.round(pairing.valve_open_time_ms / 1000)),
    intervalSeconds: Math.max(30, Math.round(pairing.measurement_interval_ms / 1000)),
  }));
}

/** Pots already in the commissioning state need no change. */
export function needsPreparation(pairing: Pick<PairingRow, "wtc_percent_limit" | "valve_open_time_ms" | "measurement_interval_ms">) {
  return !isWateringDisabled(pairing) || pairing.measurement_interval_ms > commissioningIntervalSeconds * 1000;
}

// Puts the selected pots into sensing-only mode at a faster cadence.
export function buildPreparePlan(snapshot: readonly PotSettingsSnapshot[]): SettingsPlan {
  const names = snapshot.map((pot) => pot.pairingName);
  return {
    summary: `Autocalibrate: disable automatic watering and measure every ${commissioningIntervalSeconds}s on ${names.length} selected pots`,
    commands: [{
      command_type: "bulk_update_pairings",
      payload: { pairing_names: names, disable_watering: true, measurement_interval_seconds: commissioningIntervalSeconds },
      effect: `Sensing only, every ${commissioningIntervalSeconds}s: ${names.length} pots`,
    }],
    questions: [],
  };
}

/** Exact payload entry restoring one pot to its recorded settings. */
export function restoreEntry(pot: PotSettingsSnapshot) {
  const validTarget = pot.wtcPercentLimit >= 0 && pot.wtcPercentLimit <= 100;
  return {
    pairing_name: pot.pairingName,
    sensor_key: pot.sensorKey,
    valve_key: pot.valveKey,
    // A disabled target is restored as the controller's canonical "watering off" value.
    target_vwc: validTarget ? pot.wtcPercentLimit : null,
    valve_open_time_ms: Math.min(120_000, Math.max(0, Math.round(pot.valveOpenTimeMs))),
    measurement_interval_ms: Math.min(3_600_000, Math.max(30_000, Math.round(pot.measurementIntervalMs))),
  };
}

// Returns the pots to the settings recorded before commissioning, each with its own values.
export function buildRestorePlan(snapshot: readonly PotSettingsSnapshot[], currentValveKeys: ReadonlyMap<string, string> = new Map()): SettingsPlan {
  const entries = snapshot.map((pot) => {
    const entry = restoreEntry(pot);
    // After a verified remap the pot's sensor is on its new valve.
    const valve = currentValveKeys.get(pot.pairingName);
    return valve ? { ...entry, valve_key: valve } : entry;
  });
  const enabled = entries.filter((entry) => entry.target_vwc != null && entry.valve_open_time_ms > 0).length;
  return {
    summary: `Autocalibrate: restore the recorded settings on ${snapshot.length} pots`,
    commands: [{
      command_type: "restore_pairing_settings",
      payload: { pairings: entries },
      effect: `Restore each pot's own target, pulse length and interval: ${snapshot.length} pots (${enabled} with automatic watering on)`,
    }],
    questions: [],
  };
}

export type ValveChange = { pairingName: string; sensorKey: string; fromValveKey: string; toValveKey: string };

// A proposal says "valve V moves sensor S". The pot is where its sensor sits, so
// the pairing that owns sensor S should be driven by valve V.
export function valveChangesFromProposals(
  proposals: readonly ProposedMapping[],
  snapshot: readonly PotSettingsSnapshot[],
): { changes: ValveChange[]; problems: string[] } {
  const bySensor = new Map(snapshot.map((pot) => [pot.sensorKey, pot]));
  const changes: ValveChange[] = [];
  const problems: string[] = [];
  proposals.forEach((proposal) => {
    const pot = bySensor.get(proposal.proposedSensorKey);
    if (!pot) {
      problems.push(`Sensor ${proposal.proposedSensorKey} is not part of the recorded selection.`);
      return;
    }
    if (pot.valveKey !== proposal.valveKey) {
      changes.push({ pairingName: pot.pairingName, sensorKey: pot.sensorKey, fromValveKey: pot.valveKey, toValveKey: proposal.valveKey });
    }
  });

  // Every valve that is given away must be received by another approved change,
  // otherwise two pairings would end up claiming one valve.
  const taken = new Set(changes.map((change) => change.toValveKey));
  const released = new Set(changes.map((change) => change.fromValveKey));
  const changing = new Set(changes.map((change) => change.pairingName));
  snapshot.forEach((pot) => {
    if (!changing.has(pot.pairingName) && taken.has(pot.valveKey)) {
      problems.push(`Valve ${pot.valveKey} is still recorded on ${pot.pairingName}, which is not part of the approved changes.`);
    }
  });
  if (new Set(changes.map((change) => change.toValveKey)).size !== changes.length) problems.push("Two approved changes target the same valve.");
  released.forEach((valve) => {
    if (!taken.has(valve)) problems.push(`Valve ${valve} would be left without a pot. Approve its new pot as well, or leave both unchanged.`);
  });
  return { changes, problems };
}

/**
 * Groups changes into the swaps and cycles they form. A cycle is complete when every
 * valve it gives up is received inside it; only complete cycles can be applied.
 */
export function changeCycles(changes: readonly ValveChange[]): { cycles: ValveChange[][]; incomplete: ValveChange[][] } {
  const byFromValve = new Map(changes.map((change) => [change.fromValveKey, change]));
  const visited = new Set<ValveChange>();
  const cycles: ValveChange[][] = [];
  const incomplete: ValveChange[][] = [];
  for (const start of changes) {
    if (visited.has(start)) continue;
    const chain: ValveChange[] = [];
    let current: ValveChange | undefined = start;
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      current = byFromValve.get(current.toValveKey);
    }
    const closed = chain.length > 0 && chain[chain.length - 1].toValveKey === chain[0].fromValveKey;
    if (closed) cycles.push(chain);
    else {
      // A chain may have joined an earlier one; collect whatever is not closed.
      incomplete.push(chain);
    }
  }
  return { cycles, incomplete };
}

/** One atomic remap command for the whole set of approved changes. */
export function buildRemapPlan(
  changes: readonly ValveChange[],
  snapshot: readonly PotSettingsSnapshot[],
  purpose: "apply" | "rollback",
  remapId: string,
): { plan: SettingsPlan | null; problems: string[] } {
  const byName = new Map(snapshot.map((pot) => [pot.pairingName, pot]));
  const problems: string[] = [];
  if (changes.length === 0) problems.push("There is nothing to change.");
  if (changes.length > maxPlanPots) problems.push(`At most ${maxPlanPots} pots can be remapped in one change.`);
  for (const change of changes) {
    if (!byName.has(change.pairingName)) problems.push(`No recorded settings for ${change.pairingName}.`);
  }
  const { incomplete } = changeCycles(changes);
  if (incomplete.length) problems.push(`${incomplete.reduce((sum, chain) => sum + chain.length, 0)} change(s) do not form complete swaps or cycles, so a valve would be orphaned or shared.`);
  if (problems.length) return { plan: null, problems };
  const payload: SettingsCommandDraft = {
    command_type: "remap_pairing_valves",
    payload: {
      remap_id: remapId,
      changes: changes.map((change) => ({
        pairing_name: change.pairingName,
        sensor_key: change.sensorKey,
        from_valve_key: change.fromValveKey,
        to_valve_key: change.toValveKey,
      })),
    },
    effect: `${purpose === "apply" ? "Move" : "Return"} ${changes.length} pot${changes.length === 1 ? "" : "s"} to ${purpose === "apply" ? "the measured" : "their previous"} valves in one controller transaction (names, groups, settings and calibration unchanged)`,
  };
  return {
    plan: {
      summary: purpose === "apply"
        ? `Autocalibrate: apply ${changes.length} reviewed valve ${changes.length === 1 ? "change" : "changes"}`
        : `Autocalibrate: roll back ${changes.length} valve ${changes.length === 1 ? "change" : "changes"} to the previous topology`,
      commands: [payload],
      questions: [],
    },
    problems: [],
  };
}

export function invertChanges(changes: readonly ValveChange[]): ValveChange[] {
  return changes.map((change) => ({ ...change, fromValveKey: change.toValveKey, toValveKey: change.fromValveKey }));
}

export type ReadbackRow = {
  pairingName: string;
  expectedValveKey: string;
  actualValveKey: string | null;
  verified: boolean;
  /** Group or calibration differs from the recorded settings. */
  settingsChanged: string[];
};

// Compares the controller's re-read configuration with what was approved.
export function verifyReadback(
  changes: readonly ValveChange[],
  currentPairings: readonly PairingRow[],
  snapshot: readonly PotSettingsSnapshot[] = [],
): { verified: boolean; rows: ReadbackRow[] } {
  const byName = new Map(currentPairings.map((pairing) => [pairing.name, pairing]));
  const recorded = new Map(snapshot.map((pot) => [pot.pairingName, pot]));
  const rows = changes.map((change) => {
    const current = byName.get(change.pairingName);
    const actualValveKey = current?.valve_key ?? null;
    const before = recorded.get(change.pairingName);
    const settingsChanged: string[] = [];
    if (current && before) {
      if (groupNameOf(current) !== before.groupName) settingsChanged.push("group");
      if ((calibrationNameOf(current) ?? null) !== (before.calibrationName ?? null)) settingsChanged.push("calibration");
    }
    return {
      pairingName: change.pairingName,
      expectedValveKey: change.toValveKey,
      actualValveKey,
      verified: actualValveKey === change.toValveKey && current?.sensor_key === change.sensorKey && settingsChanged.length === 0,
      settingsChanged,
    };
  });
  return { verified: rows.length > 0 && rows.every((row) => row.verified), rows };
}

export type RestoreRow = {
  pairingName: string;
  verified: boolean;
  expected: { target: number | null; openMs: number; intervalMs: number };
  actual: { target: number | null; openMs: number; intervalMs: number } | null;
};

// Compares the controller's re-read settings with each pot's recorded values.
export function verifyRestore(snapshot: readonly PotSettingsSnapshot[], currentPairings: readonly PairingRow[]): { verified: boolean; rows: RestoreRow[] } {
  const byName = new Map(currentPairings.map((pairing) => [pairing.name, pairing]));
  const rows = snapshot.map((pot) => {
    const entry = restoreEntry(pot);
    const current = byName.get(pot.pairingName);
    const actual = current ? {
      target: current.wtc_percent_limit >= 0 && current.wtc_percent_limit <= 100 ? current.wtc_percent_limit : null,
      openMs: Math.round(current.valve_open_time_ms),
      intervalMs: Math.round(current.measurement_interval_ms),
    } : null;
    const expected = { target: entry.target_vwc, openMs: entry.valve_open_time_ms, intervalMs: entry.measurement_interval_ms };
    return {
      pairingName: pot.pairingName,
      verified: Boolean(actual) && actual!.target === expected.target && actual!.openMs === expected.openMs && actual!.intervalMs === expected.intervalMs,
      expected,
      actual,
    };
  });
  return { verified: rows.length > 0 && rows.every((row) => row.verified), rows };
}

export type HeldBack = { pairingName: string; reason: string };

/**
 * Which pots may return to automatic watering now. A pot whose valve was not
 * resolved, whose change is not verified on the controller, or whose settings were
 * changed by someone else since preparation stays sensing-only and is listed.
 */
export function planRestoreScope(input: {
  snapshot: readonly PotSettingsSnapshot[];
  currentPairings: readonly PairingRow[];
  unresolved: readonly UnresolvedValve[];
  unclaimed: readonly UnclaimedSensor[];
  pendingChanges: readonly ValveChange[];
  unverifiedChanges: readonly ValveChange[];
  /** Pots the operator explicitly chose to restore despite a finding. */
  releasedAnyway?: ReadonlySet<string>;
}): { restore: PotSettingsSnapshot[]; heldBack: HeldBack[] } {
  const byName = new Map(input.currentPairings.map((pairing) => [pairing.name, pairing]));
  const valveOwner = new Map(input.snapshot.map((pot) => [pot.valveKey, pot.pairingName]));
  const reasons = new Map<string, string>();
  const hold = (name: string | undefined, reason: string) => { if (name && !reasons.has(name)) reasons.set(name, reason); };
  input.unresolved.forEach((item) => hold(valveOwner.get(item.valveKey), `Its valve was not resolved (${item.detail})`));
  input.unclaimed.forEach((item) => hold(item.pairingName, "No selected valve raised its sensor; its water source is unconfirmed"));
  input.pendingChanges.forEach((change) => hold(change.pairingName, "A measured valve change was found but not applied"));
  input.unverifiedChanges.forEach((change) => hold(change.pairingName, "Its valve change is not yet verified by controller readback"));
  for (const pot of input.snapshot) {
    const current = byName.get(pot.pairingName);
    if (!current) hold(pot.pairingName, "It is no longer on the controller");
    else if (!isWateringDisabled(current) && (current.wtc_percent_limit !== pot.wtcPercentLimit || current.valve_open_time_ms !== pot.valveOpenTimeMs)) {
      hold(pot.pairingName, "Its settings were changed after preparation; restoring would overwrite that change");
    }
  }
  const released = input.releasedAnyway ?? new Set<string>();
  const restore = input.snapshot.filter((pot) => !reasons.has(pot.pairingName) || released.has(pot.pairingName));
  const heldBack = Array.from(reasons.entries())
    .filter(([name]) => !released.has(name))
    .map(([pairingName, reason]) => ({ pairingName, reason }));
  return { restore, heldBack };
}
