import { describe, expect, it } from "vitest";
import { proposeTopology } from "./analysis";
import { CommissioningRun, configForSelection, defaultCommissioningConfig, requiredConfirmation, validateConfig } from "./orchestrator";
import type { CommissioningPorts, PulseEvidence, SelectedPot, SensorResponse } from "./types";

const pots: SelectedPot[] = Array.from({ length: 4 }, (_, i) => ({ pairingName: `P${i + 1}`, potNumber: i + 1, valveKey: `v${i + 1}`, sensorKey: `s${i + 1}` }));
const rise = (sensorKey: string, deltaVwc = 2): SensorResponse => ({ sensorKey, preVwc: 20, postVwc: 20 + deltaVwc, deltaVwc, z: 30, postCount: 3, detected: true });
const pulse = (index: number, responses: SensorResponse[], patch: Partial<PulseEvidence> = {}): PulseEvidence => ({
  valveKey: `v${index}`, pairingName: `P${index}`, step: `v${index}`, escalated: false, requestedSeconds: 3,
  requestedAt: new Date(index * 1000).toISOString(), commandId: `c${index}`, operationId: null,
  acknowledgement: { status: "succeeded", at: null, error: null, controllerResult: {} },
  responses, observedSeconds: 120, physicalDeliveryVerified: false, ...patch,
});
const resolve = (evidence: PulseEvidence[]) => proposeTopology(pots, evidence, defaultCommissioningConfig);

describe("sequential unique matching", () => {
  it("reserves each clear swapped match as it arrives", () => {
    const evidence = [pulse(1, [rise("s2")]), pulse(2, [rise("s4")]), pulse(3, [rise("s1")]), pulse(4, [rise("s3")])];
    for (let count = 1; count <= 4; count++) {
      const result = resolve(evidence.slice(0, count));
      expect(result.proposals.map(p => p.proposedSensorKey)).toEqual(["s2", "s4", "s1", "s3"].slice(0, count));
    }
  });

  it("never substitutes a free runner-up for a consumed dominant sensor", () => {
    const result = resolve([pulse(1, [rise("s2")]), pulse(2, [rise("s2"), rise("s3", 0.8)])]);
    expect(result.proposals).toEqual([]);
    expect(result.unresolved.filter(p => ["v1", "v2"].includes(p.valveKey)).every(p => p.reason === "duplicate_claim")).toBe(true);
  });

  it("does not reserve ambiguous sensors or infer the last unmatched pair", () => {
    const result = resolve([pulse(1, [rise("s1"), rise("s2", 1.9)]), pulse(2, [rise("s2")]), pulse(3, [rise("s3")]), pulse(4, [])]);
    expect(result.proposals.map(p => p.proposedSensorKey)).toEqual(["s2", "s3"]);
    expect(result.unresolved.find(p => p.valveKey === "v1")?.reason).toBe("multiple_responses");
    expect(result.unresolved.find(p => p.valveKey === "v4")?.reason).toBe("no_response");
  });

  it("replays latest observations in order and never resurrects invalidated evidence", () => {
    const first = pulse(1, [rise("s2")]);
    const invalid = pulse(1, [rise("s2")], { invalidated: { reason: "interrupted", at: "now" } });
    const result = resolve([first, invalid, pulse(2, [rise("s2")])]);
    expect(result.proposals.map(p => p.valveKey)).toEqual(["v2"]);
    expect(result.unresolved.find(p => p.valveKey === "v1")?.reason).toBe("invalidated");
  });

  it("leaves failed, weak, and overshooting observations unmatched", () => {
    const weak = rise("s2"); weak.z = 6;
    const result = resolve([pulse(1, [rise("s1")], { acknowledgement: { status: "failed", at: null, error: "closed", controllerResult: null } }), pulse(2, [weak]), pulse(3, [rise("s3", 8)])]);
    expect(result.proposals).toEqual([]);
    expect(result.unresolved.map(p => p.reason)).toEqual(["command_failed", "low_confidence", "overshoot", "not_reached"]);
  });
});

