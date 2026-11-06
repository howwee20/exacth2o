import { afterEach, describe, expect, it } from "vitest";

import { buildWorld } from "../autocal/simulator";
import { configForSelection, requiredConfirmation } from "../commissioning/orchestrator";
import { MockController } from "../commissioning/testing/mockController";
import type { CommissioningSessionRow } from "../commissioningRecords";
import { RunLeaseError } from "./runLease";
import { controllerOwnership } from "../controllerOwnership";
import { AutocalRunStore } from "./runStore";
import { emptyRecord } from "./sessionRecord";

const identity = (count: number) => Array.from({ length: count }, (_, index) => index);

function session(runId = "hw-20261021-store"): CommissioningSessionRow {
  return {
    id: "s1", run_id: runId, status: "prepared", active: true, pot_count: 8, operator_label: null, created_by: "u1",
    original_snapshot: [], record: emptyRecord({ experimentId: "installation", experimentName: "Installation", selection: [] }) as unknown as Record<string, unknown>,
    config_hash_at_start: "h1", heartbeat_at: null, run_token: null, stop_requested_at: null, stop_requested_by: null,
    started_at: "2026-10-21T12:00:00Z", updated_at: "2026-10-21T12:00:00Z", ended_at: null,
  };
}

/** A session table with the server's claim/renew rules, in memory. */
function fakeStore(options: { loseAfterRenewals?: number; stopAfterRenewals?: number; refuseClaim?: boolean; failSaves?: number } = {}) {
  const row = session();
  let renewals = 0;
  let failSaves = options.failSaves ?? 0;
  const saves: Array<Record<string, unknown>> = [];
  return {
    row,
    saves,
    get renewals() { return renewals; },
    claimRun: async (_runId: string, token: string) => {
      if (options.refuseClaim) throw new Error("Another screen is running this autocalibration session");
      row.status = "running";
      row.run_token = token;
      row.heartbeat_at = new Date().toISOString();
      return { ...row };
    },
    renewRun: async (_runId: string, token: string) => {
      renewals += 1;
      if (options.loseAfterRenewals != null && renewals > options.loseAfterRenewals) row.run_token = "someone-else";
      if (row.run_token !== token) throw new RunLeaseError("This screen no longer holds the autocalibration run", true);
      const stop = options.stopAfterRenewals != null && renewals > options.stopAfterRenewals ? "2026-10-21T12:30:00Z" : null;
      return { stop_requested_at: stop, stop_requested_by: stop ? "u2" : null, heartbeat_at: new Date().toISOString() };
    },
    saveRun: async (_runId: string, token: string, patch: Record<string, unknown>) => {
      if (row.run_token !== token) return null;
      if (patch.status && failSaves > 0) {
        failSaves -= 1;
        throw new Error("network down");
      }
      saves.push(patch);
      Object.assign(row, patch);
      return { ...row };
    },
  };
}

function setup(count = 8) {
  const world = buildWorld({ presetId: "clean-100", seed: 7, potCount: count, hoseTargets: identity(count) });
  const controller = new MockController(world, {});
  return { controller, pots: controller.pots() };
}

const fastTiming = { heartbeatMs: 60_000, checkpointMs: 60_000, saveAttempts: 3, retryDelayMs: 1 };

