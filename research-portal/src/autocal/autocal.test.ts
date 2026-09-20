import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assignOneToOne } from "../topology/assignment";
import {
  AutocalRun,
  confidenceLevel,
  defaultConfig,
  pairConfidence,
  scoreAgainstTruth,
  type FaultCode,
} from "./engine";
import { createRng, normalizeSeed } from "./random";
import { buildWorld, simPresets, type MirrorPairing, type PresetId } from "./simulator";
import { buildStoredRun, deleteRun, loadRuns, saveRun, type KeyValueStorage } from "./store";

function run(presetId: PresetId, seed: number, potCount?: number, config = {}) {
  const world = buildWorld({ presetId, seed, potCount });
  const engine = new AutocalRun(world, config);
  const result = engine.runToCompletion();
  return { world, engine, result };
}

function faultCodes(result: { faults: Array<{ code: FaultCode }> }) {
  return new Set(result.faults.map((fault) => fault.code));
}

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("seeded randomness", () => {
  it("is reproducible and seed-sensitive", () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const first = [a.next(), a.next(), a.normal()];
    expect([b.next(), b.next(), b.normal()]).toEqual(first);
    expect([c.next(), c.next(), c.normal()]).not.toEqual(first);
  });

  it("produces true permutations", () => {
    const shuffled = createRng(3).shuffle(Array.from({ length: 100 }, (_, index) => index));
    expect(new Set(shuffled).size).toBe(100);
    expect(shuffled).not.toEqual(Array.from({ length: 100 }, (_, index) => index));
  });

  it("normalizes user-entered seeds", () => {
    expect(normalizeSeed("42")).toBe(42);
    expect(normalizeSeed("-42.9")).toBe(42);
    expect(normalizeSeed("not a number", 5)).toBe(5);
  });
});

describe("one-to-one assignment", () => {
  it("finds the global optimum where a greedy pick would duplicate a sensor", () => {
    // Greedy by row gives valve 0 -> sensor 1, leaving valve 1 (which only moved
    // sensor 1) with nothing. The global optimum pairs both.
    const result = assignOneToOne([
      [0.9, 1.0],
      [0.0, 1.0],
    ]);
    expect(result).toEqual([0, 1]);
  });

  it("never assigns a sensor twice and never assigns without evidence", () => {
    const result = assignOneToOne([
      [1, 0, 0],
      [1, 0, 0],
      [0, 0, 0],
    ]);
    const assigned = result.filter((value): value is number => value != null);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned).toEqual([0]);
    expect(result[2]).toBeNull();
  });

  it("handles rectangular and empty inputs", () => {
    expect(assignOneToOne([])).toEqual([]);
    expect(assignOneToOne([[0.2, 0.9, 0.1]])).toEqual([1]);
    expect(assignOneToOne([[0.5], [0.9]])).toEqual([null, 0]);
  });
});

describe("clean installations", () => {
  it.each([1, 2, 3, 11, 2026])("recovers a random 24-pot permutation exactly (seed %i)", (seed) => {
    const { world, result } = run("clean-24", seed);
    expect(result.status).toBe("completed");
    expect(result.proposals).toHaveLength(24);
    expect(scoreAgainstTruth(world, result)).toEqual({ correct: 24, wrong: 0, resolvable: 24 });
    expect(result.unresolvedValves).toHaveLength(0);
    expect(result.proposals.every((pair) => pair.status === "proposed")).toBe(true);
    expect(Math.min(...result.proposals.map((pair) => pair.confidence))).toBeGreaterThan(0.85);
  });

  it("recovers a 100-pot installation exactly", () => {
    const { world, result } = run("clean-100", 99);
    expect(world.valves).toHaveLength(100);
    // The hidden layout really is shuffled, not the identity.
    expect(world.truth.some((sensorIndex, valveIndex) => sensorIndex !== valveIndex)).toBe(true);
    expect(scoreAgainstTruth(world, result)).toEqual({ correct: 100, wrong: 0, resolvable: 100 });
    expect(result.faults).toHaveLength(0);
  });

  it("characterizes every pair with bounded, conservative estimates", () => {
    const { world, result } = run("clean-24", 5);
    for (const pair of result.proposals) {
      const estimate = pair.characterization!;
      const truePot = world.pots[pair.sensorIndex];
      expect(estimate.pass).toBe(true);
      expect(estimate.deltaRange[0]).toBeLessThanOrEqual(estimate.deltaRange[1]);
      expect(estimate.lagSeconds).toBeGreaterThan(0);
      expect(estimate.settleSeconds!).toBeGreaterThanOrEqual(estimate.lagSeconds!);
      // Conservative means it never overstates the pot's true small-signal gain.
      expect(estimate.conservativeGainPerSecond).toBeGreaterThan(0);
      expect(estimate.conservativeGainPerSecond).toBeLessThan(truePot.gainPerSecond);
    }
  });

  it("verifies sampled pairs without touching unrelated sensors", () => {
    const { result } = run("clean-24", 8);
    expect(result.verification).toHaveLength(defaultConfig.verificationEvents);
    expect(result.verification.every((item) => item.outcome === "verified")).toBe(true);
    const verified = result.proposals.filter((pair) => pair.lastVerifiedAtSeconds != null);
    expect(verified).toHaveLength(defaultConfig.verificationEvents);
  });
});

