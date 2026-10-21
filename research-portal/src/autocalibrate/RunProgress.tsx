import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ShieldCheck, Square } from "lucide-react";
import { AerialBench } from "../product/AerialBench";
import { StatusChip } from "../SettingsChrome";
import { formatClock, formatDuration, liveStates, minutesPerValve, potName } from "./present";
import type { LiveRunView } from "./runStore";
import { heartbeatFresh } from "./sessionRecord";
import { EvidenceTable } from "./EvidenceTable";
import { valveLabel, type WorkspaceContext } from "./workspaceContext";

const stepText = {
  settling: "Waiting for every pot to level off",
  pulsing: "Pulsing",
  observing: "Watching every selected sensor",
  cooldown: "Cooling down before the next valve",
} as const;

function elapsed(ms: number) {
  return formatDuration(Math.max(0, ms) / 60_000);
}

/** Step 4: the run in progress, here or on another screen. Stop is always in view. */
export function RunProgress({ ctx, live }: { ctx: WorkspaceContext; live: LiveRunView | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);
  return live ? <LiveRun ctx={ctx} live={live} /> : <RemoteRun ctx={ctx} />;
}

function LiveRun({ ctx, live }: { ctx: WorkspaceContext; live: LiveRunView }) {
  const run = live.run;
  const progress = run.progress();
  const active = progress.activeValveKey ? live.potByValve.get(progress.activeValveKey) ?? null : null;
  const activeName = active ? potName(active.potNumber, active.pairingName) : null;
  const evidence = run.evidenceSoFar();
  const states = useMemo(() => liveStates({
    pots: run.pots,
    evidence,
    completedValves: run.completedValves(),
    activeValveKey: progress.activeValveKey,
    potForSensor: ctx.potForSensor,
  }), [run, evidence, evidence.length, progress.activeValveKey, progress.completed, ctx.potForSensor]); // eslint-disable-line react-hooks/exhaustive-deps
  const segmentMs = Date.now() - live.startedAtMs;
  const perValve = minutesPerValve(run.config);
  const remainingMinutes = progress.remaining * perValve;
  const selected = useMemo(() => new Set(run.pots.map((pot) => pot.pairingName)), [run.pots]);
  const real = live.mode === "real";
  const headline = progress.phase === "baseline"
    ? `Reading baselines: ${progress.usableBaselines} of ${progress.total} sensors usable so far`
    : progress.phase === "discovery"
      ? progress.activeStep && activeName
        ? `${stepText[progress.activeStep]}${progress.activeStep === "pulsing" || progress.activeStep === "observing" ? ` · ${activeName}, valve ${valveLabel(progress.activeValveKey ?? "")}` : ` · next ${activeName}`}`
        : "Moving to the next valve"
      : progress.phase === "analysis" ? "Working out the mapping" : "Starting";

  return (
    <section className="settings-card ac-step ac-run" aria-labelledby="ac-run-title">
      <p className={`commission-real-banner${real ? "" : " is-rehearsal"}`} role="status">
        {real
          ? <><AlertTriangle size={16} aria-hidden="true" /> <strong>Real valves in use.</strong> This tab drives the run. Other pages of the portal are fine; closing or reloading the tab stops it before its next pulse.</>
          : <><ShieldCheck size={16} aria-hidden="true" /> <strong>Rehearsal.</strong> No valve command is sent.</>}
      </p>
      <div className="settings-card-head">
        <h3 id="ac-run-title" aria-live="polite">{headline}</h3>
        <button type="button" className="ac-stop" onClick={() => run.abort("Stopped by the operator.")}>
          <Square size={16} aria-hidden="true" /> Stop now
        </button>
      </div>
      <div className="ac-meter" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} aria-label="Valves measured">
        <span style={{ width: `${progress.total ? (100 * progress.completed) / progress.total : 0}%` }} />
      </div>
      <dl className="ac-stats">
        <div><dt>Measured</dt><dd>{progress.completed} of {progress.total} valves</dd></div>
        <div><dt>Remaining</dt><dd>{progress.remaining}{progress.remaining ? ` · about ${formatDuration(remainingMinutes)}` : ""}</dd></div>
        <div><dt>Pulses</dt><dd>{progress.pulsesRequested} of at most {progress.maxPulses}</dd></div>
        <div><dt>Valve time</dt><dd>{progress.valveSecondsRequested} of {progress.maxTotalValveSeconds} s</dd></div>
        <div><dt>Running for</dt><dd>{elapsed(segmentMs)}{progress.segment > 1 ? ` (segment ${progress.segment})` : ""}</dd></div>
        <div><dt>Saved</dt><dd>{live.saveError ? <span className="settings-error-line">{live.saveError}</span> : live.savedAtMs ? formatClock(live.savedAtMs) : "—"}</dd></div>
      </dl>
      {live.leaseError ? <p className="settings-error-line">Could not renew this screen's hold on the run: {live.leaseError}. No pulse is requested without it.</p> : null}
      <p className="settings-muted">
        Stop prevents every further pulse. A pulse the controller has already accepted ends on the controller's own timer. Starting manual watering
        anywhere on this controller also stops the run; its evidence is kept and the run can be resumed after the pots settle.
      </p>
      <AerialBench model={ctx.model} states={states} selected={selected} selectable={false} onInspect={ctx.inspect} label={`Run progress: ${progress.completed} of ${progress.total} valves measured`} />
      <ul className="ac-legend" aria-label="Legend">
        <li><span className="ac-key is-active" aria-hidden="true" />Being tested now</li>
        <li><span className="ac-key is-matched" aria-hidden="true" />✓ Its valve raised its own sensor</li>
        <li><span className="ac-key is-changed" aria-hidden="true" />↔ Its valve raised another pot</li>
        <li><span className="ac-key is-unresolved" aria-hidden="true" />? Nothing rose</li>
        <li>Readings during a run are preliminary; the mapping is worked out from the complete matrix at the end.</li>
      </ul>
      <details className="ac-evidence">
        <summary>Log ({run.log.length} entries)</summary>
        <ol className="commission-log">
          {run.log.slice(-60).map((entry) => <li key={entry.seq}><time>{formatClock(entry.at)}</time><em>{entry.kind.replace(/_/g, " ")}</em><span>{entry.message}</span></li>)}
        </ol>
      </details>
      <details className="ac-evidence">
        <summary>Evidence so far ({evidence.length} pulses)</summary>
        <EvidenceTable evidence={evidence} potForSensor={ctx.potForSensor} potByValve={live.potByValve} />
      </details>
    </section>
  );
}

