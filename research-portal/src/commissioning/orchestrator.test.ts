import { describe, expect, it } from "vitest";

import { buildWorld, type PresetId } from "../autocal/simulator";
import { MockController, type MockOptions } from "./testing/mockController";
import {
  CommissioningRun,
  defaultCommissioningConfig,
  hardLimits,
  requiredConfirmation,
  validateConfig,
  validateSelection,
} from "./orchestrator";
import type { CommissioningConfig, CommissioningMode, SelectedPot } from "./types";

function setup(presetId: PresetId, seed: number, potCount = 10, options: MockOptions = {}) {
  const world = buildWorld({ presetId, seed, potCount });
  const controller = new MockController(world, options);
  return { world, controller, pots: controller.pots() };
}

async function execute(
  input: ReturnType<typeof setup>,
  mode: CommissioningMode = "real",
  config: Partial<CommissioningConfig> = {},
) {
  const run = new CommissioningRun({ runId: "run-test", mode, pots: input.pots, ports: input.controller.ports(), config });
  const result = await run.run({ confirmation: requiredConfirmation(input.pots) });
  return { run, result };
}

describe("real commissioning through the command queue (mock controller)", () => {
  it("discovers the hidden hose layout one valve at a time and only proposes it", async () => {
    const input = setup("clean-24", 7, 12);
    const frozen = JSON.stringify(input.pots);
    const { result } = await execute(input);

    expect(["completed", "completed_with_findings"]).toContain(result.outcome);
    expect(result.unresolved).toEqual([]);
    expect(result.proposals).toHaveLength(12);
    for (const proposal of result.proposals) {
      const valveIndex = input.world.valves.findIndex((valve) => valve.id === proposal.valveKey);
      expect(proposal.proposedSensorKey).toBe(input.world.sensors[input.world.truth[valveIndex]!].id);
      // A weak response to a short pulse may honestly be low confidence; nothing else is acceptable here.
      expect(proposal.faults.filter((fault) => fault !== "low_confidence")).toEqual([]);
      // Residual settling may show as a small rival, but never as a second detection.
      expect(proposal.rowRivalDeltaVwc).toBeLessThan(defaultCommissioningConfig.minDeltaVwc);
      expect(proposal.columnRivalDeltaVwc).toBeLessThan(defaultCommissioningConfig.minDeltaVwc);
    }
    expect(result.proposals.filter((proposal) => proposal.status === "proposed").length).toBeGreaterThanOrEqual(10);
    // The layout was shuffled, so the recorded pairings are mostly wrong and that is reported, not applied.
    expect(result.proposals.some((proposal) => !proposal.matchesRecord)).toBe(true);
    expect(JSON.stringify(input.pots)).toBe(frozen);

    expect(input.controller.overlapViolations).toEqual([]);
    expect(input.controller.pulseRequests).toHaveLength(12);
    expect(new Set(input.controller.pulseRequests.map((request) => request.pairingName)).size).toBe(12);
    expect(result.pulsesRequested).toBe(12);
    expect(result.valveSecondsRequested).toBe(12 * defaultCommissioningConfig.pulseSeconds);
  });

  it("keeps the request, the controller acknowledgement, and the sensor measurement as separate facts", async () => {
    const { result } = await execute(setup("clean-24", 8, 8));
    for (const item of result.evidence) {
      expect(item.commandId).toMatch(/^cmd-/);
      expect(item.acknowledgement.status).toBe("succeeded");
      expect(item.acknowledgement.controllerResult).toMatchObject({ failSafe: "controller_timed_pulse" });
      expect(item.responses.length).toBe(8);
      expect(item.physicalDeliveryVerified).toBe(false);
    }
    const kinds = result.log.map((entry) => entry.kind);
    const firstRequest = kinds.indexOf("command_request");
    expect(kinds.slice(firstRequest, firstRequest + 3)).toEqual(["command_request", "command_ack", "observation"]);
    expect(result.log.map((entry) => entry.seq)).toEqual(result.log.map((_, index) => index + 1));
    expect(result.log.at(-1)?.message).toContain("Run ended");
    expect(result.log.find((entry) => entry.kind === "command_ack")?.message).toContain("not that water reached a pot");
  });

  it("reports hoses that contradict the recorded pairings", async () => {
    const input = setup("swapped-hoses", 71, 12);
    // Present the recorded (pre-swap) pairings to the run, as the portal would.
    const recorded = new Map(input.world.recordedPairings.map((row) => [row.valveId, row.sensorId]));
    input.pots = input.pots.map((pot) => ({ ...pot, sensorKey: recorded.get(pot.valveKey) ?? pot.sensorKey }));
    const { result } = await execute(input);
    expect(result.proposals).toHaveLength(12);
    expect(result.proposals.filter((proposal) => !proposal.matchesRecord)).toHaveLength(4);
  });

  it("escalates a silent valve exactly once, then flags it and moves on", async () => {
    const input = setup("disconnected-hose", 44, 12);
    const { result } = await execute(input);
    const silent = input.world.valves.filter((valve) => valve.fault === "disconnected_hose" || valve.fault === "stuck_closed");
    expect(silent).toHaveLength(2);
    for (const valve of silent) {
      const requests = input.controller.pulseRequests.filter((request) => request.step.startsWith(valve.id));
      expect(requests.map((request) => request.seconds)).toEqual([3, 6]);
      expect(result.unresolved.find((item) => item.valveKey === valve.id)?.reason).toBe("no_response");
    }
    const healthy = input.world.valves.filter((valve) => valve.fault === "none");
    for (const valve of healthy) {
      expect(input.controller.pulseRequests.filter((request) => request.step.startsWith(valve.id))).toHaveLength(1);
    }
    expect(result.outcome).toBe("completed_with_findings");
  });

  it("never proposes one sensor for two valves", async () => {
    const { result } = await execute(setup("cross-talk", 52, 12));
    const sensors = result.proposals.map((proposal) => proposal.proposedSensorKey);
    expect(new Set(sensors).size).toBe(sensors.length);
    expect(result.proposals.some((proposal) => proposal.status === "needs_review")).toBe(true);
  });
});

