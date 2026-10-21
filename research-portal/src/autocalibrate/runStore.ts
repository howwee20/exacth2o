import { useSyncExternalStore } from "react";
// The engine loads with the first run, so the header's progress banner stays light.
import type { CommissioningRun } from "../commissioning/orchestrator";
import type { CommissioningConfig, CommissioningMode, CommissioningPorts, CommissioningResult, SelectedPot } from "../commissioning/types";
import type { CommissioningSessionRow, CommissioningStore } from "../commissioningRecords";
import { RunLeaseError } from "./runLease";
import { controllerOwnership } from "../controllerOwnership";
import { parseRecord, progressNote, rehearsalSummary, statusAfterRun, withEvent, type SessionRecord, type SessionStatus } from "./sessionRecord";

/**
 * The autocalibration run driven by this browser tab.
 *
 * The run lives here, not in the Settings screen, so it keeps going while the operator
 * looks at other pages of the portal, and the header keeps its progress and Stop button
 * in view. It is still owned by this tab: closing or reloading the tab stops it before
 * its next pulse (a pulse the controller already accepted ends on the controller's own
 * timer). Nothing here claims otherwise.
 *
 * One screen holds a run segment at a time (claim_commissioning_run). This tab renews
 * that hold every heartbeat and again immediately before every valve command, so a tab
 * that slept while another screen resumed the session cannot send another pulse, and a
 * stop requested from another screen takes effect before the next pulse.
 */

export type LiveRunView = {
  projectId: string;
  deviceId: string;
  runId: string;
  mode: CommissioningMode;
  run: CommissioningRun;
  potByValve: Map<string, { pairingName: string; potNumber: number | null }>;
  startedAtMs: number;
  savedAtMs: number | null;
  saveError: string | null;
  leaseError: string | null;
};

export type FinishedRunView = {
  projectId: string;
  deviceId: string;
  runId: string;
  mode: CommissioningMode;
  result: CommissioningResult;
  status: SessionStatus;
  record: SessionRecord;
  saved: boolean;
  saveError: string | null;
  /** Another screen took the session; this tab's result was deliberately not saved over it. */
  lostLease: boolean;
};

type Snapshot = { live: LiveRunView | null; finished: FinishedRunView | null; version: number };

export type RunStoreTiming = { heartbeatMs: number; checkpointMs: number; saveAttempts: number; retryDelayMs: number };
export const defaultRunStoreTiming: RunStoreTiming = { heartbeatMs: 30_000, checkpointMs: 2 * 60_000, saveAttempts: 4, retryDelayMs: 2_000 };

export type StartRunInput = {
  projectId: string;
  deviceId: string;
  session: CommissioningSessionRow;
  store: Pick<CommissioningStore, "claimRun" | "renewRun" | "saveRun">;
  ports: CommissioningPorts;
  mode: CommissioningMode;
  pots: SelectedPot[];
  config: CommissioningConfig;
  confirmation?: string;
  resumeFrom: CommissioningResult | null;
  operator: string | null;
  /** Fixed token for tests; a fresh one otherwise. */
  token?: string;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "now");

export class AutocalRunStore {
  private snapshot: Snapshot = { live: null, finished: null, version: 0 };
  private readonly listeners = new Set<() => void>();
  private retry: (() => Promise<boolean>) | null = null;
  private starting = false;