describe("determinism", () => {
  it("gives identical results for the same seed and different results for another", () => {
    const first = run("cross-talk", 314).result;
    const second = run("cross-talk", 314).result;
    const other = run("cross-talk", 315).result;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it("builds the same hidden installation from the same seed", () => {
    expect(buildWorld({ presetId: "bad-sensor", seed: 12 })).toEqual(buildWorld({ presetId: "bad-sensor", seed: 12 }));
  });
});

describe("failure presets", () => {
  it("excludes dead, raw-count, flatlined, and saturated sensors before any water is used", () => {
    const { world, result } = run("bad-sensor", 21);
    const exclusions = result.validations.filter((item) => !item.valid).map((item) => item.exclusion).sort();
    expect(exclusions).toEqual(["flatlined", "raw_counts", "saturated", "unreachable"]);
    expect(faultCodes(result).has("sensor_invalid")).toBe(true);
    expect(faultCodes(result).has("saturated")).toBe(true);

    const excluded = new Set(result.validations.filter((item) => !item.valid).map((item) => item.sensorIndex));
    expect(result.proposals.some((pair) => excluded.has(pair.sensorIndex))).toBe(false);
    expect(result.unresolvedValves).toHaveLength(4);
    expect(scoreAgainstTruth(world, result)).toMatchObject({ correct: 20, wrong: 0 });
  });

  it("excludes excessively noisy sensors and reports a non-converging pot", () => {
    const { world, result } = run("noisy", 33);
    const noisy = result.validations.filter((item) => item.exclusion === "excessive_noise");
    expect(noisy).toHaveLength(2);
    expect(noisy.every((item) => world.sensors[item.sensorIndex].fault === "noisy")).toBe(true);
    expect(faultCodes(result).has("excessive_noise")).toBe(true);
    expect(faultCodes(result).has("non_convergence")).toBe(true);
    const erratic = result.proposals.find((pair) => pair.faults.includes("non_convergence"))!;
    expect(erratic.status).toBe("needs_review");
    expect(erratic.characterization!.pass).toBe(false);
    expect(erratic.characterization!.conservativeGainPerSecond).toBe(0);
    expect(scoreAgainstTruth(world, result).wrong).toBe(0);
  });

  it("separates no-flow, no-response, and weak-flow valves, escalating exactly once", () => {
    const { world, engine, result } = run("disconnected-hose", 44);
    const disconnected = world.valves.find((valve) => valve.fault === "disconnected_hose")!;
    const stuck = world.valves.find((valve) => valve.fault === "stuck_closed")!;
    const weak = world.valves.find((valve) => valve.fault === "weak_flow")!;

    const unresolved = new Map(result.unresolvedValves.map((item) => [item.valveIndex, item.reason]));
    expect(unresolved.get(disconnected.index)).toBe("no_response");
    expect(unresolved.get(stuck.index)).toBe("flow_anomaly");
    expect(faultCodes(result).has("no_response")).toBe(true);
    expect(faultCodes(result).has("flow_anomaly")).toBe(true);

    // One escalation per silent valve: 6 baseline + 24 pulses + 2 escalations + 1 assignment.
    const escalations = engine.log.filter((line) => line.includes("Trying one longer pulse"));
    expect(escalations).toHaveLength(2);

    const weakPair = result.proposals.find((pair) => pair.valveIndex === weak.index)!;
    expect(weakPair.sensorIndex).toBe(world.truth[weak.index]);
    expect(weakPair.faults).toContain("flow_anomaly");
    expect(weakPair.status).toBe("needs_review");
    expect(scoreAgainstTruth(world, result).wrong).toBe(0);
  });

  it("flags cross-talk, ambiguity, and duplicate claims without ever duplicating a sensor", () => {
    for (const seed of [51, 52, 53, 54]) {
      const { world, result } = run("cross-talk", seed);
      const codes = faultCodes(result);
      expect(codes.has("cross_talk")).toBe(true);
      expect(codes.has("multiple_responses")).toBe(true);
      expect(codes.has("duplicate_claim")).toBe(true);

      const sensors = result.proposals.map((pair) => pair.sensorIndex);
      expect(new Set(sensors).size).toBe(sensors.length);
      const valves = result.proposals.map((pair) => pair.valveIndex);
      expect(new Set(valves).size).toBe(valves.length);

      // Ambiguous pairs are never presented as confident.
      for (const pair of result.proposals) {
        if (pair.faults.includes("multiple_responses") || pair.faults.includes("duplicate_claim")) {
          expect(pair.status).toBe("needs_review");
          expect(pair.confidence).toBeLessThan(0.6);
        }
      }
      // Healthy valves in the same installation are still mapped correctly.
      const clean = result.proposals.filter((pair) => pair.status === "proposed");
      expect(clean.length).toBeGreaterThanOrEqual(16);
      expect(clean.every((pair) => world.truth[pair.valveIndex] === pair.sensorIndex)).toBe(true);
    }
  });

  it("reports overshoot and an unsettled response, and does not pulse those pots again", () => {
    const { result } = run("difficult-soil", 61);
    const codes = faultCodes(result);
    expect(codes.has("overshoot")).toBe(true);
    expect(codes.has("timeout")).toBe(true);
    for (const pair of result.proposals.filter((item) => item.faults.includes("overshoot") || item.faults.includes("timeout"))) {
      expect(pair.status).toBe("needs_review");
      expect(pair.characterization!.pass).toBe(false);
      expect(pair.characterization!.note).toContain("Not pulsed again");
    }
  });

  it("discovers hoses that contradict the recorded pairings", () => {
    const { world, result } = run("swapped-hoses", 71);
    expect(world.recordedPairings).toHaveLength(24);
    expect(scoreAgainstTruth(world, result)).toMatchObject({ correct: 24, wrong: 0 });
    const recorded = new Map(world.recordedPairings.map((row) => [row.valveId, row.sensorId]));
    const differences = result.proposals.filter((pair) =>
      recorded.get(world.valves[pair.valveIndex].id) !== world.sensors[pair.sensorIndex].id);
    expect(differences).toHaveLength(4);
  });

  it("has a described preset for every scenario", () => {
    expect(simPresets.map((preset) => preset.id)).toEqual(expect.arrayContaining([
      "clean-24", "clean-100", "noisy", "disconnected-hose", "bad-sensor", "cross-talk",
    ]));
    for (const preset of simPresets) {
      expect(() => run(preset.id, 5, 8)).not.toThrow();
    }
  });
});

describe("confidence", () => {
  it("is high for a strong, unrivalled response", () => {
    const confidence = pairConfidence({ deltaVwc: 3, z: 50, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0 });
    expect(confidence).toBeCloseTo(1);
    expect(confidenceLevel(confidence)).toBe("High");
  });

  it("reflects ambiguity, not just response strength", () => {
    const strongButAmbiguous = pairConfidence({ deltaVwc: 3, z: 50, rowRivalDeltaVwc: 2.7, columnRivalDeltaVwc: 0 });
    const weakerButClear = pairConfidence({ deltaVwc: 1.2, z: 18, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0 });
    expect(strongButAmbiguous).toBeLessThan(0.2);
    expect(weakerButClear).toBeGreaterThan(strongButAmbiguous);
    expect(confidenceLevel(strongButAmbiguous)).toBe("Low");
  });

  it("drops when another valve also moves the same sensor", () => {
    const contested = pairConfidence({ deltaVwc: 3, z: 50, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 3 });
    expect(contested).toBe(0);
  });

  it("is bounded and monotonic in response strength", () => {
    const weak = pairConfidence({ deltaVwc: 0.5, z: 6, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0 });
    const strong = pairConfidence({ deltaVwc: 0.5, z: 14, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0 });
    expect(weak).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(weak);
    expect(pairConfidence({ deltaVwc: 0, z: 0, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0 })).toBe(0);
  });
});

describe("abort and timeout", () => {
  it("aborts safely mid-run and produces no proposal", () => {
    const world = buildWorld({ presetId: "clean-24", seed: 9 });
    const engine = new AutocalRun(world);
    for (let count = 0; count < 15; count += 1) engine.step();
    engine.abort();
    expect(engine.done).toBe(true);
    expect(engine.step()).toBeNull();
    const result = engine.result();
    expect(result.status).toBe("aborted");
    expect(result.proposals).toHaveLength(0);
    expect(result.unresolvedValves).toHaveLength(24);
    expect(faultCodes(result).has("aborted")).toBe(true);
  });

  it("stops at its time budget instead of running on", () => {
    const { result } = run("clean-24", 9, 24, { maxRunSeconds: 3600 });
    expect(result.status).toBe("timeout");
    expect(result.elapsedSeconds).toBeLessThanOrEqual(3600);
    expect(faultCodes(result).has("timeout")).toBe(true);
    expect(result.proposals).toHaveLength(0);
    expect(result.unresolvedValves).toHaveLength(24);
  });

  it("always terminates, even when nothing responds", () => {
    const world = buildWorld({ presetId: "clean-24", seed: 4, potCount: 8 });
    world.valves.forEach((valve) => { valve.fault = "stuck_closed"; });
    const engine = new AutocalRun(world);
    const result = engine.runToCompletion(500);
    expect(engine.done).toBe(true);
    // 6 baseline + 8 pulses + 8 single escalations + assignment + finish.
    expect(result.stepsExecuted).toBe(24);
    expect(result.proposals).toHaveLength(0);
    expect(result.unresolvedValves).toHaveLength(8);
  });
});

describe("continuous verification demonstration", () => {
  it("detects a hose swap and flags it without changing anything else", () => {
    const { world, result } = run("clean-24", 17, 24, { injectHoseSwap: true });
    expect(result.hoseSwapInjected).not.toBeNull();
    const [first, second] = result.hoseSwapInjected!;
    const mismatches = result.verification.filter((item) => item.outcome === "mismatch").map((item) => item.valveIndex).sort();
    expect(mismatches).toEqual([first, second].sort());
    for (const valveIndex of [first, second]) {
      const pair = result.proposals.find((item) => item.valveIndex === valveIndex)!;
      expect(pair.status).toBe("needs_review");
      expect(pair.faults).toContain("verification_mismatch");
      expect(pair.lastVerifiedAtSeconds).toBeNull();
    }
    // The hidden installation definition itself is not rewritten by the demonstration.
    expect(world.truth).toEqual(buildWorld({ presetId: "clean-24", seed: 17 }).truth);
  });
});

describe("safety boundary", () => {
  const mirror: MirrorPairing[] = Array.from({ length: 24 }, (_, index) => ({
    valveId: `0x20:${index + 1}`,
    sensorId: `LIVE${index + 1}:y`,
    potLabel: `Zone1-Pot${index + 1}`,
  }));

  it("rediscovers the configured pairings from a read-only mirror without mutating them", () => {
    const frozen = Object.freeze(mirror.map((row) => Object.freeze({ ...row })));
    const before = JSON.stringify(frozen);
    const world = buildWorld({ presetId: "clean-24", seed: 81, mirror: frozen });
    const result = new AutocalRun(world).runToCompletion();

    expect(world.source).toBe("mirror");
    expect(JSON.stringify(frozen)).toBe(before);
    expect(result.proposals).toHaveLength(24);
    const recorded = new Map(world.recordedPairings.map((row) => [row.valveId, row.sensorId]));
    expect(result.proposals.every((pair) => recorded.get(world.valves[pair.valveIndex].id) === world.sensors[pair.sensorIndex].id)).toBe(true);
  });

  it("makes no network call of any kind during a full run", () => {
    const forbidden = vi.fn(() => {
      throw new Error("Simulation attempted a network call.");
    });
    vi.stubGlobal("fetch", forbidden);
    vi.stubGlobal("XMLHttpRequest", forbidden);
    vi.stubGlobal("WebSocket", forbidden);
    vi.stubGlobal("EventSource", forbidden);

    const { result } = run("cross-talk", 91);
    const storage = memoryStorage();
    const world = buildWorld({ presetId: "clean-24", seed: 91 });
    const stored = buildStoredRun({
      runId: "run-1",
      projectId: "project",
      experimentId: "experiment",
      world,
      config: defaultConfig,
      result: new AutocalRun(world).runToCompletion(),
      startedAt: new Date("2026-09-19T20:00:00.000Z"),
      endedAt: new Date("2026-09-19T20:00:05.000Z"),
      existingRuns: [],
    });
    saveRun(storage, "project", stored);

    expect(result.status).not.toBe("running");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("cannot reach Supabase, control commands, or the network from the simulation modules", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(here, name));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    const forbidden = [
      /from\s+["'][^"']*supabase/i,
      /\bfetch\s*\(/,
      /XMLHttpRequest|WebSocket|EventSource|sendBeacon/,
      /functions\.invoke/,
      /onQueueCommand|queueControlCommand|create-control-command/,
      /manual_water|update_pairing|create_pairing|delete_pairing|apply_calibration|update_system_state/,
      /from\s+["']\.\.?\/(App|CalibrationStudio|SettingsAssistant|experimentClient|chamberControlClient)["']/,
    ];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} must not match ${pattern}`).toBe(false);
      }
    }
  });
});

describe("proposal store", () => {
  function storedRun(runId: string, storage: KeyValueStorage) {
    const world = buildWorld({ presetId: "cross-talk", seed: 101 });
    const result = new AutocalRun(world).runToCompletion();
    return buildStoredRun({
      runId,
      projectId: "project-a",
      experimentId: "experiment-2",
      world,
      config: defaultConfig,
      result,
      startedAt: new Date("2026-09-19T20:00:00.000Z"),
      endedAt: new Date("2026-09-19T20:00:09.000Z"),
      existingRuns: loadRuns(storage, "project-a"),
    });
  }

  it("records a complete, auditable proposal that is never marked applied", () => {
    const storage = memoryStorage();
    const stored = storedRun("run-a", storage);
    expect(stored).toMatchObject({
      runId: "run-a",
      projectId: "project-a",
      experimentId: "experiment-2",
      mode: "simulation",
      proposalState: "proposed_not_applied",
      topologyVersion: "proposal-1",
      simulator: { seed: 101, presetId: "cross-talk", potCount: 24, source: "synthetic" },
    });
    expect(stored.algorithmVersion).toMatch(/^autocal-sim-/);
    expect(stored.proposals[0]).toEqual(expect.objectContaining({
      valveId: expect.any(String),
      sensorId: expect.any(String),
      confidence: expect.any(Number),
      discoveredAt: expect.stringMatching(/^2026-09-19T/),
    }));
    expect(Object.keys(stored.faultCounts).length).toBeGreaterThan(0);
  });

  it("writes only its own namespaced key and keeps earlier proposals for provenance", () => {
    const storage = memoryStorage();
    storage.setItem("exacth2o.portal.rememberEmail", "untouched");
    saveRun(storage, "project-a", storedRun("run-a", storage));
    saveRun(storage, "project-a", storedRun("run-b", storage));

    expect(Array.from(storage.data.keys()).sort()).toEqual([
      "exacth2o.autocalibration.v1.project-a",
      "exacth2o.portal.rememberEmail",
    ]);
    expect(storage.getItem("exacth2o.portal.rememberEmail")).toBe("untouched");
    const runs = loadRuns(storage, "project-a");
    expect(runs.map((item) => item.runId)).toEqual(["run-b", "run-a"]);
    expect(runs.map((item) => item.topologyVersion)).toEqual(["proposal-2", "proposal-1"]);
    expect(loadRuns(storage, "project-b")).toEqual([]);

    deleteRun(storage, "project-a", "run-b");
    expect(loadRuns(storage, "project-a").map((item) => item.runId)).toEqual(["run-a"]);
  });

  it("survives missing, corrupt, or blocked storage", () => {
    expect(loadRuns(null, "project-a")).toEqual([]);
    const corrupt = memoryStorage();
    corrupt.setItem("exacth2o.autocalibration.v1.project-a", "{not json");
    expect(loadRuns(corrupt, "project-a")).toEqual([]);
    const blocked: KeyValueStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(loadRuns(blocked, "project-a")).toEqual([]);
    expect(saveRun(blocked, "project-a", storedRun("run-a", memoryStorage()))).toBe(false);
  });
});
