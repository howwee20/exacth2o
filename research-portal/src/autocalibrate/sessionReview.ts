import {
  changeCycles,
  commissioningIntervalSeconds,
  isWateringDisabled,
  valveChangesFromProposals,
  verifyReadback,
  verifyRestore,
  type PotSettingsSnapshot,
  type ValveChange,
} from "../commissioning/topologyPlan";
import type { CommissioningResult, ProposalFault, ProposedMapping } from "../commissioning/types";
import type { CommissioningSessionRow } from "../commissioningRecords";
import type { PairingRow } from "../types";
import { parseRecord, parseSnapshot, type TrackedBatch } from "./sessionRecord";

// Decisions that compare a session's record with the controller's configuration:
// originals carried between sessions, the review of measured changes, and readback.

// ------------------------------------------------------------------ carrying originals

/**
 * Pots an earlier session left sensing-only (held back at restore) are still in their
 * prepared state. A new session must restore them to their real originals, not to
 * that prepared state, so the originals are carried forward from the newest earlier
 * session that included the pot, as long as it still held the pot back and the pot is
 * still sensing-only today.
 */
export function carryForwardOriginals(snapshot: readonly PotSettingsSnapshot[], recent: readonly CommissioningSessionRow[]) {
  const ordered = recent.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const carried: Array<{ pairingName: string; fromRunId: string }> = [];
  const out = snapshot.map((pot) => {
    if (!pot.wateringDisabled) return pot;
    for (const session of ordered) {
      const original = parseSnapshot(session).find((item) => item.pairingName === pot.pairingName);
      if (!original) continue;
      const heldBack = parseRecord(session).heldBack.some((item) => item.pairingName === pot.pairingName);
      if (!heldBack) return pot;
      carried.push({ pairingName: pot.pairingName, fromRunId: session.run_id });
      return {
        ...pot,
        wtcPercentLimit: original.wtcPercentLimit,
        valveOpenTimeMs: original.valveOpenTimeMs,
        measurementIntervalMs: original.measurementIntervalMs,
        wateringDisabled: original.wateringDisabled,
        targetVwc: original.targetVwc,
        openSeconds: original.openSeconds,
        intervalSeconds: original.intervalSeconds,
      };
    }
    return pot;
  });
  return { snapshot: out, carried };
}