/** Deterministic telemetry-only test controller; no network and no hardware. */
function timedController(delaySeconds: number | null) {
  const selected = pots.slice(0, 2);
  const epoch = Date.parse("2026-11-07T12:00:00Z");
  let now = epoch;
  const sent: Array<{ pairingName: string; at: number; seconds: number }> = [];
  const watched = new Set<string>();
  const ports: CommissioningPorts = {
    now: () => now,
    sleep: async (ms, signal) => { if (signal.aborted) throw new Error("aborted"); now += ms; },
    readControllerStatus: async () => ({ controllerState: "RUNNING", observedAtMs: now, freshUntilMs: now + 60_000, wateringEnabled: false }),
    countActiveWateringCommands: async () => 0,
    readAutoWateringPairings: async () => [],
    probePulseIntake: async () => ({ open: true, detail: "test only" }),
    readManualInterventions: async () => [],
    requestPulse: async request => { sent.push({ pairingName: request.pairingName, at: now, seconds: request.seconds }); return { commandId: `c${sent.length}`, operationId: null }; },
    readCommand: async id => ({ id, status: "succeeded", error: null, result: { failSafe: "controller_timed_pulse" } }),
    readReadings: async (keys, since) => {
      keys.forEach(key => watched.add(key));
      const rows = [];
      for (let at = epoch - 5 * 60_000; at <= now; at += 30_000) {
        if (at < since) continue;
        for (const sensorKey of keys) {
          const index = sensorKey === "s2" ? 0 : 1;
          const water = sent[index];
          const delay = index === 0 ? delaySeconds : 60;
          const response = water && delay != null && at >= water.at + delay * 1000 ? 2 : 0;
          rows.push({ sensorKey, atMs: at, vwc: 20 + response });
        }
      }
      return rows;
    },
  };
  return { ports, sent, watched, selected };
}

describe("per-valve observation window", () => {
  async function run(delay: number | null) {
    const controller = timedController(delay);
    const config = configForSelection(2, { retryUnmatched: false, maxObserveSeconds: 900, baselineLookbackSeconds: 300,
      baselineTimeoutSeconds: 120, settleSkipSeconds: 0, cooldownSeconds: 5, maxSettleSeconds: 120, pollSeconds: 15 });
    const run = new CommissioningRun({ runId: "timed", mode: "real", pots: controller.selected, ports: controller.ports, config });
    const result = await run.run({ confirmation: requiredConfirmation(controller.selected) });
    return { ...controller, result, run };
  }

  it("waits for a late rise and advances on the clear match before 15 minutes", async () => {
    const { sent, result, watched } = await run(600);
    expect(sent).toHaveLength(2);
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(600_000);
    expect(sent[1].at - sent[0].at).toBeLessThan(900_000);
    expect(result.proposals.map(p => p.proposedSensorKey)).toEqual(["s2", "s1"]);
    expect([...watched].sort()).toEqual(["s1", "s2"]);
    expect(sent.every(pulse => pulse.seconds === 3)).toBe(true);
  });

  it("does not advance on flat early samples, and times out unmatched without retry", async () => {
    const { sent, result } = await run(null);
    expect(sent).toHaveLength(2);
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(900_000);
    expect(result.unresolved.find(p => p.valveKey === "v1")?.reason).toBe("no_response");
    expect(result.proposals.some(p => p.valveKey === "v1")).toBe(false);
  });

  it("advances early for a strong immediate response", async () => {
    const { sent, run: completed } = await run(30);
    expect(sent[1].at - sent[0].at).toBeLessThan(180_000);
    expect(completed.matchesSoFar()).toHaveLength(2);
  });

  it("validates window limits and budgets the entire four-valve window separately from pulse time", () => {
    const config = configForSelection(4, { retryUnmatched: false, maxObserveSeconds: 900 });
    expect(config.maxTotalValveSeconds).toBe(12);
    expect(config.maxPulses).toBe(4);
    expect(config.maxRunSeconds).toBeGreaterThan(config.baselineTimeoutSeconds + 4 * 900);
    expect(validateConfig({ ...config, maxObserveSeconds: 0 }, 4)).toContain("Observation window (sec) must be between 60 and 3600.");
    expect(validateConfig({ ...config, maxObserveSeconds: 3601 }, 4)).toHaveLength(1);
  });
});
