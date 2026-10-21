import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { summarizeBaseline } from "./analysis";
import { configForSelection, defaultCommissioningConfig, singlePotLimitation } from "./orchestrator";
import { evaluatePreflight, type PreflightFacts } from "./preflight";
import {
  buildPreparePlan,
  buildRemapPlan,
  buildRestorePlan,
  changeCycles,
  invertChanges,
  planRestoreScope,
  snapshotPots,
  valveChangesFromProposals,
  verifyReadback,
  verifyRestore,
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
  it("lets researchers run it, as the command service already allows their bounded pulses", () => {
    expect(evaluatePreflight(facts({ role: "researcher" })).canStart).toBe(true);
  });

  it("explains why one pot cannot be checked, while 100 pots get budgets sized to the selection", () => {
    const one = evaluatePreflight(facts({ pots: pots(1), baselines: [baseline("S1")] }));
    expect(one.canStart).toBe(false);
    expect(one.checks.find((check) => check.id === "selection")?.detail).toBe(singlePotLimitation);
    const all = pots(100);
    const config = configForSelection(100);
    const report = evaluatePreflight(facts({ pots: all, config, baselines: all.map((pot) => baseline(pot.sensorKey)) }));
    expect(report.canStart).toBe(true);
    expect(config.maxTotalValveSeconds).toBe(900);
    expect(config.maxPulses).toBe(200);
    expect(report.worstCaseValveSeconds).toBe(900);
    expect(report.checks.find((check) => check.id === "budget_covers")?.detail).toMatch(/900 valve-seconds/);
    expect(report.estimatedMinutes).toBeGreaterThan(300);
    expect(report.checks.find((check) => check.id === "duration")?.status).toBe("pass");
  });

  it("starts after recent manual watering but says baselines wait for the pots to settle", () => {
    const report = evaluatePreflight(facts({ manualHolds: [{ id: "h1", startedAtMs: now - 600_000, endedAtMs: now - 300_000, label: "pot 7" }] }));
    expect(report.canStart).toBe(true);
    expect(report.checks.find((check) => check.id === "manual_hold")?.detail).toMatch(/after the pots settle/);
  });

  it("passes only when every gate is satisfied, and always discloses the unreadable executor gate", () => {
    const report = evaluatePreflight(facts());
    expect(report.canStart).toBe(true);
    expect(failed(report)).toEqual([]);
    expect(report.checks.find((check) => check.id === "executor_gate")?.status).toBe("warn");
    expect(report.estimatedMinutes).toBeGreaterThan(0);
    expect(report.worstCaseValveSeconds).toBe(12 * (3 + 6));
  });

  it.each([
    ["viewer role", { role: "viewer" }, "role"],
    ["no project role", { role: null }, "role"],
    ["manual watering in progress", { manualHolds: [{ id: "h1", startedAtMs: now - 60_000, endedAtMs: null, label: "solenoid 23" }] }, "manual_hold"],
    ["manual watering records unreadable", { manualHolds: null }, "manual_hold"],
    ["another session holds the controller", { otherActiveSession: { runId: "hw-1", operator: "jake", startedAt: new Date(now - 3_600_000).toISOString() } }, "session"],
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

  it("judges cadence by the latest readings, so pots switched to 60 s by preparation pass minutes later", () => {
    const start = Date.parse("2026-10-21T12:00:00Z");
    // 40 minutes of 10-minute readings, then the preparation switches the pot to 60 s.
    const readings = [0, 600, 1200, 1800, 2400, 2460, 2520, 2580, 2640].map((seconds, index) => ({ sensorKey: "S1", atMs: start + seconds * 1000, vwc: 20 + (index % 2) * 0.05 }));
    expect(summarizeBaseline("S1", readings.slice(0, 6), defaultCommissioningConfig).cadenceSeconds).toBe(600);
    expect(summarizeBaseline("S1", readings, defaultCommissioningConfig).cadenceSeconds).toBe(60);
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
  const pairings = [pairing(1), pairing(2, { wtc_percent_limit: 20, valve_open_time_ms: 2500 }), pairing(3, { wtc_percent_limit: -999999 }), pairing(4, { valve_open_time_ms: 0 })];
  const snapshot = snapshotPots(pairings, pairings.map((item) => item.name));

  it("records exact settings, then disables automatic watering with one command", () => {
    expect(snapshot.map((pot) => [pot.wtcPercentLimit, pot.valveOpenTimeMs, pot.wateringDisabled])).toEqual([[30, 5000, false], [20, 2500, false], [-999999, 5000, true], [30, 0, true]]);
    const plan = buildPreparePlan(snapshot);
    expect(plan.commands).toEqual([expect.objectContaining({
      command_type: "bulk_update_pairings",
      payload: { pairing_names: ["Zone1-Pot1", "Zone1-Pot2", "Zone1-Pot3", "Zone1-Pot4"], disable_watering: true, measurement_interval_seconds: 60 },
    })]);
  });

  it("restores each pot exactly (milliseconds, disabled-by-pulse-length kept) in one command", () => {
    const plan = buildRestorePlan(snapshot);
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].command_type).toBe("restore_pairing_settings");
    expect((plan.commands[0].payload.pairings as unknown[])).toEqual([
      { pairing_name: "Zone1-Pot1", sensor_key: "S1", valve_key: "0x20:1", target_vwc: 30, valve_open_time_ms: 5000, measurement_interval_ms: 600000 },
      { pairing_name: "Zone1-Pot2", sensor_key: "S2", valve_key: "0x20:2", target_vwc: 20, valve_open_time_ms: 2500, measurement_interval_ms: 600000 },
      { pairing_name: "Zone1-Pot3", sensor_key: "S3", valve_key: "0x20:3", target_vwc: null, valve_open_time_ms: 5000, measurement_interval_ms: 600000 },
      // Watering was off only because the pulse length was zero: restored exactly, still off.
      { pairing_name: "Zone1-Pot4", sensor_key: "S4", valve_key: "0x20:4", target_vwc: 30, valve_open_time_ms: 0, measurement_interval_ms: 600000 },
    ]);
  });

  it("restores 100 pots with 100 different original configurations in one command and verifies each", () => {
    const many = Array.from({ length: 100 }, (_, index) => pairing(index + 1, {
      wtc_percent_limit: index % 10 === 0 ? -999999 : 10 + index * 0.5,
      valve_open_time_ms: 1000 + index * 37,
      measurement_interval_ms: 30_000 + index * 6_000,
      group_name: `Group ${index % 7}`,
    }));
    const snap = snapshotPots(many, many.map((item) => item.name));
    const plan = buildRestorePlan(snap);
    const entries = plan.commands[0].payload.pairings as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(100);
    expect(new Set(entries.map((entry) => JSON.stringify([entry.target_vwc, entry.valve_open_time_ms, entry.measurement_interval_ms]))).size).toBe(100);
    expect(JSON.stringify(plan.commands[0].payload).length).toBeLessThan(64_000);
    // Readback after preparation: nothing is restored yet.
    const prepared = many.map((item) => ({ ...item, wtc_percent_limit: -999999, measurement_interval_ms: 60_000 }));
    expect(verifyRestore(snap, prepared).verified).toBe(false);
    expect(verifyRestore(snap, many).verified).toBe(true);
    const oneOff = many.map((item, index) => (index === 57 ? { ...item, valve_open_time_ms: item.valve_open_time_ms + 1 } : item));
    expect(verifyRestore(snap, oneOff).rows.filter((row) => !row.verified).map((row) => row.pairingName)).toEqual(["Zone1-Pot58"]);
  });

  it("keeps unresolved, unverified and externally changed pots sensing-only, unless explicitly released", () => {
    const many = Array.from({ length: 6 }, (_, index) => pairing(index + 1));
    const snap = snapshotPots(many, many.map((item) => item.name));
    const current = many.map((item) => (item.name === "Zone1-Pot6" ? { ...item, wtc_percent_limit: 44 } : { ...item, wtc_percent_limit: -999999, measurement_interval_ms: 60_000 }));
    const scope = planRestoreScope({
      snapshot: snap,
      currentPairings: current,
      unresolved: [{ valveKey: "0x20:2", pairingName: "Zone1-Pot2", reason: "no_response", detail: "No sensor rose" }],
      unclaimed: [{ sensorKey: "S3", pairingName: "Zone1-Pot3", detail: "" }],
      pendingChanges: [],
      unverifiedChanges: [{ pairingName: "Zone1-Pot4", sensorKey: "S4", fromValveKey: "0x20:4", toValveKey: "0x20:5" }],
    });
    expect(scope.restore.map((pot) => pot.pairingName)).toEqual(["Zone1-Pot1", "Zone1-Pot5"]);
    expect(scope.heldBack.map((item) => item.pairingName).sort()).toEqual(["Zone1-Pot2", "Zone1-Pot3", "Zone1-Pot4", "Zone1-Pot6"]);
    expect(scope.heldBack.find((item) => item.pairingName === "Zone1-Pot6")?.reason).toMatch(/changed after preparation/);
    const released = planRestoreScope({ snapshot: snap, currentPairings: current, unresolved: [{ valveKey: "0x20:2", pairingName: "Zone1-Pot2", reason: "no_response", detail: "x" }], unclaimed: [], pendingChanges: [], unverifiedChanges: [], releasedAnyway: new Set(["Zone1-Pot2"]) });
    expect(released.restore.map((pot) => pot.pairingName)).toContain("Zone1-Pot2");
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

  it("applies a swap as ONE atomic remap command that keeps names, groups, settings and calibration", () => {
    const { changes } = valveChangesFromProposals(proposals, snapshot);
    const { plan, problems } = buildRemapPlan(changes, snapshot, "apply", "hw-test-1");
    expect(problems).toEqual([]);
    expect(plan!.commands).toHaveLength(1);
    expect(plan!.commands[0]).toMatchObject({ command_type: "remap_pairing_valves", payload: { remap_id: "hw-test-1", changes: [
      { pairing_name: "Zone1-Pot2", sensor_key: "S2", from_valve_key: "0x20:2", to_valve_key: "0x20:1" },
      { pairing_name: "Zone1-Pot1", sensor_key: "S1", from_valve_key: "0x20:1", to_valve_key: "0x20:2" },
    ] } });
    expect(plan!.commands.some((command) => ["delete_pairing", "create_pairing", "apply_calibration"].includes(command.command_type))).toBe(false);
  });

  it("applies a 100-pot permutation cycle as one command, with an exact one-command rollback", () => {
    const many = Array.from({ length: 100 }, (_, index) => pairing(index + 1, { name: index === 67 ? "Huiqiao-Zone3-Pot68" : `Zone${Math.floor(index / 25) + 1}-Pot${index + 1}` }));
    const snap = snapshotPots(many, many.map((item) => item.name));
    // Valve i waters the pot whose sensor was recorded on valve i+1: one 100-pot cycle.
    const rotated = many.map((item, index) => proposal(item.valve_key, many[(index + 1) % 100].sensor_key, item.sensor_key));
    const { changes, problems } = valveChangesFromProposals(rotated, snap);
    expect(problems).toEqual([]);
    expect(changes).toHaveLength(100);
    const cycles = changeCycles(changes);
    expect(cycles.cycles).toHaveLength(1);
    expect(cycles.cycles[0]).toHaveLength(100);
    expect(cycles.incomplete).toEqual([]);
    const { plan } = buildRemapPlan(changes, snap, "apply", "hw-cycle");
    expect(plan!.commands).toHaveLength(1);
    expect(JSON.stringify(plan!.commands[0].payload).length).toBeLessThan(64_000);
    const rollback = buildRemapPlan(invertChanges(changes), snap, "rollback", "hw-cycle-rollback");
    expect(rollback.plan!.summary).toMatch(/roll back 100/);
    const back = rollback.plan!.commands[0].payload.changes as Array<{ pairing_name: string; to_valve_key: string }>;
    expect(new Map(back.map((change) => [change.pairing_name, change.to_valve_key])).get("Huiqiao-Zone3-Pot68")).toBe("0x20:68");
  });

  it("refuses incomplete chains and an empty change", () => {
    const chain = [
      { pairingName: "Zone1-Pot1", sensorKey: "S1", fromValveKey: "0x20:1", toValveKey: "0x20:2" },
      { pairingName: "Zone1-Pot2", sensorKey: "S2", fromValveKey: "0x20:2", toValveKey: "0x20:3" },
    ];
    expect(buildRemapPlan(chain, snapshot, "apply", "x").problems.join(" ")).toMatch(/do not form complete swaps or cycles/);
    expect(buildRemapPlan([], snapshot, "apply", "x").problems.join(" ")).toMatch(/nothing to change/);
  });

  it("verifies the change only from the controller's re-read configuration, including carried settings", () => {
    const { changes } = valveChangesFromProposals(proposals, snapshot);
    expect(verifyReadback(changes, pairings, snapshot).verified).toBe(false);
    const applied = [pairing(1, { valve_key: "0x20:2" }), pairing(2, { valve_key: "0x20:1" }), pairing(3), pairing(4)];
    const readback = verifyReadback(changes, applied, snapshot);
    expect(readback.verified).toBe(true);
    const partial = verifyReadback(changes, [pairing(1, { valve_key: "0x20:2" }), pairing(2), pairing(3), pairing(4)], snapshot);
    expect(partial.rows.filter((row) => !row.verified).map((row) => row.pairingName)).toEqual(["Zone1-Pot2"]);
    const lostCalibration = verifyReadback(changes, [pairing(1, { valve_key: "0x20:2", calibration_name: null }), pairing(2, { valve_key: "0x20:1" }), pairing(3), pairing(4)], snapshot);
    expect(lostCalibration.rows.find((row) => row.pairingName === "Zone1-Pot1")?.settingsChanged).toEqual(["calibration"]);
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

  it("the session records module writes only autocalibration records, never controller settings", () => {
    const records = readFileSync(join(here, "..", "commissioningRecords.ts"), "utf8");
    expect(records.match(/\.from\(\s*["']([a-z_]+)["']\s*\)\s*\.(insert|update|upsert|delete)/g)?.every((call) => call.includes("commissioning_sessions"))).toBe(true);
    // Session ownership and pot records only; none of these functions touches a controller or its settings.
    expect(records.match(/\.rpc\(\s*["']([a-z_]+)["']/g)).toEqual([
      '.rpc("claim_commissioning_run"',
      '.rpc("renew_commissioning_run"',
      '.rpc("reconcile_autocalibration_bindings"',
      '.rpc("confirm_autocalibration_delivery"',
    ]);
    expect(/functions\.invoke|balena|service_role|SERVICE_ROLE/i.test(records)).toBe(false);
  });

  it("the Autocalibrate screens reach the backend only through the adapters and the reviewed settings queue", () => {
    const directory = join(here, "..", "autocalibrate");
    for (const name of readdirSync(directory).filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))) {
      const source = readFileSync(join(directory, name), "utf8");
      expect(source, name).not.toMatch(/from ["']\.\.\/supabase["']|\.rpc\(|\.from\(["']|functions\.invoke|fetch\(/);
    }
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