/** Pots held back by an earlier, closed session that are still sensing-only now. */
export function heldBackFromEarlier(recent: readonly CommissioningSessionRow[], pairings: readonly PairingRow[]) {
  const byName = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  const ordered = recent.filter((row) => !row.active).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const out = new Map<string, string>();
  const decided = new Set<string>();
  for (const session of ordered) {
    const record = parseRecord(session);
    for (const pot of parseSnapshot(session)) {
      if (decided.has(pot.pairingName)) continue;
      decided.add(pot.pairingName);
      const held = record.heldBack.find((item) => item.pairingName === pot.pairingName);
      const current = byName.get(pot.pairingName);
      if (held && current && isWateringDisabled(current)) {
        out.set(pot.pairingName, `Left sensing-only by run ${session.run_id} (${held.reason}). Its original settings are carried into the next run.`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ review

export type ChangeCycle = {
  /** Stable id: the pairing names it moves, sorted. */
  id: string;
  changes: ValveChange[];
  proposals: ProposedMapping[];
  /** Every member is a proposal without findings. */
  clean: boolean;
  faults: ProposalFault[];
  touchesReference: boolean;
  minConfidence: number;
};

export function cycleId(changes: readonly ValveChange[]) {
  return changes.map((change) => change.pairingName).sort().join("|");
}

/**
 * Groups the run's measured differences into the swaps and cycles they form. Only a
 * complete cycle can be applied (every valve it gives up is received inside it); a
 * chain broken by an unresolved valve is reported, never applied in part.
 */
export function reviewCycles(result: CommissioningResult, snapshot: readonly PotSettingsSnapshot[]) {
  const { changes } = valveChangesFromProposals(result.proposals, snapshot);
  const { cycles, incomplete } = changeCycles(changes);
  const byValve = new Map(result.proposals.map((proposal) => [proposal.valveKey, proposal]));
  const references = new Set(result.pots.filter((pot) => pot.reference).map((pot) => pot.pairingName));
  const built: ChangeCycle[] = cycles.map((chain) => {
    const proposals = chain.map((change) => byValve.get(change.toValveKey)).filter((item): item is ProposedMapping => Boolean(item));
    const faults = Array.from(new Set(proposals.flatMap((proposal) => proposal.faults)));
    return {
      id: cycleId(chain),
      changes: chain,
      proposals,
      clean: proposals.length === chain.length && proposals.every((proposal) => proposal.status === "proposed"),
      faults,
      touchesReference: chain.some((change) => references.has(change.pairingName)),
      minConfidence: proposals.length ? Math.min(...proposals.map((proposal) => proposal.confidence)) : 0,
    };
  }).sort((a, b) => a.changes.length - b.changes.length || a.id.localeCompare(b.id));
  const confirmed = result.proposals.filter((proposal) => proposal.matchesRecord);
  return { cycles: built, incomplete, confirmed };
}

export type ReferenceCheck = { pairingName: string; outcome: "matched" | "conflict" | "unresolved" };

/** How the known-correct reference pots came out: a failed reference casts doubt on the run. */
export function referenceChecks(result: CommissioningResult): ReferenceCheck[] {
  return result.pots.filter((pot) => pot.reference).map((pot) => {
    const proposal = result.proposals.find((item) => item.valveKey === pot.valveKey);
    if (!proposal) return { pairingName: pot.pairingName, outcome: "unresolved" as const };
    return { pairingName: pot.pairingName, outcome: proposal.matchesRecord ? "matched" as const : "conflict" as const };
  });
}

/**
 * Re-checks the controller's current configuration immediately before applying: each
 * pot must still have the sensor and valve it had during the run, and no pot outside
 * the change may hold a valve the change hands out.
 */
export function applyPreconditions(changes: readonly ValveChange[], current: readonly PairingRow[]) {
  const problems: string[] = [];
  const byName = new Map(current.map((pairing) => [pairing.name, pairing]));
  const moving = new Set(changes.map((change) => change.pairingName));
  for (const change of changes) {
    const pairing = byName.get(change.pairingName);
    if (!pairing) problems.push(`${change.pairingName} is no longer on the controller.`);
    else if (pairing.sensor_key !== change.sensorKey) problems.push(`${change.pairingName} now reports sensor ${pairing.sensor_key}, not ${change.sensorKey} measured in the run.`);
    else if (pairing.valve_key !== change.fromValveKey) problems.push(`${change.pairingName} is now on valve ${pairing.valve_key}, not ${change.fromValveKey} as during the run.`);
  }
  const handedOut = new Set(changes.map((change) => change.toValveKey));
  for (const pairing of current) {
    if (!moving.has(pairing.name) && handedOut.has(pairing.valve_key)) problems.push(`Valve ${pairing.valve_key} is now on ${pairing.name}, which is not part of this change.`);
  }
  return problems;
}

/** What the controller's own configuration shows for a queued remap. */
export function remapReadback(changes: readonly ValveChange[], current: readonly PairingRow[], snapshot: readonly PotSettingsSnapshot[]): TrackedBatch["readback"] {
  if (!changes.length) return "pending";
  if (verifyReadback(changes, current, snapshot).verified) return "verified";
  const byName = new Map(current.map((pairing) => [pairing.name, pairing]));
  const unchanged = changes.every((change) => byName.get(change.pairingName)?.valve_key === change.fromValveKey);
  return unchanged ? "not_applied" : "mismatch";
}

/** Pots in the commissioning state: automatic watering off, measuring at least every 60 s. */
export function preparedState(names: readonly string[], current: readonly PairingRow[]) {
  const byName = new Map(current.map((pairing) => [pairing.name, pairing]));
  const prepared: string[] = [];
  const notPrepared: string[] = [];
  for (const name of names) {
    const pairing = byName.get(name);
    if (pairing && isWateringDisabled(pairing) && pairing.measurement_interval_ms <= commissioningIntervalSeconds * 1000) prepared.push(name);
    else notPrepared.push(name);
  }
  return { prepared, notPrepared };
}

/** What the controller's own configuration shows for a queued restore. */
export function restoreReadback(restored: readonly PotSettingsSnapshot[], current: readonly PairingRow[]): TrackedBatch["readback"] {
  if (!restored.length) return "pending";
  if (verifyRestore(restored, current).verified) return "verified";
  const { notPrepared } = preparedState(restored.map((pot) => pot.pairingName), current);
  // Pots whose original state was already "watering off at 60 s" look prepared either way.
  return notPrepared.length === 0 ? "not_applied" : "mismatch";
}

/** Which of the original pots each pairing's sensor now sits on, after a verified remap. */
export function currentValveKeys(current: readonly PairingRow[]) {
  return new Map(current.map((pairing) => [pairing.name, pairing.valve_key]));
}
