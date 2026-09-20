import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultCommissioningConfig } from "./orchestrator";
import { evaluatePreflight, type PreflightFacts } from "./preflight";
import {
  buildPreparePlan,
  buildRestorePlan,
  buildTopologyPlan,
  invertChanges,
  maxPlanCommands,
  snapshotPots,
  valveChangesFromProposals,
  verifyReadback,
} from "./topologyPlan";
import type { PairingRow } from "../types";
import type { ProposedMapping, SelectedPot, SensorBaseline } from "./types";

const now = Date.parse("2026-09-22T15:00:00.000Z");

function pairing(n: number, overrides: Partial<PairingRow> = {}): PairingRow {
  return {
    id: n,
    name: `Zone1-Pot${n}`,
    zone: 1,
    pot_number: n,
    group_name: "Maize control",
    source_sensor_id: n,
    sensor_key: `S${n}`,
    source_valve_id: 100 + n,
    valve_key: `0x20:${n}`,
    wtc_percent_limit: 30,
    valve_open_time_ms: 5000,
    measurement_interval_ms: 600000,
    calibration_name: n % 2 ? "teros-2026" : null,
    ...overrides,
  };
}

const pots = (count: number): SelectedPot[] => Array.from({ length: count }, (_, index) => ({
  pairingName: `Zone1-Pot${index + 1}`,
  potNumber: index + 1,
  valveKey: `0x20:${index + 1}`,
  sensorKey: `S${index + 1}`,
}));

const baseline = (sensorKey: string, overrides: Partial<SensorBaseline> = {}): SensorBaseline => ({
  sensorKey, valid: true, reason: null, warnings: [], count: 6, medianVwc: 24, noiseSigma: 0.1,
  driftPerMinute: 0, cadenceSeconds: 60, lastAtMs: now - 30_000, ...overrides,
});

function facts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  const selected = pots(12);
  return {
    mode: "real",
    role: "admin",
    pots: selected,
    config: defaultCommissioningConfig,
    nowMs: now,
    controller: { observedAtMs: now - 20_000, freshUntilMs: now + 200_000, controllerState: "RUNNING", wateringEnabled: true },
    controllerError: null,
    activeWateringCommands: 0,
    intake: { open: true, detail: "ok" },
    baselines: selected.map((pot) => baseline(pot.sensorKey)),
    autoWateringPairings: [],
    ...overrides,
  };
}

const failed = (report: ReturnType<typeof evaluatePreflight>) => report.checks.filter((check) => check.blocks).map((check) => check.id);

