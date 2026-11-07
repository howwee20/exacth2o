import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { summarizeBaseline } from "../commissioning/analysis";
import { configForSelection, requiredConfirmation, validateConfig } from "../commissioning/orchestrator";
import { evaluatePreflight, type PreflightReport } from "../commissioning/preflight";
import { buildPreparePlan } from "../commissioning/topologyPlan";
import { createSupabasePorts } from "../commissioningSupabasePorts";
import { autocalRunStore } from "./runStore";
import { latestBatch, replaceBatch, withEvent } from "./sessionRecord";
import { preparedState } from "./sessionReview";
import { commandsState } from "./useBatchTracker";
import type { WorkspaceContext } from "./workspaceContext";

/** One explicit confirmation covers preparation and the bounded real-valve run.
 * Consent lives only in this mounted screen; a refresh never starts a run. */
export function QuickRunSetup({ ctx, onAdvanced }: { ctx: WorkspaceContext; onAdvanced: () => void }) {
  const latest = useRef(ctx);
  latest.current = ctx;
  const pending = useRef<AbortController | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowMinutes, setWindowMinutes] = useState("15");
  const [report, setReport] = useState<PreflightReport | null>(null);
  const pots = ctx.record.selection;
  const phrase = requiredConfirmation(pots);
  const previous = ctx.result;
  const resume = previous?.mode === "real" && previous.evidence.length > 0 && !["completed", "completed_with_findings"].includes(previous.outcome) ? previous : null;
  const config = resume && ctx.record.config ? ctx.record.config : configForSelection(pots.length, { maxObserveSeconds: Number(windowMinutes) * 60, retryUnmatched: false });
  const configProblems = validateConfig(config, pots.length);
  const evidenceUnavailable = ctx.resultLoading || Boolean(ctx.resultError)
    || (["interrupted", "failed", "running"].includes(ctx.session.status) && !previous);

  useEffect(() => () => pending.current?.abort(), []);

  const start = async () => {
    if (busy || confirmation !== phrase || ctx.fieldBlockReason || configProblems.length || evidenceUnavailable) return;
    const controller = new AbortController();
    pending.current = controller;
    const assertActive = () => { if (controller.signal.aborted) throw new Error("Setup stopped. No further valve pulse will be requested."); };
    const ports = createSupabasePorts({ projectId: ctx.projectId, deviceId: ctx.deviceId });
    const names = pots.map(pot => pot.pairingName);
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setStatus("Preparing the selected pots…");
      const readback = await ctx.store.readback();
      assertActive();
      // The consent applies only to the exact sensor/valve selection shown.
      if (pots.some(pot => !readback.pairings.some(pairing => pairing.name === pot.pairingName && pairing.sensor_key === pot.sensorKey && pairing.valve_key === pot.valveKey))) {
        throw new Error("The selected connections changed. Review the pots before running again.");
      }
      let batch = latestBatch(latest.current.record, "prepare");
      if (preparedState(names, readback.pairings).notPrepared.length || (batch && batch.commands !== "succeeded")) {
        if (!batch || batch.commands === "failed") {
          batch = await latest.current.queuePlan("prepare", buildPreparePlan(ctx.snapshot), { pairingNames: names }, "preparing");
          if (!batch) throw new Error("The preparation could not be queued. No valve has been pulsed.");
        }
        const deadline = Date.now() + 8 * 60_000;
        for (;;) {
          assertActive();
          const [commands, observed] = await Promise.all([ctx.store.commandStatuses(batch.commandIds), ctx.store.readback()]);
          assertActive();
          const state = commandsState(batch.commandIds, commands);
          const ready = preparedState(names, observed.pairings).notPrepared.length === 0;
          if (state.commands === "failed") throw new Error(state.error ?? "Preparation failed. No valve has been pulsed.");
          if (state.commands === "succeeded" && ready) {
            const verified = { ...batch, ...state, readback: "verified" as const, verifiedAt: new Date().toISOString() };
            const saved = await latest.current.update(record => ({ status: "prepared", record: withEvent(replaceBatch(record, verified), ctx.operator, "Preparation confirmed. Starting automatic safety checks.") }));
            if (!saved) throw new Error("Preparation was confirmed but could not be saved. Run again after the connection recovers.");
            break;
          }
          if (Date.now() >= deadline) throw new Error("Preparation was not confirmed in time. Check the controller before running again.");
          await ports.sleep(4000, controller.signal);
        }
      }

      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        assertActive();
        setStatus("Checking controller, sensors, and valve safeguards…");
        const nowMs = Date.now();
        const [status, queue, automatic, intake, readings, holds, current] = await Promise.all([
          ports.readControllerStatus(), ports.countActiveWateringCommands(), ports.readAutoWateringPairings(names),
          ports.probePulseIntake(), ports.readReadings(pots.map(pot => pot.sensorKey), nowMs - config.baselineLookbackSeconds * 1000),
          ports.readManualInterventions!(nowMs - 2 * config.manualSettleSeconds * 1000),
          ctx.store.readback(),
        ]);
        assertActive();
        if (pots.some(pot => !current.pairings.some(pairing => pairing.name === pot.pairingName && pairing.sensor_key === pot.sensorKey && pairing.valve_key === pot.valveKey))) {
          throw new Error("The selected connections changed during setup. Review the pots before running again.");
        }
        const checked = evaluatePreflight({ mode: "real", role: ctx.role, pots, config, nowMs,
          controller: status, controllerError: null, activeWateringCommands: queue, intake,
          baselines: pots.map(pot => summarizeBaseline(pot.sensorKey, readings, config)),
          autoWateringPairings: automatic, manualHolds: holds, otherActiveSession: null });
        setReport(checked);
        if (checked.canStart) break;
        const blocked = checked.checks.filter(check => check.blocks);
        // Faster readings need time to arrive after preparation. Other failed
        // gates require operator attention, not an unattended eventual start.
        if (blocked.some(check => !["sensors", "cadence"].includes(check.id)) || Date.now() >= deadline) {
          throw new Error("Resolve the checks below, then run again. No valve has been pulsed.");
        }
        setStatus("Waiting for fresh sensor readings. Stop setup cancels this pending run.");
        await ports.sleep(15_000, controller.signal);
      }
      assertActive();
      setStatus("Starting the valve test…");
      await autocalRunStore.start({ projectId: ctx.projectId, deviceId: ctx.deviceId, session: latest.current.session,
        store: ctx.store, ports, mode: "real", pots, config, confirmation, resumeFrom: resume, operator: ctx.operator, signal: controller.signal });
      await latest.current.refresh();
    } catch (next) {
      if (!controller.signal.aborted) setError(next instanceof Error ? next.message : String(next));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) { setBusy(false); setStatus(null); }
    }
  };

  return <section className="settings-card ac-step" aria-labelledby="ac-quick-title">
    <h3 id="ac-quick-title">{resume ? "Resume autocalibration" : "Run autocalibration"}</h3>
    <p>Automatic watering pauses on these {pots.length} pots. Each valve opens by itself for {config.pulseSeconds} seconds, then the sensors are watched for a clear rise. A match removes that valve and sensor from the remaining candidates. Unclear results stay unmatched.</p>
    <p className="settings-muted">At most {config.maxTotalValveSeconds} valve-seconds. Keep this tab open and stay at the testbed. Results are reviewed before connections change.</p>
    <label className="ac-observation-window">
      <span>Wait for sensor response (minutes per valve)</span>
      <input type="number" min="1" max="60" step="1" value={resume ? String(config.maxObserveSeconds / 60) : windowMinutes} disabled={busy || Boolean(resume)} onChange={event => setWindowMinutes(event.target.value)} />
      <span className="settings-muted">The valve closes after {config.pulseSeconds} seconds. We move on as soon as a clear match is measured; otherwise this window ends with the valve unmatched.</span>
    </label>
    {configProblems.map(problem => <p className="settings-error-line" key={problem}>{problem}</p>)}
    {evidenceUnavailable ? <p role="status">Waiting for this session's saved evidence before another run can start.</p> : null}
    <label className="commission-confirm">
      <span>Type <code>{phrase}</code> to confirm preparation and real valve pulses</span>
      <input value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} />
    </label>
    <div className="ac-actions">
      <button type="button" className="settings-danger-button" disabled={busy || confirmation !== phrase || configProblems.length > 0 || evidenceUnavailable || Boolean(ctx.fieldBlockReason) || autocalRunStore.running} onClick={() => void start()}><Play size={14} aria-hidden="true" />{resume ? "Resume" : "Run"}</button>
      {busy ? <button type="button" className="ac-stop" onClick={() => { pending.current?.abort(); setBusy(false); setStatus(null); setConfirmation(""); setError("Setup stopped. Restore the recorded settings before leaving this session."); }}><Square size={14} aria-hidden="true" />Stop setup</button> : null}
    </div>
    {status ? <p role="status">{status}</p> : null}
    {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    {report?.checks.some(check => check.blocks) ? <ul className="commission-checks">{report.checks.filter(check => check.blocks).map(check => <li key={check.id}><div><strong>{check.label}</strong><p>{check.detail}</p></div></li>)}</ul> : null}
    <div className="ac-secondary-actions">
      <button type="button" className="ac-link" disabled={busy} onClick={ctx.showRestore}>Cancel and restore settings</button>
      <button type="button" className="ac-link" disabled={busy} onClick={onAdvanced}>Advanced setup and rehearsal</button>
    </div>
  </section>;
}
