import { describe, expect, it } from "vitest";

import { snapshotPots, type ValveChange } from "../commissioning/topologyPlan";
import type { CommissioningResult, ProposedMapping, PulseEvidence, SelectedPot } from "../commissioning/types";
import type { CommissioningSessionRow } from "../commissioningRecords";
import type { PairingRow } from "../types";
import { liveStates, resultCounts, resultStates } from "./present";
import {
  buildSelectedPots,
  confirmedReferences,
  potAvailability,
  pruneSelection,
  selectAvailable,
  summarizeSelection,
  toggleGroupSelection,
  toggleSelection,
} from "./selection";
import { emptyRecord, sessionStage, statusAfterRun } from "./sessionRecord";
import {
  applyPreconditions,
  carryForwardOriginals,
  heldBackFromEarlier,
  preparedState,
  referenceChecks,
  remapReadback,
  restoreReadback,
  reviewCycles,
} from "./sessionReview";

const now = Date.parse("2026-10-21T15:00:00Z");

/** 100 pots: four zones of 25; valve and sensor keys deliberately unrelated to pot numbers. */
function installation(count = 100): PairingRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Zone${Math.floor(index / 25) + 1}-Pot${index + 1}`,
    zone: Math.floor(index / 25) + 1,
    pot_number: index + 1,
    source_sensor_id: 500 + index,
    sensor_key: `SDI-${(index * 37) % 101}:${index % 10}`,
    source_valve_id: 900 + index,
    valve_key: `${32 + Math.floor(index / 48)}:${(index % 48) + 1}`,
    wtc_percent_limit: 22,
    valve_open_time_ms: 4000,
    measurement_interval_ms: 600_000,
    group_name: `G${index % 3}`,
    calibration_name: "Teros12",
  }));
}

const fresh = (pairings: PairingRow[], age = 5 * 60_000) => new Map(pairings.map((pairing) => [pairing.sensor_key, now - age]));

describe("pot availability on the aerial view", () => {
  it("lets every configured, reporting pot of a 100-pot installation take part", () => {
    const pairings = installation();
    const availability = potAvailability({ pairings, lastReadingAt: fresh(pairings), nowMs: now });
    expect([...availability.values()].every((item) => item.available)).toBe(true);
    expect(availability.get("Zone1-Pot1")?.notes.join(" ")).toMatch(/Automatic watering is on/);
    expect(availability.get("Zone1-Pot1")?.notes.join(" ")).toMatch(/every 60 s/);
  });

  it("explains missing identities, shared valves or sensors, and silent sensors", () => {
    const pairings = installation(8);
    pairings[0].valve_key = "";
    pairings[1].sensor_key = " ";
    pairings[3].valve_key = pairings[2].valve_key;
    pairings[5].sensor_key = pairings[4].sensor_key;
    const readings = fresh(pairings);
    readings.delete(pairings[6].sensor_key);
    readings.set(pairings[7].sensor_key, now - 4 * 3600_000);
    const availability = potAvailability({ pairings, lastReadingAt: readings, nowMs: now });
    expect(availability.get(pairings[0].name)?.reason).toMatch(/No valve is configured/);
    expect(availability.get(pairings[1].name)?.reason).toMatch(/No sensor is configured/);
    expect(availability.get(pairings[2].name)?.reason).toMatch(new RegExp(`also configured on ${pairings[3].name}`));
    expect(availability.get(pairings[3].name)?.reason).toMatch(new RegExp(`also configured on ${pairings[2].name}`));
    expect(availability.get(pairings[4].name)?.reason).toMatch(/Sensor .* also configured/);
    expect(availability.get(pairings[6].name)?.reason).toMatch(/No reading from sensor/);
    expect(availability.get(pairings[7].name)?.reason).toMatch(/last reported 4 h ago/);
  });

  it("does not call a pot stale before its readings have been checked", () => {
    const pairings = installation(4);
    const availability = potAvailability({ pairings, lastReadingAt: null, nowMs: now });
    expect([...availability.values()].every((item) => item.available)).toBe(true);
    expect(availability.get(pairings[0].name)?.notes.join(" ")).toMatch(/not been checked/);
  });
});

describe("selecting pots", () => {
  const pairings = installation();
  const availability = potAvailability({ pairings, lastReadingAt: fresh(pairings), nowMs: now });

  it("selects all 100, a zone, or one pot, and never an unavailable one", () => {
    const all = selectAvailable(pairings, availability);
    expect(all.size).toBe(100);
    const zone2 = pairings.filter((pairing) => pairing.zone === 2).map((pairing) => pairing.name);
    const withZone = toggleGroupSelection(new Set(), zone2, availability);
    expect(withZone.size).toBe(25);
    expect(toggleGroupSelection(withZone, zone2, availability).size).toBe(0);
    const blocked = new Map(availability);
    blocked.set("Zone1-Pot3", { available: false, reason: "No valve", notes: [], lastReadingAtMs: null });
    expect(toggleSelection(new Set(), "Zone1-Pot3", blocked).size).toBe(0);
    expect(selectAvailable(pairings, blocked).size).toBe(99);
  });

  it("builds the run from each pairing's own identities, never from pot numbers or positions", () => {
    const selected = new Set(["Zone4-Pot100", "Zone1-Pot2", "Zone3-Pot51"]);
    const pots = buildSelectedPots(pairings, selected, new Set(["Zone1-Pot2"]));
    expect(pots.map((pot) => pot.pairingName)).toEqual(["Zone1-Pot2", "Zone3-Pot51", "Zone4-Pot100"]);
    for (const pot of pots) {
      const pairing = pairings.find((item) => item.name === pot.pairingName)!;
      expect(pot.valveKey).toBe(pairing.valve_key);
      expect(pot.sensorKey).toBe(pairing.sensor_key);
    }
    expect(pots[0].reference).toBe(true);
    expect(pots[1].reference).toBeUndefined();
  });

  it("summarizes the selection by zone and pot range", () => {
    const selected = new Set(pairings.slice(0, 30).map((pairing) => pairing.name).concat("Zone4-Pot99"));
    const summary = summarizeSelection(pairings, selected, availability);
    expect(summary.count).toBe(31);
    expect(summary.potRanges).toBe("1–30, 99");
    expect(summary.zones.map((zone) => zone.selected)).toEqual([25, 5, 0, 1]);
  });

  it("drops pots that disappeared or became unavailable after a configuration change", () => {
    const selected = new Set(["Zone1-Pot1", "Zone1-Pot2", "Gone"]);
    const blocked = new Map(availability);
    blocked.set("Zone1-Pot2", { available: false, reason: "Sensor silent", notes: [], lastReadingAtMs: null });
    const { selection, removed } = pruneSelection(selected, pairings, blocked);
    expect([...selection]).toEqual(["Zone1-Pot1"]);
    expect(removed.sort()).toEqual(["Gone", "Zone1-Pot2"]);
  });

  it("suggests references only where a bench confirmation still matches the wiring", () => {
    const binding = (pairing: PairingRow, status: string, valveKey = pairing.valve_key) => ({
      researchPotId: `r${pairing.id}`, potNumber: pairing.pot_number, label: "", positionLabel: null, pairingName: pairing.name,
      sensorKey: pairing.sensor_key, valveKey, physicalStatus: status, effectiveAt: null,
    });
    const refs = confirmedReferences(pairings, [
      binding(pairings[0], "researcher_confirmed"),
      binding(pairings[1], "software_only"),
      binding(pairings[2], "delivery_verified", "99:1"),
      binding(pairings[3], "delivery_verified"),
    ]);
    expect(refs).toEqual([pairings[0].name, pairings[3].name]);
  });
});

function row(patch: Partial<CommissioningSessionRow>): CommissioningSessionRow {
  return {
    id: "s", run_id: "hw-20261021-a", status: "prepared", active: true, pot_count: 2, operator_label: null, created_by: "u",
    original_snapshot: [], record: emptyRecord({ experimentId: "installation", experimentName: "Installation", selection: [] }) as unknown as Record<string, unknown>,
    config_hash_at_start: null, heartbeat_at: null, run_token: null, stop_requested_at: null, stop_requested_by: null,
    started_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z", ended_at: null, ...patch,
  };
}

describe("session stage", () => {
  it("maps every session status to the step the researcher continues from", () => {
    const stage = (status: string, extra: Partial<CommissioningSessionRow> = {}, runningHere = false) => sessionStage(row({ status, ...extra }), { runningHere, nowMs: now }).stage;
    expect(sessionStage(null, { runningHere: false, nowMs: now }).stage).toBe("select");
    expect(stage("preparing")).toBe("prepare");
    expect(stage("prepared")).toBe("check");
    expect(stage("interrupted")).toBe("check");
    expect(stage("running", {}, true)).toBe("run");
    expect(stage("analyzed")).toBe("review");
    expect(stage("verified")).toBe("review");
    expect(stage("restoring")).toBe("restore");
    expect(stage("restored", { active: false })).toBe("closed");
  });

  it("treats a run whose screen stopped renewing as interrupted, and a fresh one as running elsewhere", () => {
    const stale = sessionStage(row({ status: "running", heartbeat_at: new Date(now - 10 * 60_000).toISOString() }), { runningHere: false, nowMs: now });
    expect(stale).toEqual({ stage: "check", remoteRun: false, staleRun: true });
    const live = sessionStage(row({ status: "running", heartbeat_at: new Date(now - 20_000).toISOString() }), { runningHere: false, nowMs: now });
    expect(live).toEqual({ stage: "run", remoteRun: true, staleRun: false });
  });

  it("only a complete real run moves to review; a rehearsal leaves the session prepared", () => {
    expect(statusAfterRun("completed", "real")).toBe("analyzed");
    expect(statusAfterRun("completed_with_findings", "real")).toBe("analyzed");
    expect(statusAfterRun("interrupted", "real")).toBe("interrupted");
    expect(statusAfterRun("stopped_by_interlock", "real")).toBe("interrupted");
    expect(statusAfterRun("dry_run_completed", "dry_run")).toBe("prepared");
    expect(statusAfterRun("aborted", "dry_run")).toBe("prepared");
    expect(statusAfterRun("dry_run_completed", "dry_run", "interrupted")).toBe("interrupted");
  });
});

describe("original settings across sessions", () => {
  const pairings = installation(4);
  const originals = snapshotPots(pairings, pairings.map((pairing) => pairing.name));
  const prepared = pairings.map((pairing) => ({ ...pairing, wtc_percent_limit: -999999, measurement_interval_ms: 60_000 }));

  it("carries a held-back pot's real originals into the next session instead of its prepared state", () => {
    const earlier = row({
      run_id: "hw-20261020-old", active: false, status: "restored", original_snapshot: originals,
      record: { ...emptyRecord({ experimentId: "i", experimentName: "I", selection: [] }), heldBack: [{ pairingName: pairings[1].name, reason: "Its valve was not resolved" }] } as unknown as Record<string, unknown>,
    });
    const now2 = snapshotPots(prepared, prepared.map((pairing) => pairing.name));
    const { snapshot, carried } = carryForwardOriginals(now2, [earlier]);
    expect(carried).toEqual([{ pairingName: pairings[1].name, fromRunId: "hw-20261020-old" }]);
    expect(snapshot[1].wtcPercentLimit).toBe(22);
    expect(snapshot[1].measurementIntervalMs).toBe(600_000);
    expect(snapshot[1].wateringDisabled).toBe(false);
    // Pots that session restored are taken as they are now.
    expect(snapshot[0].wtcPercentLimit).toBe(-999999);
    const notes = heldBackFromEarlier([earlier], prepared);
    expect([...notes.keys()]).toEqual([pairings[1].name]);
  });
});

function proposal(valveKey: string, sensorKey: string, recordedSensorKey: string, patch: Partial<ProposedMapping> = {}): ProposedMapping {
  return {
    valveKey, pairingName: "", proposedSensorKey: sensorKey, recordedSensorKey, matchesRecord: sensorKey === recordedSensorKey,
    confidence: 0.95, status: "proposed", faults: [], deltaVwc: 2, z: 20, pulseSeconds: 3, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0, commandId: "c", ...patch,
  };
}

function resultFor(pots: SelectedPot[], proposals: ProposedMapping[]): CommissioningResult {
  return {
    runId: "hw", mode: "real", outcome: "completed", stopReason: null, startedAt: "", endedAt: "", pots, baselines: [], evidence: [],
    proposals, unresolved: [], unclaimed: [], pulsesRequested: 0, valveSecondsRequested: 0, log: [], completedValves: [], segments: 1, interruption: null,
  };
}

describe("reviewing measured changes", () => {
  const pairings = installation(6);
  const snapshot = snapshotPots(pairings, pairings.map((pairing) => pairing.name));
  const pots = buildSelectedPots(pairings, new Set(pairings.map((pairing) => pairing.name)), new Set([pairings[5].name]));
  const p = (index: number) => pairings[index];

  it("groups differences into complete swaps and cycles, and reports broken chains", () => {
    const proposals = [
      // swap 0 <-> 1
      proposal(p(0).valve_key, p(1).sensor_key, p(0).sensor_key),
      proposal(p(1).valve_key, p(0).sensor_key, p(1).sensor_key),
      // 3-cycle 2 -> 3 -> 4 -> 2, with one finding
      proposal(p(2).valve_key, p(3).sensor_key, p(2).sensor_key),
      proposal(p(3).valve_key, p(4).sensor_key, p(3).sensor_key, { status: "needs_review", faults: ["cross_talk"], confidence: 0.55 }),
      proposal(p(4).valve_key, p(2).sensor_key, p(4).sensor_key),
      // reference pot 5 matches
      proposal(p(5).valve_key, p(5).sensor_key, p(5).sensor_key),
    ];
    const { cycles, incomplete, confirmed } = reviewCycles(resultFor(pots, proposals), snapshot);
    expect(cycles.map((cycle) => cycle.changes.length)).toEqual([2, 3]);
    expect(cycles[0].clean).toBe(true);
    expect(cycles[1].clean).toBe(false);
    expect(cycles[1].faults).toEqual(["cross_talk"]);
    expect(cycles[1].minConfidence).toBe(0.55);
    expect(incomplete).toEqual([]);
    expect(confirmed.map((item) => item.valveKey)).toEqual([p(5).valve_key]);
    expect(referenceChecks(resultFor(pots, proposals))).toEqual([{ pairingName: p(5).name, outcome: "matched" }]);

    // Valve 1 unresolved: the swap is only half measured and cannot be applied.
    const broken = reviewCycles(resultFor(pots, proposals.filter((item) => item.valveKey !== p(1).valve_key)), snapshot);
    expect(broken.cycles.map((cycle) => cycle.changes.length)).toEqual([3]);
    expect(broken.incomplete.flat().map((change) => change.pairingName)).toEqual([p(1).name]);
  });

  it("re-checks the live configuration before applying", () => {
    const changes: ValveChange[] = [
      { pairingName: p(0).name, sensorKey: p(0).sensor_key, fromValveKey: p(0).valve_key, toValveKey: p(1).valve_key },
      { pairingName: p(1).name, sensorKey: p(1).sensor_key, fromValveKey: p(1).valve_key, toValveKey: p(0).valve_key },
    ];
    expect(applyPreconditions(changes, pairings)).toEqual([]);
    const moved = pairings.map((pairing, index) => index === 0 ? { ...pairing, valve_key: "40:1" } : pairing);
    expect(applyPreconditions(changes, moved)[0]).toMatch(/now on valve 40:1/);
    const resensored = pairings.map((pairing, index) => index === 1 ? { ...pairing, sensor_key: "SDI-X:1" } : pairing);
    expect(applyPreconditions(changes, resensored)[0]).toMatch(/now reports sensor SDI-X:1/);
    const stolen = pairings.map((pairing, index) => index === 2 ? { ...pairing, valve_key: p(1).valve_key } : pairing);
    expect(applyPreconditions(changes, stolen).join(" ")).toMatch(/is now on Zone1-Pot3, which is not part of this change/);
  });

  it("reads the controller's configuration back to classify a remap and a restore", () => {
    const changes: ValveChange[] = [
      { pairingName: p(0).name, sensorKey: p(0).sensor_key, fromValveKey: p(0).valve_key, toValveKey: p(1).valve_key },
      { pairingName: p(1).name, sensorKey: p(1).sensor_key, fromValveKey: p(1).valve_key, toValveKey: p(0).valve_key },
    ];
    expect(remapReadback(changes, pairings, snapshot)).toBe("not_applied");
    const applied = pairings.map((pairing, index) => index === 0 ? { ...pairing, valve_key: p(1).valve_key } : index === 1 ? { ...pairing, valve_key: p(0).valve_key } : pairing);
    expect(remapReadback(changes, applied, snapshot)).toBe("verified");
    const half = pairings.map((pairing, index) => index === 0 ? { ...pairing, valve_key: p(1).valve_key } : pairing);
    expect(remapReadback(changes, half, snapshot)).toBe("mismatch");

    const preparedPairings = pairings.map((pairing) => ({ ...pairing, wtc_percent_limit: -999999, measurement_interval_ms: 60_000 }));
    expect(preparedState(pairings.map((pairing) => pairing.name), preparedPairings).notPrepared).toEqual([]);
    expect(preparedState(pairings.map((pairing) => pairing.name), pairings).prepared).toEqual([]);
    expect(restoreReadback(snapshot, preparedPairings)).toBe("not_applied");
    expect(restoreReadback(snapshot, pairings)).toBe("verified");
  });
});

describe("per-pot states on the aerial view", () => {
  const pairings = installation(5);
  const pots = buildSelectedPots(pairings, new Set(pairings.map((pairing) => pairing.name)));
  const potForSensor = new Map(pairings.map((pairing) => [pairing.sensor_key, pairing.pot_number]));
  const pulse = (index: number, risenSensor: string | null, ack: "succeeded" | "failed" = "succeeded"): PulseEvidence => ({
    valveKey: pots[index].valveKey, pairingName: pots[index].pairingName, step: pots[index].valveKey, escalated: false, requestedSeconds: 3,
    requestedAt: "2026-10-21T12:00:00Z", commandId: `c${index}`, operationId: null,
    acknowledgement: { status: ack, at: "2026-10-21T12:00:05Z", error: ack === "failed" ? "relay fault" : null, controllerResult: null },
    responses: pots.map((pot) => ({ sensorKey: pot.sensorKey, preVwc: 20, postVwc: pot.sensorKey === risenSensor ? 23 : 20, deltaVwc: pot.sensorKey === risenSensor ? 3 : 0, z: pot.sensorKey === risenSensor ? 30 : 0.2, postCount: 3, detected: pot.sensorKey === risenSensor })),
    observedSeconds: 300, physicalDeliveryVerified: false,
  });

  it("while running: the pot being tested, the queue, and preliminary readings of measured valves", () => {
    const evidence = [pulse(0, pots[0].sensorKey), pulse(1, pots[2].sensorKey), pulse(2, null), pulse(3, null, "failed")];
    const states = liveStates({ pots, evidence, completedValves: [pots[0].valveKey, pots[1].valveKey, pots[2].valveKey], activeValveKey: pots[4].valveKey, potForSensor });
    expect(states.get(pots[0].pairingName)?.status).toBe("matched");
    expect(states.get(pots[1].pairingName)?.status).toBe("changed");
    expect(states.get(pots[1].pairingName)?.detail).toMatch(/pot 3 instead \(preliminary\)/);
    expect(states.get(pots[2].pairingName)?.status).toBe("unresolved");
    expect(states.get(pots[3].pairingName)?.status).toBe("failed");
    expect(states.get(pots[4].pairingName)?.status).toBe("active");
  });

  it("after a complete run: match, a different valve either way, unresolved, unclaimed, failed", () => {
    const result = resultFor(pots, [
      proposal(pots[0].valveKey, pots[0].sensorKey, pots[0].sensorKey),
      proposal(pots[1].valveKey, pots[2].sensorKey, pots[1].sensorKey),
    ]);
    result.unresolved = [
      { valveKey: pots[3].valveKey, pairingName: pots[3].pairingName, reason: "no_response", detail: "" },
      { valveKey: pots[4].valveKey, pairingName: pots[4].pairingName, reason: "command_failed", detail: "" },
    ];
    result.unclaimed = [{ sensorKey: pots[1].sensorKey, pairingName: pots[1].pairingName, detail: "" }];
    result.completedValves = pots.map((pot) => pot.valveKey);
    const states = resultStates(result, potForSensor);
    expect(states.get(pots[0].pairingName)?.status).toBe("matched");
    // Pot 2's recorded valve waters pot 3; pot 3 is watered by pot 2's valve.
    expect(states.get(pots[2].pairingName)?.status).toBe("changed");
    expect(states.get(pots[2].pairingName)?.detail).toMatch(/valve .* waters it/);
    expect(states.get(pots[1].pairingName)?.status).toBe("unclaimed");
    expect(states.get(pots[3].pairingName)?.status).toBe("unresolved");
    expect(states.get(pots[4].pairingName)?.status).toBe("failed");
    expect(resultCounts(result)).toMatchObject({ matched: 1, different: 1, unresolved: 2, unclaimed: 1 });
  });

  it("an interrupted run shows what was measured but never a mapping", () => {
    const result = { ...resultFor(pots, []), outcome: "interrupted" as const, completedValves: [pots[0].valveKey] };
    const states = resultStates(result, potForSensor);
    expect(states.get(pots[0].pairingName)?.status).toBe("interrupted");
    expect(states.get(pots[1].pairingName)?.status).toBe("queued");
  });
});