describe("preflight", () => {
  it("passes only when every gate is satisfied, and always discloses the unreadable executor gate", () => {
    const report = evaluatePreflight(facts());
    expect(report.canStart).toBe(true);
    expect(failed(report)).toEqual([]);
    expect(report.checks.find((check) => check.id === "executor_gate")?.status).toBe("warn");
    expect(report.estimatedMinutes).toBeGreaterThan(0);
    expect(report.worstCaseValveSeconds).toBe(12 * (3 + 6));
  });

  it.each([
    ["non-admin role", { role: "researcher" }, "role"],
    ["stale controller", { controller: { observedAtMs: now - 7_200_000, freshUntilMs: now - 7_000_000, controllerState: "RUNNING", wateringEnabled: true } }, "controller_fresh"],
    ["controller never seen", { controller: null }, "controller_fresh"],
    ["automatic watering still enabled", { autoWateringPairings: ["Zone1-Pot4"] }, "auto_watering"],
    ["conflicting watering job", { activeWateringCommands: 1 }, "queue_clear"],
    ["unreadable queue", { activeWateringCommands: null }, "queue_clear"],
    ["server watering gate closed", { intake: { open: false, detail: "Manual watering remains locked" } }, "intake"],
    ["gate not probed", { intake: null }, "intake"],
    ["no sensor readings", { baselines: [] }, "sensors"],
  ])("blocks a real run: %s", (_label, overrides, id) => {
    const report = evaluatePreflight(facts(overrides as Partial<PreflightFacts>));
    expect(report.canStart).toBe(false);
    expect(failed(report)).toContain(id);
  });

  it("blocks when the controller is STOPPED, because STOPPED pauses sensing", () => {
    const report = evaluatePreflight(facts({ controller: { observedAtMs: now - 20_000, freshUntilMs: now + 200_000, controllerState: "STOPPED", wateringEnabled: false } }));
    expect(failed(report)).toContain("controller_state");
    expect(report.checks.find((check) => check.id === "controller_state")?.detail).toMatch(/pauses sensing/);
  });

  it("blocks on an implausible or silent sensor and on duplicate identities", () => {
    const selected = pots(12);
    const bad = evaluatePreflight(facts({ baselines: selected.map((pot, index) => baseline(pot.sensorKey, index === 3 ? { valid: false, reason: "Values near 2400 look like raw counts, not % VWC." } : {})) }));
    expect(failed(bad)).toContain("sensors");
    const duplicate = evaluatePreflight(facts({ pots: [...selected.slice(0, 11), { ...selected[11], valveKey: selected[0].valveKey }] }));
    expect(failed(duplicate)).toContain("selection");
  });

  it("blocks a water budget smaller than one pulse per valve and a cadence too slow to observe", () => {
    expect(failed(evaluatePreflight(facts({ config: { ...defaultCommissioningConfig, maxTotalValveSeconds: 20 } })))).toContain("budget_covers");
    const slow = evaluatePreflight(facts({ baselines: pots(12).map((pot) => baseline(pot.sensorKey, { cadenceSeconds: 1800 })) }));
    expect(failed(slow)).toContain("cadence");
  });

  it("lets a dry run proceed with the server watering gate closed, but never with an unsafe controller", () => {
    const closed = evaluatePreflight(facts({ mode: "dry_run", intake: { open: false, detail: "locked" } }));
    expect(closed.canStart).toBe(true);
    expect(closed.checks.find((check) => check.id === "intake")?.status).toBe("fail");
    expect(evaluatePreflight(facts({ mode: "dry_run", autoWateringPairings: ["Zone1-Pot1"] })).canStart).toBe(false);
  });
});

const proposal = (valveKey: string, proposedSensorKey: string, recordedSensorKey: string): ProposedMapping => ({
  valveKey, pairingName: "", proposedSensorKey, recordedSensorKey, matchesRecord: proposedSensorKey === recordedSensorKey,
  confidence: 0.95, status: "proposed", faults: [], deltaVwc: 2, z: 30, pulseSeconds: 3, rowRivalDeltaVwc: 0, columnRivalDeltaVwc: 0, commandId: "cmd-1",
});

describe("prepare and restore plans", () => {
  const pairings = [pairing(1), pairing(2, { wtc_percent_limit: 20 }), pairing(3, { wtc_percent_limit: -999999 })];
  const snapshot = snapshotPots(pairings, pairings.map((item) => item.name));

  it("records the previous settings, then disables automatic watering without touching targets' record", () => {
    expect(snapshot.map((pot) => [pot.targetVwc, pot.wateringDisabled])).toEqual([[30, false], [20, false], [null, true]]);
    const plan = buildPreparePlan(snapshot);
    expect(plan.commands).toEqual([expect.objectContaining({
      command_type: "bulk_update_pairings",
      payload: { pairing_names: ["Zone1-Pot1", "Zone1-Pot2", "Zone1-Pot3"], disable_watering: true, measurement_interval_seconds: 60 },
    })]);
  });

  it("restores each pot to exactly what was recorded, leaving a previously disabled pot disabled", () => {
    const payloads = buildRestorePlan(snapshot).commands.map((command) => command.payload);
    expect(payloads).toEqual([
      { pairing_names: ["Zone1-Pot1"], open_time_seconds: 5, measurement_interval_seconds: 600, target_vwc: 30 },
      { pairing_names: ["Zone1-Pot2"], open_time_seconds: 5, measurement_interval_seconds: 600, target_vwc: 20 },
      { pairing_names: ["Zone1-Pot3"], open_time_seconds: 5, measurement_interval_seconds: 600, disable_watering: true },
    ]);
  });
});