describe("start gate", () => {
  it("refuses a real run without the exact typed confirmation", async () => {
    const input = setup("clean-24", 3, 8);
    const run = new CommissioningRun({ runId: "r", mode: "real", pots: input.pots, ports: input.controller.ports() });
    await expect(run.run({ confirmation: "open 8 real valves" })).rejects.toThrow(/confirmation/);
    await expect(new CommissioningRun({ runId: "r", mode: "real", pots: input.pots, ports: input.controller.ports() }).run()).rejects.toThrow(/confirmation/);
    expect(input.controller.pulseRequests).toHaveLength(0);
    expect(requiredConfirmation(input.pots)).toBe("OPEN 8 REAL VALVES");
  });

  it("rejects duplicate identities, out-of-range selections, and out-of-limit pulses", () => {
    const pot = (n: number): SelectedPot => ({ pairingName: `P${n}`, potNumber: n, valveKey: `v${n}`, sensorKey: `s${n}` });
    expect(validateSelection([pot(1), pot(2)])).toEqual([]);
    expect(validateSelection([pot(1)])[0]).toMatch(/between 2 and 20/);
    expect(validateSelection(Array.from({ length: 21 }, (_, index) => pot(index)))[0]).toMatch(/between 2 and 20/);
    expect(validateSelection([pot(1), { ...pot(2), valveKey: "v1" }]).join(" ")).toMatch(/Valve identities must be unique: v1/);
    expect(validateSelection([pot(1), { ...pot(2), sensorKey: "s1" }]).join(" ")).toMatch(/Sensor identities must be unique: s1/);

    expect(validateConfig(defaultCommissioningConfig)).toEqual([]);
    expect(validateConfig({ ...defaultCommissioningConfig, pulseSeconds: hardLimits.maxPulseSeconds + 1 }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultCommissioningConfig, escalatedPulseSeconds: 60 }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...defaultCommissioningConfig, maxTotalValveSeconds: 5000 }).length).toBeGreaterThan(0);
  });

  it("will not command any valve when the limits are violated", async () => {
    const input = setup("clean-24", 3, 8);
    const run = new CommissioningRun({ runId: "r", mode: "real", pots: input.pots, ports: input.controller.ports(), config: { pulseSeconds: 30 } });
    await expect(run.run({ confirmation: requiredConfirmation(input.pots) })).rejects.toThrow(/Diagnostic pulse/);
    expect(input.controller.pulseRequests).toHaveLength(0);
  });
});