  constructor(private readonly timing: RunStoreTiming = defaultRunStoreTiming) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private bump(next: Partial<Snapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...next, version: this.snapshot.version + 1 };
    this.listeners.forEach((listener) => listener());
  }

  get running() {
    return this.snapshot.live != null || this.starting;
  }

  /** Stops this tab's run before its next pulse. */
  stop(reason = "Stopped by the operator.") {
    this.snapshot.live?.run.abort(reason);
  }

  /** The project or controller this tab looks at changed: a run for another one stops. */
  stopUnlessFor(projectId: string, deviceId: string | null) {
    const live = this.snapshot.live;
    if (live && (live.projectId !== projectId || live.deviceId !== deviceId)) {
      live.run.abort("The project or controller selected in this tab changed, so the run stopped before its next pulse.");
    }
  }

  clearFinished(runId?: string) {
    if (!this.snapshot.finished || (runId && this.snapshot.finished.runId !== runId)) return;
    this.retry = null;
    this.bump({ finished: null });
  }

  /** Tries again to save a finished run whose final save failed. */
  async retrySave() {
    if (!this.retry) return false;
    return this.retry();
  }

  async start(input: StartRunInput): Promise<FinishedRunView> {
    if (this.snapshot.live || this.starting) throw new Error("An autocalibration run is already in progress in this tab. Stop it first.");
    this.starting = true;
    let claimed: CommissioningSessionRow;
    let Run: typeof CommissioningRun;
    const token = input.token ?? crypto.randomUUID();
    const runId = input.session.run_id;
    try {
      ({ CommissioningRun: Run } = await import("../commissioning/orchestrator"));
      // Take the session for this screen. Refused while another screen's heartbeat is fresh.
      claimed = await input.store.claimRun(runId, token);
    } finally {
      this.starting = false;
    }

    let record = withEvent(
      { ...parseRecord(claimed), mode: input.mode, config: input.config },
      input.operator,
      input.resumeFrom
        ? `Resumed ${input.mode === "real" ? "the real-valve run" : "as a rehearsal"} with ${input.resumeFrom.completedValves.length} of ${input.pots.length} valves already measured. Fresh baselines first.`
        : input.mode === "real" ? `Started a real-valve run on ${input.pots.length} pots.` : `Started a rehearsal on ${input.pots.length} pots (no valve commands).`,
    );

    let lost = false;
    // eslint-disable-next-line prefer-const
    let run: CommissioningRun;
    const holdLease = async () => {
      try {
        const lease = await input.store.renewRun(runId, token);
        if (lease.stop_requested_at) {
          run.abort(`Stopped from another screen at ${clock(lease.stop_requested_at)}.`);
          throw new Error("A stop was requested from another screen.");
        }
      } catch (error) {
        if (error instanceof RunLeaseError && error.lost) {
          lost = true;
          run.abort("Another screen took over this autocalibration session, so this screen stopped before its next pulse.");
        }
        throw error;
      }
    };
    const ports: CommissioningPorts = {
      ...input.ports,
      requestPulse: async (request) => {
        // Confirm this screen still holds the run immediately before every valve command.
        await holdLease();
        return input.ports.requestPulse(request);
      },
    };
    run = new Run({
      runId,
      mode: input.mode,
      pots: input.pots,
      ports,
      config: input.config,
      resumeFrom: input.resumeFrom,
      onUpdate: () => this.bump(),
    });

    const live: LiveRunView = {
      projectId: input.projectId,
      deviceId: input.deviceId,
      runId,
      mode: input.mode,
      run,
      potByValve: new Map(input.pots.map((pot) => [pot.valveKey, { pairingName: pot.pairingName, potNumber: pot.potNumber }])),
      startedAtMs: Date.now(),
      savedAtMs: null,
      saveError: null,
      leaseError: null,
    };
    this.retry = null;
    this.bump({ live, finished: null });

    // Manual troubleshooting in this tab interrupts the run first; the shared Stop stops it.
    const releaseOwnership = controllerOwnership.claimAutocal({
      kind: "autocalibration",
      runId,
      label: `${input.pots.length} pots`,
      interruptForManual: (label) => run.interruptForManualWatering(label),
      stop: () => run.abort(),
    });

    // Saves are serialized so an older checkpoint never lands after a newer one.
    let saving: Promise<unknown> = Promise.resolve();
    const save = (patch: Parameters<StartRunInput["store"]["saveRun"]>[2]) => {
      saving = saving.then(async () => {
        try {
          const row = await input.store.saveRun(runId, token, patch);
          if (!row) {
            lost = true;
            run.abort("Another screen took over this autocalibration session, so this screen stopped before its next pulse.");
            return;
          }
          live.savedAtMs = Date.now();
          live.saveError = null;
        } catch (error) {
          live.saveError = messageOf(error);
        }
        this.bump();
      });
      return saving;
    };
    void save({ record: record as unknown as Record<string, unknown> });

    const progress = (extra: { outcome?: CommissioningResult["outcome"]; stopReason?: string | null } = {}) => {
      const view = run.progress();
      return progressNote({
        segment: view.segment, phase: view.phase, completed: view.completed, total: view.total, pulsesRequested: view.pulsesRequested,
        valveSecondsRequested: view.valveSecondsRequested, activeValveKey: view.activeValveKey, ...extra,
      });
    };
    let checkpointed = -1;
    const checkpoint = () => {
      if (input.mode !== "real" || lost) return;
      const done = run.completedValves().length;
      if (done === checkpointed) return;
      checkpointed = done;
      void save({ record: { ...record, progress: progress() } as unknown as Record<string, unknown>, run_result: run.checkpoint() as unknown as Record<string, unknown> });
    };
    const heartbeat = setInterval(() => {
      void holdLease().then(() => { live.leaseError = null; }, (error) => { live.leaseError = messageOf(error); }).finally(() => this.bump());
    }, this.timing.heartbeatMs);
    const checkpoints = setInterval(checkpoint, this.timing.checkpointMs);

    const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const pageHide = () => {
      run.abort("This screen closed, so the run stopped before its next pulse. Resume it from Settings → Autocalibrate.", "screen_closed");
      checkpointed = -1;
      checkpoint();
    };
    if (hasWindow) {
      window.addEventListener("beforeunload", beforeUnload);
      window.addEventListener("pagehide", pageHide);
    }

    let result: CommissioningResult;
    try {
      result = await run.run({ confirmation: input.confirmation });
    } catch (error) {
      // A run that could not start (wrong confirmation, invalid selection) commanded nothing.
      clearInterval(heartbeat);
      clearInterval(checkpoints);
      if (hasWindow) {
        window.removeEventListener("beforeunload", beforeUnload);
        window.removeEventListener("pagehide", pageHide);
      }
      releaseOwnership();
      await saving.catch(() => undefined);
      await input.store.saveRun(runId, token, { status: input.session.status === "running" ? "interrupted" : input.session.status, heartbeat_at: null, run_token: null }).catch(() => null);
      this.bump({ live: null });
      throw error;
    }
    clearInterval(heartbeat);
    clearInterval(checkpoints);
    if (hasWindow) {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
    }
    releaseOwnership();
    await saving.catch(() => undefined);

    const status = statusAfterRun(result.outcome, input.mode, input.session.status);
    record = withEvent(
      input.mode === "dry_run"
        ? { ...record, rehearsal: rehearsalSummary(result) }
        : { ...record, progress: progress({ outcome: result.outcome, stopReason: result.stopReason }) },
      input.operator,
      `${input.mode === "dry_run" ? "Rehearsal" : "Run"} ended: ${result.outcome.replace(/_/g, " ")}${result.stopReason ? `. ${result.stopReason}` : "."}`,
    );
    const finished: FinishedRunView = {
      projectId: input.projectId,
      deviceId: input.deviceId,
      runId,
      mode: input.mode,
      result,
      status,
      record,
      saved: false,
      saveError: null,
      lostLease: lost,
    };
    const finalSave = async () => {
      if (lost) {
        finished.saveError = "Another screen holds this session, so this screen's result was not saved over it. Download it to keep it.";
        return false;
      }
      for (let attempt = 1; attempt <= this.timing.saveAttempts; attempt += 1) {
        try {
          const row = await input.store.saveRun(runId, token, {
            status,
            record: record as unknown as Record<string, unknown>,
            ...(input.mode === "real" ? { run_result: result as unknown as Record<string, unknown> } : {}),
            heartbeat_at: null,
            run_token: null,
          });
          if (!row) {
            finished.lostLease = true;
            finished.saveError = "Another screen holds this session, so this screen's result was not saved over it. Download it to keep it.";
            return false;
          }
          finished.saved = true;
          finished.saveError = null;
          return true;
        } catch (error) {
          finished.saveError = `The result could not be saved yet: ${messageOf(error)}`;
          if (attempt < this.timing.saveAttempts) await new Promise((resolve) => setTimeout(resolve, this.timing.retryDelayMs * attempt));
        }
      }
      return false;
    };
    await finalSave();
    this.retry = finished.saved || finished.lostLease ? null : async () => {
      const ok = await finalSave();
      if (ok) this.retry = null;
      this.bump({ finished: { ...finished } });
      return ok;
    };
    this.bump({ live: null, finished });
    return finished;
  }
}

export const autocalRunStore = new AutocalRunStore();

export function useAutocalRun() {
  return useSyncExternalStore(autocalRunStore.subscribe, autocalRunStore.getSnapshot, autocalRunStore.getSnapshot);
}