describe("applying reviewed mappings", () => {
  const pairings = [pairing(1), pairing(2), pairing(3), pairing(4)];
  const snapshot = snapshotPots(pairings, pairings.map((item) => item.name));
  // Hoses on valves 1 and 2 are physically swapped; 3 and 4 are right.
  const proposals = [proposal("0x20:1", "S2", "S1"), proposal("0x20:2", "S1", "S2"), proposal("0x20:3", "S3", "S3"), proposal("0x20:4", "S4", "S4")];

  it("turns proposals into per-pot valve changes and only for pots that differ", () => {
    const { changes, problems } = valveChangesFromProposals(proposals, snapshot);
    expect(problems).toEqual([]);
    expect(changes).toEqual([
      { pairingName: "Zone1-Pot2", sensorKey: "S2", fromValveKey: "0x20:2", toValveKey: "0x20:1" },
      { pairingName: "Zone1-Pot1", sensorKey: "S1", fromValveKey: "0x20:1", toValveKey: "0x20:2" },
    ]);
  });

  it("refuses half of a swap, which would leave one valve claimed twice", () => {
    const { problems } = valveChangesFromProposals([proposals[0], proposals[2], proposals[3]], snapshot);
    expect(problems.join(" ")).toMatch(/0x20:1 is still recorded on Zone1-Pot1/);
    expect(problems.join(" ")).toMatch(/0x20:2 would be left without a pot/);
  });

  it("builds a delete-then-create plan that carries settings and calibration over", () => {
    const { changes } = valveChangesFromProposals(proposals, snapshot);
    const { plan, problems } = buildTopologyPlan(changes, snapshot, "apply");
    expect(problems).toEqual([]);
    const types = plan!.commands.map((command) => command.command_type);
    expect(types).toEqual(["delete_pairing", "delete_pairing", "create_pairing", "create_pairing", "apply_calibration"]);
    expect(plan!.commands[2].payload).toEqual({
      name: "Zone1-Pot2", sensor_key: "S2", valve_key: "0x20:1", group_name: "Maize control",
      target_vwc: 30, open_time_seconds: 5, measurement_interval_seconds: 600,
    });
    expect(plan!.commands[4].payload).toEqual({ calibration_name: "teros-2026", pairing_names: ["Zone1-Pot1"] });
    // Only command types the existing reviewed-settings batch accepts.
    expect(types.every((type) => ["delete_pairing", "create_pairing", "update_pairing", "apply_calibration"].includes(type))).toBe(true);
  });

  it("recreates a sensing-only pot as sensing-only", () => {
    const disabled = snapshotPots([pairing(1, { wtc_percent_limit: -999999 }), pairing(2, { wtc_percent_limit: -999999 })], ["Zone1-Pot1", "Zone1-Pot2"]);
    const { changes } = valveChangesFromProposals(proposals.slice(0, 2), disabled);
    const { plan } = buildTopologyPlan(changes, disabled, "apply");
    expect(plan!.commands.filter((command) => command.command_type === "create_pairing").every((command) => command.payload.target_vwc === 0)).toBe(true);
    expect(plan!.commands.filter((command) => command.command_type === "update_pairing").map((command) => command.payload)).toEqual([
      { pairing_name: "Zone1-Pot2", disable_watering: true },
      { pairing_name: "Zone1-Pot1", disable_watering: true },
    ]);
  });

  it("offers an exact rollback to the previous topology", () => {
    const { changes } = valveChangesFromProposals(proposals, snapshot);
    const rollback = buildTopologyPlan(invertChanges(changes), snapshot, "rollback");
    expect(rollback.plan!.summary).toMatch(/roll back/);
    expect(rollback.plan!.commands.filter((command) => command.command_type === "create_pairing").map((command) => [command.payload.name, command.payload.valve_key]))
      .toEqual([["Zone1-Pot2", "0x20:2"], ["Zone1-Pot1", "0x20:1"]]);
  });

  it("refuses a plan too large for one reviewed batch and a plan with nothing to do", () => {
    const many = Array.from({ length: 12 }, (_, index) => pairing(index + 1));
    const snap = snapshotPots(many, many.map((item) => item.name));
    const rotated = many.map((item, index) => proposal(item.valve_key, many[(index + 1) % 12].sensor_key, item.sensor_key));
    const { changes } = valveChangesFromProposals(rotated, snap);
    const result = buildTopologyPlan(changes, snap, "apply");
    expect(result.plan).toBeNull();
    expect(result.problems.join(" ")).toMatch(new RegExp(`more than one reviewed batch allows \\(${maxPlanCommands}\\)`));
    expect(buildTopologyPlan([], snap, "apply").problems.join(" ")).toMatch(/nothing to change/);
  });

  it("verifies the change only from the controller's re-read configuration", () => {
    const { changes } = valveChangesFromProposals(proposals, snapshot);
    expect(verifyReadback(changes, pairings).verified).toBe(false);
    const applied = [pairing(1, { valve_key: "0x20:2" }), pairing(2, { valve_key: "0x20:1" }), pairing(3), pairing(4)];
    const readback = verifyReadback(changes, applied);
    expect(readback.verified).toBe(true);
    expect(readback.rows.every((row) => row.verified)).toBe(true);
    const partial = verifyReadback(changes, [pairing(1, { valve_key: "0x20:2" }), pairing(2), pairing(3), pairing(4)]);
    expect(partial.verified).toBe(false);
    expect(partial.rows.filter((row) => !row.verified).map((row) => row.pairingName)).toEqual(["Zone1-Pot2"]);
  });
});