describe("dry run", () => {
  it("exercises the whole orchestration without sending a single valve command", async () => {
    const input = setup("clean-24", 5, 10);
    const { result } = await execute(input, "dry_run");
    expect(input.controller.pulseRequests).toHaveLength(0);
    expect(input.controller.pulsesExecuted).toBe(0);
    expect(result.outcome).toBe("dry_run_completed");
    expect(result.pulsesRequested).toBe(0);
    expect(result.valveSecondsRequested).toBe(0);
    expect(result.proposals).toEqual([]);
    // Every valve was walked, including the single escalation step.
    expect(result.evidence).toHaveLength(20);
    expect(result.evidence.every((item) => item.acknowledgement.status === "not_sent" && item.commandId === null)).toBe(true);
    expect(result.log.filter((entry) => entry.kind === "command_request").every((entry) => entry.message.startsWith("DRY RUN"))).toBe(true);
    expect(result.unresolved.every((item) => item.reason === "command_failed")).toBe(true);
  });

  it("still stops on an unsafe controller state", async () => {
    const input = setup("clean-24", 5, 8, { controllerState: "STOPPED" });
    const { result } = await execute(input, "dry_run");
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(input.controller.pulseRequests).toHaveLength(0);
  });
});

describe("interlocks stop the run and never retry", () => {
  it("server intake gate closed: one refused request, no water, no proposal", async () => {
    const input = setup("clean-24", 6, 8, { intakeOpen: false });
    const { result } = await execute(input);
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(/Manual watering remains locked/);
    expect(input.controller.pulseRequests).toHaveLength(1);
    expect(input.controller.pulsesExecuted).toBe(0);
    expect(result.proposals).toEqual([]);
  });

  it.each([
    ["executor manual-water gate closed", { executorManualWaterEnabled: false }, /timed-pulse bench protocol/],
    ["executor in dry-run", { executorDryRun: true }, /dry-run mode/],
  ])("%s: the failed command ends the run", async (_label, options, pattern) => {
    const input = setup("clean-24", 6, 8, options as MockOptions);
    const { result } = await execute(input);
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(pattern);
    expect(input.controller.pulseRequests).toHaveLength(1);
    expect(input.controller.pulsesExecuted).toBe(0);
    expect(result.evidence[0].acknowledgement.status).toBe("failed");
  });

  it("command with no final status: times out as an unknown outcome", async () => {
    const input = setup("clean-24", 6, 8, { hangCommands: true });
    const { result } = await execute(input, "real", { commandTimeoutSeconds: 60 });
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(/outcome is unknown/);
    expect(input.controller.pulseRequests).toHaveLength(1);
  });

  it("controller goes stale mid-run: stops before the next pulse", async () => {
    const input = setup("clean-24", 6, 8, { staleAfterPulses: 3 });
    const { result } = await execute(input);
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(/stale/);
    expect(input.controller.pulseRequests).toHaveLength(3);
    expect(result.proposals).toEqual([]);
    expect(result.unresolved.filter((item) => item.reason === "not_reached")).toHaveLength(5);
  });

  it("controller not in a safe commissioning state: no pulse at all", async () => {
    const input = setup("clean-24", 6, 8, { controllerState: "STOPPED" });
    const { result } = await execute(input);
    expect(result.stopReason).toMatch(/not in a safe commissioning state/);
    expect(input.controller.pulseRequests).toHaveLength(0);
  });

  it("automatic watering still enabled on a selected pot: no pulse at all", async () => {
    const input = setup("clean-24", 6, 8);
    input.controller.options.autoWateringPairings = [input.pots[2].pairingName];
    const { result } = await execute(input);
    expect(result.stopReason).toMatch(/Automatic watering is still enabled on Zone1-Pot3/);
    expect(input.controller.pulseRequests).toHaveLength(0);
  });

  it("another watering command appears: stops", async () => {
    const input = setup("clean-24", 6, 8, { conflictAfterPulses: 2 });
    const { result } = await execute(input);
    expect(result.stopReason).toMatch(/other watering command/);
    expect(input.controller.pulseRequests).toHaveLength(2);
  });

  it("a sensor stops reporting: stops", async () => {
    const input = setup("clean-24", 6, 8);
    input.controller.options.silenceSensorAfterPulses = { sensorKey: input.pots[5].sensorKey, pulses: 1 };
    const { result } = await execute(input, "real", { sensorSilenceSeconds: 240 });
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(/stopped reporting/);
    expect(input.controller.pulseRequests.length).toBeLessThan(8);
  });

  it("an unusable sensor at baseline: no valve is commanded", async () => {
    const input = setup("bad-sensor", 21, 12);
    const { result } = await execute(input);
    expect(result.outcome).toBe("stopped_by_interlock");
    expect(result.stopReason).toMatch(/Sensor check failed/);
    expect(input.controller.pulseRequests).toHaveLength(0);
  });

  it("water budget: never requests a pulse that would exceed it", async () => {
    const input = setup("clean-24", 6, 8);
    const { result } = await execute(input, "real", { maxTotalValveSeconds: 10 });
    expect(result.stopReason).toMatch(/Water budget/);
    expect(input.controller.pulseRequests).toHaveLength(3);
    expect(result.valveSecondsRequested).toBe(9);
  });

  it("pulse budget: stops at the configured count", async () => {
    const input = setup("clean-24", 6, 8);
    const { result } = await execute(input, "real", { maxPulses: 2 });
    expect(result.stopReason).toMatch(/Pulse budget/);
    expect(input.controller.pulseRequests).toHaveLength(2);
  });

  it("a rejected request (for example a quarantined device) ends the run", async () => {
    const input = setup("clean-24", 6, 8, { rejectRequestAfterPulses: 1 });
    const { result } = await execute(input);
    expect(result.stopReason).toMatch(/quarantined/);
    expect(input.controller.pulseRequests).toHaveLength(2);
    expect(input.controller.pulsesExecuted).toBe(1);
  });
});

