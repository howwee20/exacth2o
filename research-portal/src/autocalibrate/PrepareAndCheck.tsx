import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { summarizeBaseline } from "../commissioning/analysis";
import { configForSelection, defaultCommissioningConfig, hardLimits, requiredConfirmation, validateConfig } from "../commissioning/orchestrator";
import { evaluatePreflight, type PreflightReport } from "../commissioning/preflight";
import { buildPreparePlan, commissioningIntervalSeconds, isWateringDisabled, needsPreparation, verifyRestore } from "../commissioning/topologyPlan";
import type { CommissioningConfig, CommissioningMode } from "../commissioning/types";
import { createSupabasePorts } from "../commissioningSupabasePorts";
import { StatusChip } from "../SettingsChrome";
import type { PairingRow } from "../types";
import { estimateRun, formatClock, formatDuration, formatWhen, outcomeText } from "./present";
import { autocalRunStore } from "./runStore";
import { latestBatch, replaceBatch, withEvent, type TrackedBatch } from "./sessionRecord";
import { preparedState } from "./sessionReview";
import { BatchStatus } from "./BatchStatus";
import { useBatchTracker } from "./useBatchTracker";
import type { WorkspaceContext } from "./workspaceContext";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Step 2: turn automatic watering off on the selected pots (one reviewed change). */
export function PrepareStep({ ctx }: { ctx: WorkspaceContext }) {
  const names = useMemo(() => ctx.record.selection.map((pot) => pot.pairingName), [ctx.record.selection]);
  const state = preparedState(names, ctx.pairings);
  const batch = latestBatch(ctx.record, "prepare");
  const selected = ctx.pairings.filter((pairing) => names.includes(pairing.name));
  const needing = selected.filter((pairing) => needsPreparation(pairing));
  const automatic = selected.filter((pairing) => !isWateringDisabled(pairing));
  const slow = selected.filter((pairing) => pairing.measurement_interval_ms > commissioningIntervalSeconds * 1000);
  const unchanged = verifyRestore(ctx.snapshot, ctx.pairings).verified;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const evaluate = useCallback((current: PairingRow[]) => (preparedState(names, current).notPrepared.length === 0 ? "verified" : "pending") as TrackedBatch["readback"], [names]);
  const tracker = useBatchTracker({
    store: ctx.store,
    batch,
    evaluate,
    onChange: (next) => void ctx.update((record) => ({
      record: withEvent(replaceBatch(record, next), null, next.readback === "verified"
        ? `Preparation confirmed by controller readback: all ${names.length} pots sensing only, every ${commissioningIntervalSeconds} s.`
        : next.commands === "failed" ? `Preparation did not complete: ${next.error ?? "command failed"}.` : `Preparation: commands ${next.commands}.`),
      ...(next.readback === "verified" ? { status: "prepared" as const } : {}),
    })),
  });

  const queue = async () => {
    setBusy(true);
    setError(null);
    try {
      const queued = await ctx.queuePlan("prepare", buildPreparePlan(ctx.snapshot), { pairingNames: names }, "preparing");
      if (!queued) setError("The change was not queued. See the message at the top of Settings, then try again.");
      setAck(false);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card ac-step" aria-labelledby="ac-prepare-title">
      <div className="settings-card-head">
        <h3 id="ac-prepare-title">Prepare {names.length} pots</h3>
        <StatusChip tone={state.notPrepared.length === 0 ? "ok" : "unknown"}>{state.prepared.length} of {names.length} ready</StatusChip>
      </div>
      <p className="settings-muted">
        The server recorded every selected pot's settings at {formatWhen(ctx.session.started_at)}: target, pulse length and measurement interval, exactly as the
        controller reported them. They are restored, pot by pot, when the session ends.
        {ctx.record.carriedForward.length ? ` ${ctx.record.carriedForward.length} pot(s) were still sensing-only from an earlier run; their original settings were carried forward.` : ""}
      </p>
      {!ctx.controllerOnline ? <p className="ac-notice">The controller is offline. A change queued now waits until it reconnects and confirms it.</p> : null}
      {state.notPrepared.length === 0 && !batch ? (
        <>
          <p className="settings-muted">Every selected pot already has automatic watering off and measures at least every {commissioningIntervalSeconds} s. Nothing needs to change.</p>
          <div className="ac-actions">
            <button type="button" className="settings-primary-button" onClick={() => void ctx.update((record) => ({ status: "prepared", record: withEvent(record, ctx.operator, "All selected pots were already in the commissioning state.") }))}>
              Continue
            </button>
          </div>
        </>
      ) : !batch ? (
        <>
          <p className="settings-muted">
            During the run the controller keeps measuring but must not water these pots on its own. {automatic.length} selected pot(s) still have automatic watering on and{" "}
            {slow.length} measure less often than every {commissioningIntervalSeconds} s. One reviewed settings change turns watering off and measures every {commissioningIntervalSeconds} s on all {names.length};
            other pots on the controller are not touched. Applying it briefly stops and restarts the controller.
          </p>
          <label className="settings-check">
            <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
            <span>I understand these {names.length} pots will not be watered automatically until this session restores them</span>
          </label>
          <div className="ac-actions">
            <button type="button" className="settings-primary-button" disabled={!ack || busy || ctx.controlBusy || !ctx.configHash} onClick={() => void queue()}>
              {busy ? "Queuing…" : `Queue the change: prepare ${needing.length || names.length} pots`}
            </button>
            {!ctx.configHash ? <p className="settings-error-line">The controller configuration copy is unavailable, so settings cannot be changed right now.</p> : null}
          </div>
        </>
      ) : (
        <BatchStatus batch={batch} expired={tracker.expired} onRecheck={() => void tracker.recheck()}
          readbackText={state.notPrepared.length === 0 ? `Controller readback: all ${names.length} pots sensing only.` : `Controller readback: ${state.prepared.length} of ${names.length} pots ready so far.`} />
      )}
      {batch && batch.commands === "failed" && batch.readback !== "verified" ? (
        <div className="ac-actions">
          <button type="button" className="settings-secondary-button" disabled={busy || ctx.controlBusy || !ctx.configHash} onClick={() => void queue()}>Queue the preparation again</button>
        </div>
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
      <div className="ac-secondary-actions">
        {unchanged && !batch ? (
          <button type="button" className="ac-link" onClick={() => void ctx.update((record) => ({ status: "abandoned", active: false, record: withEvent(record, ctx.operator, "Session cancelled before anything was changed.") }))}>
            Cancel this session (nothing has been changed)
          </button>
        ) : (
          <button type="button" className="ac-link" onClick={ctx.showRestore}>Cancel and restore the recorded settings</button>
        )}
      </div>
    </section>
  );
}

type Checked = { report: PreflightReport; at: number; key: string };

/** Step 3: check that it is safe, then start (or resume) the run. */
export function CheckStep({ ctx, staleRun }: { ctx: WorkspaceContext; staleRun: boolean }) {
  const pots = ctx.record.selection;
  const result = ctx.result;
  const resumable = Boolean(result && result.mode === "real" && result.outcome !== "completed" && result.outcome !== "completed_with_findings" && result.evidence.length > 0);
  const lockedConfig = resumable ? ctx.record.config : null;
  const [mode, setMode] = useState<CommissioningMode>(resumable || ctx.record.rehearsal ? "real" : "dry_run");
  const [pulse, setPulse] = useState(String(lockedConfig?.pulseSeconds ?? defaultCommissioningConfig.pulseSeconds));
  const [retry, setRetry] = useState(String(lockedConfig?.escalatedPulseSeconds ?? defaultCommissioningConfig.escalatedPulseSeconds));
  const [checked, setChecked] = useState<Checked | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const config = useMemo<CommissioningConfig>(() => lockedConfig ?? configForSelection(pots.length, {
    pulseSeconds: Number(pulse),
    escalatedPulseSeconds: Number(retry),
  }), [lockedConfig, pots.length, pulse, retry]);
  const configProblems = validateConfig(config, pots.length);
  const key = JSON.stringify([mode, ctx.configHash, ctx.controllerState, config.pulseSeconds, config.escalatedPulseSeconds]);
  const fresh = checked && checked.key === key && Date.now() - checked.at < 5 * 60_000 ? checked : null;
  const phrase = requiredConfirmation(pots);
  const estimate = estimateRun(resumable && result ? pots.length - result.completedValves.length : pots.length, config);

  // A check older than five minutes, or made for other settings, no longer counts.
  useEffect(() => {
    setConfirmation("");
  }, [key]);
  useEffect(() => {
    if (!checked) return undefined;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.max(0, checked.at + 5 * 60_000 - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [checked]);

  const runChecks = async () => {
    setChecking(true);
    setStartError(null);
    // A fresh adapter, so the readings check sees the whole look-back window.
    const ports = createSupabasePorts({ projectId: ctx.projectId, deviceId: ctx.deviceId });
    const nowMs = Date.now();
    const names = pots.map((pot) => pot.pairingName);
    const settle = async <T,>(task: () => Promise<T>): Promise<{ value: T | null; error: string | null }> => {
      try {
        return { value: await task(), error: null };
      } catch (error) {
        return { value: null, error: messageOf(error) };
      }
    };
    const [controller, queue, automatic, intake, readings, holds] = await Promise.all([
      settle(() => ports.readControllerStatus()),
      settle(() => ports.countActiveWateringCommands()),
      settle(() => ports.readAutoWateringPairings(names)),
      settle(() => ports.probePulseIntake()),
      settle(() => ports.readReadings(pots.map((pot) => pot.sensorKey), nowMs - config.baselineLookbackSeconds * 1000)),
      settle(() => ports.readManualInterventions!(nowMs - 2 * config.manualSettleSeconds * 1000)),
    ]);
    const report = evaluatePreflight({
      mode,
      role: ctx.role,
      pots,
      config,
      nowMs,
      controller: controller.value,
      controllerError: controller.error,
      activeWateringCommands: queue.value,
      intake: intake.value ?? (intake.error ? { open: false, detail: intake.error } : null),
      baselines: readings.value ? pots.map((pot) => summarizeBaseline(pot.sensorKey, readings.value ?? [], config)) : [],
      // If the configuration copy cannot be read, fail closed: every selected pot counts as automatic.
      autoWateringPairings: automatic.value ?? names,
      manualHolds: holds.value,
      otherActiveSession: null,
    });
    setChecked({ report, at: nowMs, key });
    setChecking(false);
  };

  const start = () => {
    if (!fresh?.report.canStart) return;
    setStarting(true);
    setStartError(null);
    autocalRunStore.start({
      projectId: ctx.projectId,
      deviceId: ctx.deviceId,
      session: ctx.session,
      store: ctx.store,
      ports: createSupabasePorts({ projectId: ctx.projectId, deviceId: ctx.deviceId }),
      mode,
      pots,
      config,
      confirmation: mode === "real" ? confirmation : undefined,
      resumeFrom: mode === "real" && resumable ? result : null,
      operator: ctx.operator,
    }).then(() => ctx.refresh(), (error) => setStartError(messageOf(error))).finally(() => setStarting(false));
    // The run has claimed the session by the time this screen re-reads it.
    window.setTimeout(() => void ctx.refresh(), 1500);
  };

  const failing = fresh ? fresh.report.checks.filter((check) => check.status !== "pass") : [];
  const passing = fresh ? fresh.report.checks.filter((check) => check.status === "pass") : [];

  return (
    <section className="settings-card ac-step" aria-labelledby="ac-check-title">
      <div className="settings-card-head">
        <h3 id="ac-check-title">{resumable ? "Resume the run" : "Check and start"}</h3>
        <StatusChip tone={fresh?.report.canStart ? "ok" : fresh ? "bad" : "unknown"}>{fresh ? (fresh.report.canStart ? "Ready to start" : "Blocked") : "Not checked"}</StatusChip>
      </div>

      {staleRun ? (
        <p className="ac-notice" role="status">
          The screen running this session stopped renewing its hold{ctx.session.heartbeat_at ? ` at ${formatClock(ctx.session.heartbeat_at)}` : ""}: it closed, slept or lost its connection.
          No pulse is requested without that hold, so nothing more was watered after it. The evidence saved with its last checkpoint is kept.
        </p>
      ) : null}
      {resumable && result ? (
        <div className="ac-interruption">
          <strong>{outcomeText[result.outcome].label}{result.interruption ? ` · ${formatWhen(result.interruption.at)}` : ""}</strong>
          <p>{result.interruption?.reason ?? result.stopReason}</p>
          <p className="settings-muted">
            {result.completedValves.length} of {pots.length} valves have usable evidence and are not pulsed again. Resuming first reads fresh baselines on every selected sensor,
            then tests the remaining {pots.length - result.completedValves.length}. {result.interruption?.source === "manual_watering" ? "After manual watering the run waits until the pots have settled (30 min) before it reads baselines." : ""}
          </p>
        </div>
      ) : null}
      {ctx.record.rehearsal ? (
        <p className="settings-muted">
          Last rehearsal {formatWhen(ctx.record.rehearsal.at)}: {outcomeText[ctx.record.rehearsal.outcome].label.toLowerCase()}; {ctx.record.rehearsal.usableBaselines} of {ctx.record.rehearsal.total} sensors had usable baselines.
          {ctx.record.rehearsal.stopReason ? ` ${ctx.record.rehearsal.stopReason}` : ""}
        </p>
      ) : null}

      <fieldset className="commission-mode ac-mode">
        <legend>What this run does</legend>
        <label>
          <input type="radio" name="ac-mode" checked={mode === "dry_run"} onChange={() => setMode("dry_run")} />
          <span><strong>Rehearsal</strong>Every check and step against the live controller and sensors, with no valve command.</span>
        </label>
        <label>
          <input type="radio" name="ac-mode" checked={mode === "real"} onChange={() => setMode("real")} />
          <span><strong>Open real valves</strong>One bounded pulse at a time through the controller's command queue.</span>
        </label>
      </fieldset>

      <details className="ac-advanced">
        <summary>Pulse lengths{lockedConfig ? " (fixed for this run)" : ""}: {config.pulseSeconds} s, one {config.escalatedPulseSeconds} s retry</summary>
        <div className="settings-field-grid is-two">
          <label>
            Test pulse (seconds, 1–{hardLimits.maxPulseSeconds})
            <input type="number" min={1} max={hardLimits.maxPulseSeconds} value={pulse} disabled={Boolean(lockedConfig)} onChange={(event) => setPulse(event.target.value)} />
          </label>
          <label>
            One retry if nothing rose (seconds, up to {hardLimits.maxEscalatedPulseSeconds})
            <input type="number" min={1} max={hardLimits.maxEscalatedPulseSeconds} value={retry} disabled={Boolean(lockedConfig)} onChange={(event) => setRetry(event.target.value)} />
          </label>
        </div>
        <p className="settings-muted">
          Water budget for this selection: {config.maxTotalValveSeconds} valve-seconds and {config.maxPulses} pulses ({pots.length} valves × one pulse and one retry).
          The run stops itself before any pulse that would exceed it, and after {formatDuration(config.maxRunSeconds / 60)}.
        </p>
        {configProblems.map((problem) => <p key={problem} className="settings-error-line">{problem}</p>)}
      </details>

      <div className="ac-actions">
        <button type="button" className="settings-secondary-button" onClick={() => void runChecks()} disabled={checking || configProblems.length > 0}>
          <RefreshCw size={14} aria-hidden="true" /> {checking ? "Checking…" : fresh ? "Check again" : "Run safety checks"}
        </button>
        {fresh ? <span className="settings-muted">Checked at {formatClock(fresh.at)}; valid for 5 minutes or until anything changes.</span> : null}
      </div>
      {fresh ? (
        <>
          {failing.length ? (
            <ul className="commission-checks">
              {failing.map((check) => (
                <li key={check.id}>
                  <StatusChip tone={check.status === "warn" ? "warning" : "bad"}>{check.status === "warn" ? "Note" : check.blocks ? "Blocked" : "Not met"}</StatusChip>
                  <div><strong>{check.label}</strong><p>{check.detail}</p></div>
                </li>
              ))}
            </ul>
          ) : null}
          <details className="ac-passed">
            <summary>{passing.length} check{passing.length === 1 ? "" : "s"} passed</summary>
            <ul className="commission-checks">
              {passing.map((check) => (
                <li key={check.id}><StatusChip tone="ok">Pass</StatusChip><div><strong>{check.label}</strong><p>{check.detail}</p></div></li>
              ))}
            </ul>
          </details>
        </>
      ) : null}

      <div className={`ac-start${mode === "real" ? " is-real" : ""}`}>
        {mode === "real" ? (
          <>
            <p className="commission-real-banner"><AlertTriangle size={16} aria-hidden="true" /> <strong>Real valves.</strong>
              {" "}Opens {resumable && result ? pots.length - result.completedValves.length : pots.length} valves one at a time for {config.pulseSeconds} s each, about {formatDuration(estimate.typicalMinutes)} in all.
              Stay reachable: you can stop it from any page of the portal, and closing this tab stops it before its next pulse.</p>
            <label className="commission-confirm">
              <span>Type <code>{phrase}</code> to confirm</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={!fresh?.report.canStart} />
            </label>
          </>
        ) : (
          <p className="settings-muted"><ShieldCheck size={14} aria-hidden="true" /> A rehearsal sends no valve command and cannot produce a mapping. It proves the checks, the sensor feed and the timing first.</p>
        )}
        <button type="button" className={mode === "real" ? "settings-danger-button" : "settings-primary-button"}
          disabled={!fresh?.report.canStart || starting || autocalRunStore.running || (mode === "real" && confirmation !== phrase)}
          onClick={start}>
          <Play size={14} aria-hidden="true" /> {starting ? "Starting…" : mode === "real" ? (resumable ? "Resume with real valves" : `Open ${pots.length} real valves, one at a time`) : "Start rehearsal"}
        </button>
        {fresh && !fresh.report.canStart ? <p className="settings-error-line">Resolve the blocked checks above. Nothing falls back to a test mode.</p> : null}
        {autocalRunStore.running ? <p className="settings-error-line">Another run is already in progress in this tab.</p> : null}
        {startError ? <p className="settings-error-line" role="alert">{startError}</p> : null}
      </div>
      <div className="ac-secondary-actions">
        <button type="button" className="ac-link" onClick={ctx.showRestore}>Finish without running: restore the recorded settings</button>
      </div>
    </section>
  );
}