function RemoteRun({ ctx }: { ctx: WorkspaceContext }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = ctx.record.progress;
  const fresh = heartbeatFresh(ctx.session, Date.now());
  const requested = ctx.session.stop_requested_at;
  return (
    <section className="settings-card ac-step ac-run" aria-labelledby="ac-remote-title">
      <div className="settings-card-head">
        <h3 id="ac-remote-title">Running on another screen</h3>
        <StatusChip tone={fresh ? "info" : "warning"}>{fresh ? `Heartbeat ${formatClock(ctx.session.heartbeat_at)}` : "Heartbeat stale"}</StatusChip>
      </div>
      <p className="settings-muted">
        {ctx.session.operator_label ? `${ctx.session.operator_label} is running this session` : "Another screen is running this session"} in their browser. Only that screen can pulse valves,
        and only while it keeps renewing its hold. This view refreshes every few seconds.
      </p>
      {progress ? (
        <dl className="ac-stats">
          <div><dt>Measured</dt><dd>{progress.completed} of {progress.total} valves</dd></div>
          <div><dt>Pulses</dt><dd>{progress.pulsesRequested}</dd></div>
          <div><dt>Valve time</dt><dd>{progress.valveSecondsRequested} s</dd></div>
          <div><dt>Last saved</dt><dd>{formatClock(progress.updatedAt)}</dd></div>
        </dl>
      ) : <p className="settings-muted">No progress has been saved yet.</p>}
      {requested ? (
        <p className="ac-notice" role="status">Stop requested at {formatClock(requested)}. The running screen stops before its next pulse (it checks its hold before every pulse and at least every 30 seconds).</p>
      ) : (
        <div className="ac-actions">
          <button type="button" className="ac-stop" disabled={busy} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await ctx.store.requestStop(ctx.session.run_id);
              await ctx.refresh();
            } catch (nextError) {
              setError(nextError instanceof Error ? nextError.message : String(nextError));
            } finally {
              setBusy(false);
            }
          }}>
            <Square size={16} aria-hidden="true" /> Ask that screen to stop
          </button>
        </div>
      )}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    </section>
  );
}
