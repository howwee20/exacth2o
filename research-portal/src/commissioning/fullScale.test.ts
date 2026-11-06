import { describe, expect, it } from "vitest";

import { buildWorld, type PresetId } from "../autocal/simulator";
import { CommissioningRun, configForSelection, requiredConfirmation } from "./orchestrator";
import { MockController, type MockOptions } from "./testing/mockController";
import { createTelemetryReader, type TelemetryPageRequest, type TelemetryRow } from "./telemetry";
import { buildRemapPlan, changeCycles, snapshotPots, valveChangesFromProposals } from "./topologyPlan";
import type { CommissioningConfig, CommissioningResult, SelectedPot } from "./types";
import type { PairingRow } from "../types";

// Full-installation scenarios on the seeded simulator. Every run here goes through the
// real orchestrator and the same ports the browser uses; only the controller is mocked.

const cycle = (count: number) => Array.from({ length: count }, (_, index) => (index + 1) % count);
const identity = (count: number) => Array.from({ length: count }, (_, index) => index);

function setup(options: { preset?: PresetId; seed?: number; count?: number; hoseTargets?: number[]; mock?: MockOptions } = {}) {
  const count = options.count ?? 100;
  const world = buildWorld({ presetId: options.preset ?? "clean-100", seed: options.seed ?? 11, potCount: count, hoseTargets: options.hoseTargets });
  const controller = new MockController(world, options.mock ?? {});
  return { world, controller, pots: controller.pots() };
}

async function execute(input: ReturnType<typeof setup>, pots: SelectedPot[] = input.pots, config: Partial<CommissioningConfig> = {}, resumeFrom: CommissioningResult | null = null) {
  const run = new CommissioningRun({ runId: "hw-full", mode: "real", pots, ports: input.controller.ports(), config: { ...configForSelection(pots.length), ...config }, resumeFrom });
  const result = await run.run({ confirmation: requiredConfirmation(pots) });
  return { run, result };
}

function truthSensor(input: ReturnType<typeof setup>, valveKey: string) {
  const valveIndex = input.world.valves.findIndex((valve) => valve.id === valveKey);
  const potIndex = input.world.truth[valveIndex];
  return potIndex == null ? null : input.world.sensors[potIndex].id;
}

function asPairings(pots: SelectedPot[]): PairingRow[] {
  return pots.map((pot, index) => ({
    id: index + 1, name: pot.pairingName, zone: Math.floor(index / 25) + 1, pot_number: pot.potNumber ?? index + 1,
    source_sensor_id: index + 1, sensor_key: pot.sensorKey, source_valve_id: 1000 + index, valve_key: pot.valveKey,
    wtc_percent_limit: -999999, valve_open_time_ms: 3000, measurement_interval_ms: 60_000, group_name: "Bench", calibration_name: null,
  }));
}