describe("autocalibration run store", () => {
  afterEach(() => controllerOwnership.stopAll());

  it("claims the session, renews before every pulse, and saves the finished run with its status", async () => {
    const { controller, pots } = setup();
    const store = fakeStore();
    const runs = new AutocalRunStore(fastTiming);
    const finished = await runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "real",
      pots, config: configForSelection(pots.length), confirmation: requiredConfirmation(pots), resumeFrom: null, operator: "jake",
    });
    expect(["completed", "completed_with_findings"]).toContain(finished.result.outcome);
    expect(finished.saved).toBe(true);
    expect(finished.status).toBe("analyzed");
    expect(store.renewals).toBeGreaterThanOrEqual(controller.pulseRequests.length);
    const last = store.saves[store.saves.length - 1];
    expect(last).toMatchObject({ status: "analyzed", heartbeat_at: null, run_token: null });
    expect((last.run_result as { proposals: unknown[] }).proposals).toHaveLength(pots.length);
    expect((last.record as { progress: { completed: number } }).progress.completed).toBe(pots.length);
    expect(runs.running).toBe(false);
    expect(controllerOwnership.getSnapshot().autocal).toBeNull();
  }, 60_000);

  it("stops before the next pulse once another screen takes the session, and never saves over it", async () => {
    const { controller, pots } = setup();
    const store = fakeStore({ loseAfterRenewals: 3 });
    const runs = new AutocalRunStore(fastTiming);
    const finished = await runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "real",
      pots, config: configForSelection(pots.length), confirmation: requiredConfirmation(pots), resumeFrom: null, operator: null,
    });
    expect(controller.pulseRequests).toHaveLength(3);
    expect(finished.result.outcome).toBe("aborted");
    expect(finished.result.stopReason).toMatch(/Another screen took over/);
    expect(finished.lostLease).toBe(true);
    expect(finished.saved).toBe(false);
    expect(store.saves.some((patch) => patch.status)).toBe(false);
  }, 60_000);

  it("honours a stop requested from another screen before the next pulse", async () => {
    const { controller, pots } = setup();
    const store = fakeStore({ stopAfterRenewals: 2 });
    const runs = new AutocalRunStore(fastTiming);
    const finished = await runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "real",
      pots, config: configForSelection(pots.length), confirmation: requiredConfirmation(pots), resumeFrom: null, operator: null,
    });
    expect(controller.pulseRequests).toHaveLength(2);
    expect(finished.result.outcome).toBe("aborted");
    expect(finished.result.stopReason).toMatch(/Stopped from another screen/);
    expect(finished.status).toBe("interrupted");
    expect(finished.saved).toBe(true);
  }, 60_000);

  it("manual watering started in this tab interrupts the run through the shared ownership", async () => {
    const { controller, pots } = setup();
    const store = fakeStore();
    const runs = new AutocalRunStore(fastTiming);
    let interrupted: boolean | null = null;
    runs.subscribe(() => {
      // An operator presses Hold to water while the third valve is being worked on.
      if (interrupted == null && (runs.getSnapshot().live?.run.pulsesRequested ?? 0) >= 2) interrupted = controllerOwnership.interruptAutocalForManual("solenoid 12");
    });
    const finished = await runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "real",
      pots, config: configForSelection(pots.length), confirmation: requiredConfirmation(pots), resumeFrom: null, operator: null,
    });
    expect(interrupted).toBe(true);
    expect(controller.pulseRequests.length).toBeLessThanOrEqual(3);
    expect(finished.result.outcome).toBe("interrupted");
    expect(finished.result.interruption?.source).toBe("manual_watering");
    expect(finished.status).toBe("interrupted");
  }, 60_000);

  it("refuses to start while another screen holds the session: nothing is pulsed or claimed", async () => {
    const { controller, pots } = setup();
    const store = fakeStore({ refuseClaim: true });
    const runs = new AutocalRunStore(fastTiming);
    await expect(runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "real",
      pots, config: configForSelection(pots.length), confirmation: requiredConfirmation(pots), resumeFrom: null, operator: null,
    })).rejects.toThrow(/Another screen/);
    expect(controller.pulseRequests).toHaveLength(0);
    expect(controllerOwnership.getSnapshot().autocal).toBeNull();
    expect(runs.running).toBe(false);
  });

  it("keeps a result whose final save failed and saves it on retry", async () => {
    const { controller, pots } = setup();
    const store = fakeStore({ failSaves: 3 });
    const runs = new AutocalRunStore(fastTiming);
    const finished = await runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "real",
      pots, config: configForSelection(pots.length), confirmation: requiredConfirmation(pots), resumeFrom: null, operator: null,
    });
    expect(finished.saved).toBe(false);
    expect(finished.saveError).toMatch(/network down/);
    expect(await runs.retrySave()).toBe(true);
    expect(runs.getSnapshot().finished?.saved).toBe(true);
  }, 60_000);

  it("a rehearsal sends no valve command and leaves the session prepared", async () => {
    const { controller, pots } = setup();
    const store = fakeStore();
    const runs = new AutocalRunStore(fastTiming);
    const finished = await runs.start({
      projectId: "p", deviceId: "d", session: store.row, store, ports: controller.ports(), mode: "dry_run",
      pots, config: configForSelection(pots.length), resumeFrom: null, operator: null,
    });
    expect(controller.pulseRequests).toHaveLength(0);
    expect(finished.status).toBe("prepared");
    expect(finished.record.rehearsal?.outcome).toBe("dry_run_completed");
    expect(store.saves.some((patch) => "run_result" in patch)).toBe(false);
  }, 60_000);
});
