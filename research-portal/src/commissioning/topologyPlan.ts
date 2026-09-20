import type { SettingsCommandDraft, SettingsPlan } from "../settingsSpec";
import type { PairingRow } from "../types";
import type { ProposedMapping } from "./types";

// Builds reviewed settings plans for the portal's EXISTING settings-batch path
// (stop -> change -> restore, config-hash precondition, server-side role checks,
// executor readback). Nothing here sends anything: a plan is only data until an
// administrator reviews it and the portal queues it.

// The batch endpoint accepts 3-22 commands including its stop/restore bookends.
export const maxPlanCommands = 20;
export const commissioningIntervalSeconds = 60;

export type PotSettingsSnapshot = {
  pairingName: string;
  sensorKey: string;
  valveKey: string;
  groupName: string;
  targetVwc: number | null;
  wateringDisabled: boolean;
  openSeconds: number;
  intervalSeconds: number;
  calibrationName: string | null;
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

// The previous topology and settings, kept for provenance and rollback.
export function snapshotPots(pairings: readonly PairingRow[], pairingNames: readonly string[]): PotSettingsSnapshot[] {
  const wanted = new Set(pairingNames);
  return pairings.filter((pairing) => wanted.has(pairing.name)).map((pairing) => ({
    pairingName: pairing.name,
    sensorKey: pairing.sensor_key,
    valveKey: pairing.valve_key,
    groupName: groupNameOf(pairing),
    targetVwc: isWateringDisabled(pairing) ? null : pairing.wtc_percent_limit,
    wateringDisabled: isWateringDisabled(pairing),
    openSeconds: Math.max(1, Math.round(pairing.valve_open_time_ms / 1000)),
    intervalSeconds: Math.max(30, Math.round(pairing.measurement_interval_ms / 1000)),
    calibrationName: calibrationNameOf(pairing),
  }));
}

// Puts the selected pots into sensing-only mode at a faster cadence.
export function buildPreparePlan(snapshot: readonly PotSettingsSnapshot[]): SettingsPlan {
  const names = snapshot.map((pot) => pot.pairingName);
  return {
    summary: `Autocalibrate commissioning: disable automatic watering and measure every ${commissioningIntervalSeconds}s on ${names.length} selected pots`,
    commands: [{
      command_type: "bulk_update_pairings",
      payload: { pairing_names: names, disable_watering: true, measurement_interval_seconds: commissioningIntervalSeconds },
      effect: `Sensing only, every ${commissioningIntervalSeconds}s: ${names.join(", ")}`,
    }],
    questions: [],
  };
}

// Returns the pots to the settings recorded before commissioning.
export function buildRestorePlan(snapshot: readonly PotSettingsSnapshot[]): SettingsPlan {
  const groups = new Map<string, PotSettingsSnapshot[]>();
  snapshot.forEach((pot) => {
    const key = JSON.stringify([pot.wateringDisabled ? null : pot.targetVwc, pot.openSeconds, pot.intervalSeconds]);
    groups.set(key, [...(groups.get(key) ?? []), pot]);
  });
  const commands: SettingsCommandDraft[] = Array.from(groups.values()).map((pots) => {
    const first = pots[0];
    const names = pots.map((pot) => pot.pairingName);
    const payload: Record<string, unknown> = {
      pairing_names: names,
      open_time_seconds: first.openSeconds,
      measurement_interval_seconds: first.intervalSeconds,
    };
    if (first.wateringDisabled || first.targetVwc == null) payload.disable_watering = true;
    else payload.target_vwc = first.targetVwc;
    return {
      command_type: "bulk_update_pairings",
      payload,
      effect: `${first.wateringDisabled ? "Watering stays disabled" : `Target ${first.targetVwc}%`}, ${first.openSeconds}s pulse, every ${first.intervalSeconds}s: ${names.join(", ")}`,
    };
  });
  return {
    summary: `Autocalibrate commissioning: restore the recorded settings on ${snapshot.length} pots`,
    commands,
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

// A pairing's sensor or valve cannot be edited in place, so each change is a
// delete followed by a create that carries the pot's other settings over. All
// deletes run first so a swapped valve is free before it is reused.
export function buildTopologyPlan(
  changes: readonly ValveChange[],
  snapshot: readonly PotSettingsSnapshot[],
  purpose: "apply" | "rollback",
): { plan: SettingsPlan | null; problems: string[] } {
  const byName = new Map(snapshot.map((pot) => [pot.pairingName, pot]));
  const problems: string[] = [];
  const deletes: SettingsCommandDraft[] = [];
  const creates: SettingsCommandDraft[] = [];
  const followUps: SettingsCommandDraft[] = [];
  const calibrations = new Map<string, string[]>();

  changes.forEach((change) => {
    const pot = byName.get(change.pairingName);
    if (!pot) {
      problems.push(`No recorded settings for ${change.pairingName}.`);
      return;
    }
    if (!/^Zone\d+-Pot\d+$/i.test(pot.pairingName)) problems.push(`${pot.pairingName} does not use the Zone<number>-Pot<number> name the controller requires.`);
    if (!pot.groupName) problems.push(`${pot.pairingName} has no recorded group.`);
    deletes.push({ command_type: "delete_pairing", payload: { pairing_name: pot.pairingName }, effect: `Remove ${pot.pairingName} (sensor ${pot.sensorKey}, valve ${change.fromValveKey})` });
    creates.push({
      command_type: "create_pairing",
      payload: {
        name: pot.pairingName,
        sensor_key: pot.sensorKey,
        valve_key: change.toValveKey,
        group_name: pot.groupName,
        // A disabled pot is recreated with a 0% target (never waters) and then disabled again.
        target_vwc: pot.wateringDisabled || pot.targetVwc == null ? 0 : pot.targetVwc,
        open_time_seconds: pot.openSeconds,
        measurement_interval_seconds: pot.intervalSeconds,
      },
      effect: `Recreate ${pot.pairingName} with sensor ${pot.sensorKey} on valve ${change.toValveKey}`,
    });
    if (pot.wateringDisabled || pot.targetVwc == null) {
      followUps.push({ command_type: "update_pairing", payload: { pairing_name: pot.pairingName, disable_watering: true }, effect: `Keep automatic watering disabled on ${pot.pairingName}` });
    }
    if (pot.calibrationName) calibrations.set(pot.calibrationName, [...(calibrations.get(pot.calibrationName) ?? []), pot.pairingName]);
  });
  calibrations.forEach((names, calibrationName) => followUps.push({
    command_type: "apply_calibration",
    payload: { calibration_name: calibrationName, pairing_names: names },
    effect: `Re-apply calibration ${calibrationName} to ${names.join(", ")}`,
  }));

  const commands = [...deletes, ...creates, ...followUps];
  if (commands.length === 0) problems.push("There is nothing to change.");
  if (commands.length > maxPlanCommands) {
    problems.push(`This needs ${commands.length} controller commands, more than one reviewed batch allows (${maxPlanCommands}). Approve fewer changes at a time, keeping each swap together.`);
  }
  if (problems.length) return { plan: null, problems };
  return {
    plan: {
      summary: purpose === "apply"
        ? `Autocalibrate commissioning: apply ${changes.length} reviewed valve ${changes.length === 1 ? "change" : "changes"}`
        : `Autocalibrate commissioning: roll back ${changes.length} valve ${changes.length === 1 ? "change" : "changes"} to the previous topology`,
      commands,
      questions: [],
    },
    problems: [],
  };
}

export function invertChanges(changes: readonly ValveChange[]): ValveChange[] {
  return changes.map((change) => ({ ...change, fromValveKey: change.toValveKey, toValveKey: change.fromValveKey }));
}

export type ReadbackRow = { pairingName: string; expectedValveKey: string; actualValveKey: string | null; verified: boolean };

// Compares the controller's re-read configuration with what was approved.
export function verifyReadback(changes: readonly ValveChange[], currentPairings: readonly PairingRow[]): { verified: boolean; rows: ReadbackRow[] } {
  const rows = changes.map((change) => {
    const current = currentPairings.find((pairing) => pairing.name === change.pairingName);
    const actualValveKey = current?.valve_key ?? null;
    return {
      pairingName: change.pairingName,
      expectedValveKey: change.toValveKey,
      actualValveKey,
      verified: actualValveKey === change.toValveKey && current?.sensor_key === change.sensorKey,
    };
  });
  return { verified: rows.length > 0 && rows.every((row) => row.verified), rows };
}