describe("real-hardware boundary", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(here).filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."));
  const read = (name: string) => readFileSync(join(here, name), "utf8");

  const adapterPath = join(here, "..", "commissioningSupabasePorts.ts");

  it("only the adapter may reach the backend, and only through the command service", () => {
    for (const name of sources) {
      expect(/from\s+["'][^"']*supabase["']/.test(read(name)), `${name} must not import supabase`).toBe(false);
      expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(read(name)), `${name} must not make network calls`).toBe(false);
    }
    const adapter = readFileSync(adapterPath, "utf8");
    expect(adapter.match(/functions\.invoke[^"']*\(\s*["']([^"']+)["']/g)?.every((call) => call.includes("create-control-command"))).toBe(true);
    // Reads only: the adapter never inserts, updates, upserts, deletes, or calls an RPC.
    expect(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(adapter)).toBe(false);
    // No controller URL, tunnel, or privileged key in the browser path.
    expect(/balena|valves\/pulse|service_role|SERVICE_ROLE|controller-secret/i.test(adapter)).toBe(false);
  });

  it("sends exactly one pairing per pulse command and never a settings command", () => {
    const adapter = readFileSync(adapterPath, "utf8");
    expect(adapter).toContain("pairing_names: [request.pairingName]");
    expect((adapter.match(/command_type:\s*"([a-z_]+)"/g) ?? []).every((match) => match.includes("manual_water"))).toBe(true);
  });

  it("imports the Supabase client only as ./supabase so the offline Applications demo can swap it", () => {
    const src = join(here, "..");
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
    for (const file of walk(src)) {
      expect(/from\s+["']\.\.\/(\.\.\/)*supabase["']/.test(readFileSync(file, "utf8")), `${file} must import "./supabase" from src/, not a parent path`).toBe(false);
    }
  });

  it("ships no simulator, mock controller, or fixture code in the product", () => {
    const src = join(here, "..");
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "autocal" || entry.name === "testing" ? [] : walk(full);
      return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
    });
    const shipped = walk(src);
    expect(shipped.length).toBeGreaterThan(40);
    for (const file of shipped) {
      const text = readFileSync(file, "utf8");
      expect(/from\s+["'][^"']*\/(autocal|testing)\//.test(text), `${file} imports internal test infrastructure`).toBe(false);
      expect(/mockController|SimulatedBench|buildWorld\(/.test(text), `${file} references the simulator`).toBe(false);
    }
    // The internal simulator, in turn, knows nothing about the real command path.
    for (const name of readdirSync(join(src, "autocal")).filter((item) => !item.includes(".test."))) {
      expect(readFileSync(join(src, "autocal", name), "utf8").includes("commissioning"), `autocal/${name} must stay self-contained`).toBe(false);
    }
  });
});