describe("full 100-pot installation", () => {
  it("discovers a hidden cycle through all 100 pots in one coherent run, within its budgets", async () => {
    const input = setup({ hoseTargets: cycle(100) });
    const { result } = await execute(input);

    expect(["completed", "completed_with_findings"]).toContain(result.outcome);
    expect(result.proposals).toHaveLength(100);
    expect(result.unresolved).toEqual([]);
    for (const proposal of result.proposals) {
      expect(proposal.proposedSensorKey).toBe(truthSensor(input, proposal.valveKey));
      expect(proposal.matchesRecord).toBe(false);
    }
    // One pulse per valve: nothing needed a retry, and the controller saw no overlap.
    expect(input.controller.pulseRequests).toHaveLength(100);
    expect(result.valveSecondsRequested).toBe(300);
    expect(result.pulsesRequested).toBeLessThanOrEqual(200);
    expect(input.controller.overlapViolations).toEqual([]);
    // Every pulse was measured on all 100 sensors: one response matrix, no batches.
    expect(result.evidence.every((item) => item.responses.length === 100)).toBe(true);

    const snapshot = snapshotPots(asPairings(input.pots), input.pots.map((pot) => pot.pairingName));
    const { changes, problems } = valveChangesFromProposals(result.proposals, snapshot);
    expect(problems).toEqual([]);
    expect(changes).toHaveLength(100);
    expect(changeCycles(changes).cycles.map((chain) => chain.length)).toEqual([100]);
    const plan = buildRemapPlan(changes, snapshot, "apply", result.runId);
    expect(plan.plan?.commands).toHaveLength(1);
  }, 120_000);

  it("finds swaps across zones and leaves correct pots unchanged", async () => {
    const layout = identity(100);
    [layout[2], layout[96]] = [layout[96], layout[2]]; // zone 1 <-> zone 4
    [layout[30], layout[55]] = [layout[55], layout[30]]; // zone 2 <-> zone 3
    const input = setup({ hoseTargets: layout, seed: 23 });
    const { result } = await execute(input);
    const different = result.proposals.filter((proposal) => !proposal.matchesRecord).map((proposal) => proposal.valveKey).sort();
    expect(different).toEqual([input.pots[2], input.pots[30], input.pots[55], input.pots[96]].map((pot) => pot.valveKey).sort());
    const snapshot = snapshotPots(asPairings(input.pots), input.pots.map((pot) => pot.pairingName));
    const { changes } = valveChangesFromProposals(result.proposals, snapshot);
    expect(changeCycles(changes).cycles.map((chain) => chain.length).sort()).toEqual([2, 2]);
  }, 120_000);

  it("reports a counterpart outside the selected subset instead of inventing a match", async () => {
    // Valve 5 waters pot 60 and valve 60 waters pot 5; only pots 1-10 are selected.
    const layout = identity(100);
    [layout[4], layout[59]] = [layout[59], layout[4]];
    const input = setup({ hoseTargets: layout, seed: 31 });
    const subset = input.pots.slice(0, 10);
    const { result } = await execute(input, subset);
    expect(input.controller.pulseRequests.every((request) => subset.some((pot) => pot.pairingName === request.pairingName))).toBe(true);
    const unresolved = result.unresolved.find((item) => item.valveKey === subset[4].valveKey);
    expect(unresolved?.reason).toBe("no_response");
    expect(unresolved?.detail).toMatch(/outside the selected pots/);
    expect(result.unclaimed.map((item) => item.sensorKey)).toEqual([subset[4].sensorKey]);
    expect(result.unclaimed[0].detail).toMatch(/outside the selection/);
    expect(result.proposals.find((proposal) => proposal.valveKey === subset[4].valveKey)).toBeUndefined();
  }, 120_000);

  it("bounds escalations: every silent valve gets exactly one retry, inside the 900 valve-second budget", async () => {
    const input = setup({ preset: "disconnected-hose", count: 20, seed: 5 });
    // Disconnect every hose: no pulse can move a sensor.
    input.world.valves.forEach((valve) => { valve.fault = "disconnected_hose"; });
    const { result } = await execute(input);
    expect(input.controller.pulseRequests).toHaveLength(40);
    expect(input.controller.pulseRequests.filter((request) => request.step.includes("escalated"))).toHaveLength(20);
    expect(result.valveSecondsRequested).toBe(20 * 9);
    expect(result.unresolved).toHaveLength(20);
    expect(result.unresolved.every((item) => item.reason === "no_response")).toBe(true);
  }, 120_000);

  it("stops before any pulse that would exceed the water budget", async () => {
    const input = setup({ count: 30, seed: 8, hoseTargets: identity(30) });
    input.world.valves.forEach((valve) => { valve.fault = "disconnected_hose"; });
    const { result } = await execute(input, input.pots, { maxTotalValveSeconds: 100 });
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(/Water budget of 100 valve-seconds/);
    expect(result.valveSecondsRequested).toBeLessThanOrEqual(100);
    expect(result.proposals).toEqual([]);
  }, 120_000);

  it("keeps seeing new readings through more than 5,000 rows and many API pages", async () => {
    const input = setup({ hoseTargets: cycle(100), seed: 41, mock: { pagedTelemetry: { pageSize: 1000, maxUploadDelaySeconds: 90 } } });
    const { result } = await execute(input);
    expect(input.controller.storedReadings).toBeGreaterThan(5_000);
    expect(input.controller.telemetryRequests).toBeGreaterThan(10);
    expect(input.controller.maxRowsReturned).toBeLessThanOrEqual(1000);
    expect(result.proposals).toHaveLength(100);
    expect(result.proposals.every((proposal) => proposal.proposedSensorKey === truthSensor(input, proposal.valveKey))).toBe(true);
  }, 180_000);

  it("stops when manual watering starts mid-run, keeps earlier evidence, and resumes to a complete matrix", async () => {
    const input = setup({ count: 24, seed: 13, hoseTargets: cycle(24), mock: { manualHoldAfterPulses: { pulses: 10, holdSeconds: 90, label: "solenoid 23" } } });
    const first = await execute(input);
    expect(first.result.outcome).toBe("interrupted");
    expect(first.result.interruption?.source).toBe("manual_watering");
    expect(first.result.stopReason).toMatch(/solenoid 23/);
    expect(first.result.proposals).toEqual([]);
    const invalidated = first.result.evidence.filter((item) => item.invalidated);
    expect(invalidated.length).toBeGreaterThan(0);
    const keptValves = first.result.completedValves.length;
    expect(keptValves).toBeGreaterThan(0);
    expect(keptValves).toBeLessThan(24);
    const pulsesBefore = input.controller.pulseRequests.length;

    // Resuming while the hold is still open (or the pots are settling) waits.
    const early = await execute(input, input.pots, {}, first.result);
    expect(early.result.outcome).toBe("interrupted");
    expect(early.result.stopReason).toMatch(/in progress/);
    expect(input.controller.pulseRequests.length).toBe(pulsesBefore);
    input.controller.idle(3 * 60);

    const resumed = await execute(input, input.pots, {}, early.result);
    expect(["completed", "completed_with_findings"]).toContain(resumed.result.outcome);
    expect(resumed.result.segments).toBe(3);
    expect(resumed.result.proposals).toHaveLength(24);
    expect(resumed.result.proposals.every((proposal) => proposal.proposedSensorKey === truthSensor(input, proposal.valveKey))).toBe(true);
    // Valves with usable evidence were not pulsed again.
    const repeated = input.controller.pulseRequests.slice(pulsesBefore).filter((request) => first.result.completedValves.includes(input.pots.find((pot) => pot.pairingName === request.pairingName)!.valveKey));
    expect(repeated).toEqual([]);
  }, 120_000);

  it("treats a pulse the controller cut short, or refused for manual control, as an interruption", async () => {
    const cut = setup({ count: 8, seed: 3, hoseTargets: identity(8), mock: { interruptPulseNumber: 3 } });
    const cutResult = (await execute(cut)).result;
    expect(cutResult.outcome).toBe("interrupted");
    expect(cutResult.evidence.find((item) => item.invalidated)?.acknowledgement.controllerResult?.interrupted).toBe("preempted_by_manual_hold");
    const refused = setup({ count: 8, seed: 3, hoseTargets: identity(8), mock: { refuseAsManualAfterPulses: 2 } });
    const refusedResult = (await execute(refused)).result;
    expect(refusedResult.outcome).toBe("interrupted");
    expect(refusedResult.interruption?.source).toBe("manual_watering");
  }, 120_000);

  it("an operator starting manual control in this browser interrupts the run at once", async () => {
    const input = setup({ count: 8, seed: 4, hoseTargets: identity(8) });
    const run = new CommissioningRun({ runId: "hw-local", mode: "real", pots: input.pots, ports: input.controller.ports(), config: configForSelection(8) });
    const pending = run.run({ confirmation: requiredConfirmation(input.pots) });
    run.interruptForManualWatering("pot 3");
    const result = await pending;
    expect(result.outcome).toBe("interrupted");
    expect(result.interruption?.source).toBe("manual_watering");
    expect(input.controller.pulseRequests.length).toBeLessThanOrEqual(1);
  });

  it("a stop during an observation sets the half-measured pulse aside, and a resume measures that valve afresh", async () => {
    const input = setup({ count: 8, seed: 19, hoseTargets: identity(8) });
    const run: CommissioningRun = new CommissioningRun({
      runId: "hw-stop", mode: "real", pots: input.pots, ports: input.controller.ports(), config: configForSelection(input.pots.length),
      onUpdate: () => { if (run.activeStep === "observing" && run.evidence.length === 3) run.abort(); },
    });
    const first = await run.run({ confirmation: requiredConfirmation(input.pots) });
    expect(first.outcome).toBe("aborted");
    const half = first.evidence[2];
    expect(half.acknowledgement.status).toBe("succeeded");
    expect(half.invalidated?.reason).toMatch(/observation finished/);
    expect(first.completedValves).not.toContain(half.valveKey);
    input.controller.idle(30 * 60);

    const resumed = await execute(input, input.pots, {}, first);
    // A fresh first pulse, not the escalated retry a silent first pulse would earn.
    const steps = input.controller.pulseRequests.filter((request) => request.pairingName === input.pots[2].pairingName).map((request) => request.step);
    expect(steps.map((step) => step.includes("escalated"))).toEqual([false, false]);
    expect(resumed.result.proposals).toHaveLength(input.pots.length);
    expect(resumed.result.proposals.every((proposal) => proposal.matchesRecord)).toBe(true);
  }, 120_000);

  it("a checkpoint saved mid-run resumes to the complete matrix after the screen closes", async () => {
    const input = setup({ count: 8, seed: 29, hoseTargets: cycle(8) });
    let saved: CommissioningResult | null = null;
    const run: CommissioningRun = new CommissioningRun({
      runId: "hw-checkpoint", mode: "real", pots: input.pots, ports: input.controller.ports(), config: configForSelection(input.pots.length),
      onUpdate: () => {
        if (!saved && run.completedValves().length === 4 && run.activeStep === "observing") {
          // What the server holds when the browser disappears: the checkpoint, nothing later.
          saved = JSON.parse(JSON.stringify(run.checkpoint()));
          run.abort("The screen closed.", "screen_closed");
        }
      },
    });
    await run.run({ confirmation: requiredConfirmation(input.pots) });
    const checkpoint = saved as CommissioningResult | null;
    expect(checkpoint?.outcome).toBe("interrupted");
    expect(checkpoint?.proposals).toEqual([]);
    expect(checkpoint?.completedValves).toHaveLength(4);
    expect(checkpoint?.interruption?.source).toBe("screen_closed");
    expect(checkpoint?.evidence[checkpoint.evidence.length - 1].invalidated?.reason).toMatch(/observation finished/);
    input.controller.idle(30 * 60);

    const resumed = await execute(input, input.pots, {}, checkpoint);
    expect(["completed", "completed_with_findings"]).toContain(resumed.result.outcome);
    expect(resumed.result.proposals).toHaveLength(input.pots.length);
    expect(resumed.result.proposals.every((proposal) => proposal.proposedSensorKey === truthSensor(input, proposal.valveKey))).toBe(true);
  }, 120_000);

  it("flags a proposal that contradicts a confirmed reference pot instead of treating it as routine", async () => {
    const layout = identity(12);
    [layout[0], layout[1]] = [layout[1], layout[0]];
    const input = setup({ count: 12, seed: 17, hoseTargets: layout });
    const pots = input.pots.map((pot, index) => ({ ...pot, reference: index === 0 || index === 5 }));
    const { result } = await execute(input, pots);
    const conflict = result.proposals.find((proposal) => proposal.valveKey === pots[0].valveKey);
    expect(conflict?.faults).toContain("reference_conflict");
    expect(conflict?.status).toBe("needs_review");
    const confirmed = result.proposals.find((proposal) => proposal.valveKey === pots[5].valveKey);
    expect(confirmed?.matchesRecord).toBe(true);
    expect(confirmed?.faults).not.toContain("reference_conflict");
  }, 120_000);

  it.each([
    ["noisy", "noisy"],
    ["bad sensors (dead, raw counts, flatlined, saturated)", "bad-sensor"],
    ["cross-talk and duplicate claims", "cross-talk"],
  ] as const)("refuses to mislabel weak evidence at full scale: %s", async (_label, preset) => {
    const input = setup({ preset, count: 100, seed: 61 });
    const { result } = await execute(input);
    if (preset === "bad-sensor") {
      // Unusable sensors stop the run before any valve opens.
      expect(result.outcome).toBe("stopped_by_interlock");
      expect(input.controller.pulseRequests).toHaveLength(0);
      return;
    }
    for (const proposal of result.proposals.filter((item) => item.status === "proposed")) {
      expect(proposal.proposedSensorKey).toBe(truthSensor(input, proposal.valveKey));
    }
    if (preset === "cross-talk") {
      const faults = new Set(result.proposals.flatMap((proposal) => proposal.faults).concat(result.unresolved.map((item) => item.reason as never)));
      expect([...faults].some((fault) => ["cross_talk", "multiple_responses", "duplicate_claim"].includes(fault))).toBe(true);
    }
  }, 240_000);
});