describe("stop / abort", () => {
  it("prevents every further pulse and proposes nothing", async () => {
    const input = setup("clean-24", 9, 10);
    const ports = input.controller.ports();
    let run: CommissioningRun | null = null;
    const watched = {
      ...ports,
      requestPulse: async (request: Parameters<typeof ports.requestPulse>[0]) => {
        const ticket = await ports.requestPulse(request);
        if (input.controller.pulseRequests.length === 3) run?.abort("Operator pressed Stop.");
        return ticket;
      },
    };
    run = new CommissioningRun({ runId: "r", mode: "real", pots: input.pots, ports: watched });
    const result = await run.run({ confirmation: requiredConfirmation(input.pots) });

    expect(result.outcome).toBe("aborted");
    expect(result.stopReason).toBe("Operator pressed Stop.");
    expect(input.controller.pulseRequests).toHaveLength(3);
    expect(result.proposals).toEqual([]);
    expect(result.log.some((entry) => entry.kind === "abort")).toBe(true);
    // The pulse that was already queued is still followed to its end and logged.
    expect(result.evidence[2].acknowledgement.status).toBe("succeeded");
    run.abort("again");
    expect(result.log.filter((entry) => entry.kind === "abort")).toHaveLength(1);
  });

  it("cannot be started twice", async () => {
    const input = setup("clean-24", 9, 8);
    const run = new CommissioningRun({ runId: "r", mode: "dry_run", pots: input.pots, ports: input.controller.ports() });
    await run.run();
    await expect(run.run()).rejects.toThrow(/already been started/);
  });
});