describe("telemetry paging", () => {
  // A PostgREST-like table: 100 sensors x 60 readings, uploads arriving out of order.
  function table() {
    const rows: TelemetryRow[] = [];
    let id = 0;
    for (let minute = 0; minute < 60; minute += 1) {
      for (let sensor = 0; sensor < 100; sensor += 1) {
        const recorded = Date.UTC(2026, 9, 21, 15, minute, sensor % 60);
        rows.push({ id: ++id, sensorKey: `S${sensor}`, recordedAt: new Date(recorded).toISOString(), receivedAt: new Date(recorded + ((id * 7919) % 120) * 1000).toISOString(), vwc: 20 + minute / 10 });
      }
    }
    return rows;
  }

  function fetcher(rows: TelemetryRow[], nowMs: () => number, calls: TelemetryPageRequest[]) {
    return async (request: TelemetryPageRequest) => {
      calls.push(request);
      const column = request.order === "recorded" ? "recordedAt" : "receivedAt";
      return rows
        .filter((row) => Date.parse(row.receivedAt) <= nowMs() && request.sensorKeys.includes(row.sensorKey) && Date.parse(row[column]) >= Date.parse(request.since))
        .filter((row) => !request.after || Date.parse(row[column]) > Date.parse(request.after.at) || (Date.parse(row[column]) === Date.parse(request.after.at) && row.id > request.after.id))
        .sort((a, b) => Date.parse(a[column]) - Date.parse(b[column]) || a.id - b.id)
        .slice(0, Math.min(1000, request.limit));
    };
  }

  it("pages through 6,000 readings at 1,000 per request, then follows only new receipts", async () => {
    const rows = table();
    const calls: TelemetryPageRequest[] = [];
    let now = Date.UTC(2026, 9, 21, 16, 30);
    const reader = createTelemetryReader(fetcher(rows, () => now, calls));
    const keys = Array.from({ length: 100 }, (_, index) => `S${index}`);
    const first = await reader.read(keys, Date.UTC(2026, 9, 21, 15, 0));
    expect(first).toHaveLength(6000);
    expect(calls.filter((call) => call.order === "recorded").length).toBeGreaterThanOrEqual(6);
    // Nothing new: the follow-up read returns nothing and does not page the window again.
    calls.length = 0;
    expect(await reader.read(keys, Date.UTC(2026, 9, 21, 15, 0))).toHaveLength(0);
    expect(calls.every((call) => call.order === "received")).toBe(true);
    // New readings, some recorded earlier but uploaded late, all arrive exactly once.
    const late: TelemetryRow[] = [];
    for (let sensor = 0; sensor < 100; sensor += 1) {
      late.push({ id: 100_000 + sensor, sensorKey: `S${sensor}`, recordedAt: new Date(Date.UTC(2026, 9, 21, 16, 29, sensor % 60)).toISOString(), receivedAt: new Date(now + 30_000).toISOString(), vwc: 25 });
    }
    rows.push(...late);
    now += 60_000;
    const next = await reader.read(keys, Date.UTC(2026, 9, 21, 15, 0));
    expect(next).toHaveLength(100);
    expect(await reader.read(keys, Date.UTC(2026, 9, 21, 15, 0))).toHaveLength(0);
    // Memory of seen ids stays bounded to the overlap, not the run length.
    expect(reader.stats().rememberedIds).toBeLessThan(6100);
  });

  it("the old capped query would have stalled on the earliest rows", async () => {
    const rows = table();
    const oldestFirst = rows.slice().sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)).slice(0, 5000);
    const newest = Math.max(...oldestFirst.map((row) => Date.parse(row.recordedAt)));
    // With a 5,000-row limit ordered oldest-first, the last ten minutes were never seen.
    expect(newest).toBeLessThan(Date.UTC(2026, 9, 21, 15, 51));
  });
});
