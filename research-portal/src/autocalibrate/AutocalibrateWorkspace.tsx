import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download } from "lucide-react";
import { buildAerialModel } from "../aerialLayout";
import { loadLatestBenchLayout, loadPotBindings, type PotBinding } from "../benchClient";
import type { BenchLayoutDocument } from "../benchLayout";
import { operatorRoles } from "../commissioning/preflight";
import { needsPreparation, snapshotPots } from "../commissioning/topologyPlan";
import type { CommissioningResult } from "../commissioning/types";
import { createCommissioningStore, type CommissioningSessionRow } from "../commissioningRecords";
import { createSupabasePorts } from "../commissioningSupabasePorts";
import type { PortalExperiment } from "../experimentRegistry";
import type { PortalRole } from "../portalAccess";
import type { QueueSettingsPlan } from "../portalTypes";
import { ManualWaterPanel, type ManualWaterTarget } from "../product/ManualWaterPanel";
import { SettingsEmptyState, StatusChip } from "../SettingsChrome";
import type { SettingsPlan } from "../settingsSpec";
import type { PairingRow } from "../types";
import { CheckStep, PrepareStep } from "./PrepareAndCheck";
import { PotDetails } from "./PotDetails";
import { formatWhen, potName } from "./present";
import { RestoreStep } from "./RestorePots";
import { downloadJson, ReviewStep } from "./ReviewResults";
import { RunProgress } from "./RunProgress";
import { autocalRunStore, useAutocalRun } from "./runStore";
import { SelectPots } from "./SelectPots";
import { buildSelectedPots, confirmedReferences, potAvailability, pruneSelection, readingLookbackMs } from "./selection";
import {
  emptyRecord,
  parseRecord,
  parseSnapshot,
  replaceBatch,
  sessionStage,
  withEvent,
  type BatchKind,
  type SessionStatus,
  type TrackedBatch,
  type WorkspaceStage,
} from "./sessionRecord";
import { carryForwardOriginals, heldBackFromEarlier } from "./sessionReview";
import { parseValveKey, type SessionPatch, type WorkspaceContext } from "./workspaceContext";
import "./autocalibrate.css";

export type AutocalibrateWorkspaceProps = {
  projectId: string;
  deviceId: string | null;
  operator: string | null;
  portalRole: PortalRole;
  scope: "installation" | "experiment";
  experiment: PortalExperiment;
  experiments: readonly PortalExperiment[];
  /** Every pairing the controller reports: the aerial view always shows the whole installation. */
  pairings: readonly PairingRow[];
  configHash: string | null;
  controllerState: string | null;
  controllerOnline: boolean;
  controlBusy: boolean;
  onQueueSettingsPlan: QueueSettingsPlan;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const steps: Array<{ stage: WorkspaceStage; label: string }> = [
  { stage: "select", label: "Choose pots" },
  { stage: "prepare", label: "Prepare" },
  { stage: "check", label: "Check and start" },
  { stage: "run", label: "Run" },
  { stage: "review", label: "Review and apply" },
  { stage: "restore", label: "Restore" },
];
const needsEvidence = new Set(["interrupted", "failed", "analyzed", "applying", "applied", "verified", "rolled_back", "restoring", "running", "prepared"]);

/**
 * Settings → Autocalibrate: the one place a researcher starts autocalibration. Works on
 * a direct link: it loads the bench layout, pot records, readings and any open session
 * itself, and every step continues from the server's record of the session.
 */
export function AutocalibrateWorkspace(props: AutocalibrateWorkspaceProps) {
  if (!operatorRoles.has(props.portalRole)) {
    return (
      <SettingsEmptyState title="Operator access required">
        Autocalibrate opens real valves, so it needs project researcher or administrator access.
      </SettingsEmptyState>
    );
  }
  if (!props.deviceId) {
    return <SettingsEmptyState title="Autocalibrate is unavailable">No controller is linked to this project, so there is nothing to calibrate.</SettingsEmptyState>;
  }
  return <Workspace {...props} deviceId={props.deviceId} />;
}

function Workspace(props: AutocalibrateWorkspaceProps & { deviceId: string }) {
  const { projectId, deviceId, pairings, configHash, operator } = props;
  const store = useMemo(() => createCommissioningStore({ projectId, deviceId }), [projectId, deviceId]);
  const readingsPorts = useMemo(() => createSupabasePorts({ projectId, deviceId }), [projectId, deviceId]);
  const runs = useAutocalRun();

  const [session, setSession] = useState<CommissioningSessionRow | null>(null);
  const [recent, setRecent] = useState<CommissioningSessionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [layout, setLayout] = useState<{ layout: BenchLayoutDocument; version: number } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [bindings, setBindings] = useState<PotBinding[]>([]);
  const [lastReadingAt, setLastReadingAt] = useState<Map<string, number> | null>(null);
  const [readingsCheckedAt, setReadingsCheckedAt] = useState<number | null>(null);
  const [checkingReadings, setCheckingReadings] = useState(false);
  const [result, setResult] = useState<{ key: string; value: CommissioningResult | null } | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [references, setReferences] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [inspected, setInspected] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualWaterTarget>(null);
  const [restoreView, setRestoreView] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const sessionRef = useRef<CommissioningSessionRow | null>(null);
  sessionRef.current = session;

  const load = useCallback(async () => {
    try {
      const [active, list] = await Promise.all([store.active(), store.recent(10)]);
      sessionRef.current = active;
      setSession(active);
      setRecent(list);
      setLoadError(null);
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      setLoaded(true);
    }
  }, [store]);

  const loadBench = useCallback(async () => {
    const [nextBindings, nextLayout] = await Promise.allSettled([loadPotBindings(projectId, deviceId), loadLatestBenchLayout(projectId, deviceId)]);
    setBindings(nextBindings.status === "fulfilled" ? nextBindings.value : []);
    if (nextLayout.status === "fulfilled") {
      setLayout(nextLayout.value.latest ? { layout: nextLayout.value.latest.layout, version: nextLayout.value.latest.version } : null);
      setLayoutError(null);
    } else {
      setLayout(null);
      setLayoutError(messageOf(nextLayout.reason));
    }
  }, [projectId, deviceId]);

  const refresh = useCallback(async () => {
    await Promise.all([load(), loadBench()]);
  }, [load, loadBench]);

  const sensorKeys = useMemo(() => Array.from(new Set(pairings.map((pairing) => pairing.sensor_key).filter(Boolean))).sort(), [pairings]);
  const sensorKeyList = sensorKeys.join("|");
  const checkReadings = useCallback(async () => {
    if (!sensorKeys.length) return;
    setCheckingReadings(true);
    try {
      const rows = await readingsPorts.readReadings(sensorKeys, Date.now() - readingLookbackMs(pairings));
      setLastReadingAt((previous) => {
        const next = new Map(previous ?? []);
        for (const row of rows) if ((next.get(row.sensorKey) ?? 0) < row.atMs) next.set(row.sensorKey, row.atMs);
        return next;
      });
      setReadingsCheckedAt(Date.now());
    } catch (error) {
      setNotice(`Recent readings could not be checked: ${messageOf(error)}`);
    } finally {
      setCheckingReadings(false);
    }
  }, [readingsPorts, sensorKeyList]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    void loadBench();
  }, [load, loadBench]);
  useEffect(() => {
    void checkReadings();
    const timer = window.setInterval(() => void checkReadings(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [checkReadings]);
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const live = runs.live && runs.live.projectId === projectId && runs.live.deviceId === deviceId ? runs.live : null;
  const finishedHere = runs.finished && runs.finished.projectId === projectId && runs.finished.deviceId === deviceId ? runs.finished : null;
  const runningHere = Boolean(live && session && live.runId === session.run_id);
  const derived = sessionStage(session, { runningHere, nowMs });
  let stage: WorkspaceStage = derived.stage;
  if (runningHere) stage = "run";
  else if (restoreView && session?.active && stage !== "run") stage = "restore";

  // A run that starts or ends in this tab changes the session on the server.
  useEffect(() => {
    void load();
  }, [live?.runId, finishedHere?.runId, finishedHere?.saved, load]);
  // Another screen's run: follow it.
  useEffect(() => {
    if (!session?.active || runningHere) return undefined;
    const timer = window.setInterval(() => void load(), derived.remoteRun ? 8000 : 30_000);
    return () => window.clearInterval(timer);
  }, [session?.active, runningHere, derived.remoteRun, load]);

  // The evidence matrix, loaded when a step needs it.
  const resultKey = session && session.active && needsEvidence.has(session.status) && !derived.remoteRun ? `${session.run_id}:${session.status}` : null;
  const loadResult = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const key = `${current.run_id}:${current.status}`;
    setResultLoading(true);
    setResultError(null);
    try {
      setResult({ key, value: await store.loadResult(current.run_id) });
    } catch (error) {
      setResultError(messageOf(error));
    } finally {
      setResultLoading(false);
    }
  }, [store]);
  useEffect(() => {
    if (resultKey && result?.key !== resultKey) void loadResult();
  }, [resultKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const runResult = finishedHere && session && finishedHere.runId === session.run_id && finishedHere.mode === "real"
    ? finishedHere.result
    : resultKey && result?.key === resultKey ? result.value : null;

  const byName = useMemo(() => new Map(pairings.map((pairing) => [pairing.name, pairing])), [pairings]);
  const potForSensor = useMemo(() => new Map(pairings.map((pairing) => [pairing.sensor_key, Number.isFinite(pairing.pot_number) ? pairing.pot_number : null])), [pairings]);
  const model = useMemo(() => buildAerialModel(pairings, layout), [pairings, layout]);
  const heldBack = useMemo(() => heldBackFromEarlier(recent, pairings), [recent, pairings]);
  // Readings checked more than ten minutes ago say nothing about the sensors now: a failed
  // or old check shows as "not checked", never as silent sensors.
  const readingsCurrent = readingsCheckedAt != null && nowMs - readingsCheckedAt < 10 * 60_000 ? lastReadingAt : null;
  const availability = useMemo(() => potAvailability({ pairings, lastReadingAt: readingsCurrent, nowMs, heldBack }), [pairings, readingsCurrent, nowMs, heldBack]);
  const confirmedNames = useMemo(() => confirmedReferences(pairings, bindings), [pairings, bindings]);

  // Experiment settings start with that experiment's pots selected.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !loaded || session || !readingsCurrent) return;
    initialized.current = true;
    if (props.scope === "experiment") {
      setSelected(new Set(props.experiment.pairingNames.filter((name) => availability.get(name)?.available === true)));
    }
  }, [loaded, session, readingsCurrent, availability, props.scope, props.experiment.pairingNames]);

  // A configuration change invalidates the selection: pots that vanished are dropped.
  const lastHash = useRef(configHash);
  useEffect(() => {
    if (lastHash.current && configHash && lastHash.current !== configHash && !sessionRef.current) {
      const { selection, removed } = pruneSelection(selected, pairings, availability);
      setSelected(selection);
      setReferences((current) => new Set([...current].filter((name) => selection.has(name))));
      if (removed.length) setNotice(`The controller's configuration changed: ${removed.length} pot(s) that can no longer take part were removed from the selection. Review it before continuing.`);
    }
    lastHash.current = configHash;
  }, [configHash]); // eslint-disable-line react-hooks/exhaustive-deps

  // Saves are serialized and always apply to the latest record.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const update = useCallback((change: (record: ReturnType<typeof parseRecord>) => SessionPatch) => {
    const run = async () => {
      const current = sessionRef.current;
      if (!current) return null;
      try {
        const patch = change(parseRecord(current));
        const row = await store.update(current.run_id, {
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.active != null ? { active: patch.active } : {}),
          ...(patch.record ? { record: patch.record as unknown as Record<string, unknown> } : {}),
        });
        sessionRef.current = row.active ? row : null;
        setSession(row.active ? row : null);
        setActionError(null);
        if (!row.active) {
          setRestoreView(false);
          void load();
        }
        return row;
      } catch (error) {
        setActionError(`Could not save the session: ${messageOf(error)}`);
        return null;
      }
    };
    const next = saving.current.then(run, run);
    saving.current = next.catch(() => undefined);
    return next;
  }, [store, load]);

  const queuePlan = useCallback(async (kind: BatchKind, plan: SettingsPlan, extra: Partial<TrackedBatch> = {}, status?: SessionStatus) => {
    if (!configHash) throw new Error("The controller configuration copy is unavailable, so settings cannot be changed right now.");
    const queued = await props.onQueueSettingsPlan(plan, configHash);
    if (!queued) return null;
    const batch: TrackedBatch = {
      kind, batchId: queued.batchId, commandIds: queued.commandIds, queuedAt: new Date().toISOString(), summary: plan.summary,
      commands: "queued", error: null, readback: "pending", verifiedAt: null, ...extra,
    };
    await update((record) => ({ record: withEvent(replaceBatch(record, batch), operator, `Queued: ${plan.summary}.`), ...(status ? { status } : {}) }));
    return batch;
  }, [configHash, operator, props.onQueueSettingsPlan, update]); // eslint-disable-line react-hooks/exhaustive-deps

  const createSession = async () => {
    setPreparing(true);
    setActionError(null);
    try {
      const pots = buildSelectedPots(pairings, selected, references);
      const names = pots.map((pot) => pot.pairingName);
      const { snapshot, carried } = carryForwardOriginals(snapshotPots(pairings, names), recent);
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const runId = `hw-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
      const needed = pairings.filter((pairing) => selected.has(pairing.name) && needsPreparation(pairing)).length;
      const record = withEvent(
        emptyRecord({
          experimentId: props.scope === "installation" ? "installation" : props.experiment.id,
          experimentName: props.scope === "installation" ? "Installation" : props.experiment.name,
          selection: pots,
          carriedForward: carried,
        }),
        operator,
        `Session opened for ${pots.length} pots. Their settings were recorded before anything changed.`,
      );
      const row = await store.create({
        run_id: runId,
        pot_count: pots.length,
        operator_label: operator,
        original_snapshot: snapshot,
        record: record as unknown as Record<string, unknown>,
        config_hash_at_start: configHash,
        status: needed ? "preparing" : "prepared",
      });
      sessionRef.current = row;
      setSession(row);
      setResult(null);
      setNotice(null);
    } catch (error) {
      setActionError(messageOf(error));
      void load();
    } finally {
      setPreparing(false);
    }
  };

  const selectedUnavailable = [...selected].filter((name) => availability.get(name)?.available === false);
  const blockedReason = selectedUnavailable.length
    ? `${selectedUnavailable.length} selected pot(s) cannot take part right now: ${selectedUnavailable.slice(0, 4).map((name) => potName(byName.get(name)?.pot_number, name)).join(", ")}${selectedUnavailable.length > 4 ? "…" : ""}. Deselect them or fix the reason shown on each.`
    : !configHash ? "The controller configuration copy is unavailable, so the pots cannot be prepared right now." : null;

  const snapshot = session ? parseSnapshot(session) : [];
  const record = session ? parseRecord(session) : null;
  const ctx: WorkspaceContext | null = session && record ? {
    projectId, deviceId, operator, role: props.portalRole, store, pairings, byName, potForSensor, model, bindings,
    configHash, controllerState: props.controllerState, controllerOnline: props.controllerOnline, controlBusy: props.controlBusy,
    session, record, snapshot, result: runResult, resultLoading, resultError, loadResult, refresh, update, queuePlan,
    inspect: setInspected,
    showRestore: () => setRestoreView(true),
    openOutput: (valveKey) => {
      const parsed = parseValveKey(valveKey);
      if (parsed) setManual({ mode: "solenoid", relayAddress: parsed.relayAddress, channel: parsed.channel });
    },
  } : null;

  const stepIndex = Math.max(0, steps.findIndex((item) => item.stage === stage));
  const lastClosed = recent.find((row) => !row.active && row.ended_at && nowMs - Date.parse(row.ended_at) < 6 * 3600_000) ?? null;
  const unsaved = finishedHere && !finishedHere.saved ? finishedHere : null;

  const inspectedPairing = inspected ? byName.get(inspected) ?? null : null;
  const recordedValve = inspected ? snapshot.find((pot) => pot.pairingName === inspected)?.valveKey ?? inspectedPairing?.valve_key ?? "" : "";
  const evidence = live ? live.run.evidenceSoFar() : runResult?.evidence ?? [];

  return (
    <div className="commission ac-workspace">
      <header className="ac-head">
        <div>
          <h2 className="ac-title">Autocalibrate</h2>
          <p className="settings-muted">
            Find which valve waters which pot across the whole installation: each selected valve is pulsed once, one at a time, while every selected sensor is watched.
            Results are reviewed before anything changes, and each pot is restored to its own settings at the end.
          </p>
        </div>
        {session ? <StatusChip tone="info">Session {session.run_id.slice(-8)} · {session.pot_count} pots</StatusChip> : null}
      </header>
      <ol className="ac-stepper" aria-label="Autocalibration steps">
        {steps.map((item, index) => {
          const state = !session && stage !== "closed" ? (index === 0 ? "current" : "upcoming") : index < stepIndex ? "done" : index === stepIndex ? "current" : "upcoming";
          return (
            <li key={item.stage} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="ac-step-dot" aria-hidden="true">{state === "done" ? <Check size={12} /> : index + 1}</span>
              <span>{item.label}</span>
            </li>
          );
        })}
      </ol>

      {!props.controllerOnline ? <p className="ac-notice">The controller is offline or has not reported recently. Selection and review work; changes and runs wait until it reports again.</p> : null}
      {loadError ? <p className="settings-error-line" role="alert">Could not read autocalibration sessions: {loadError} <button type="button" className="ac-link" onClick={() => void load()}>Try again</button></p> : null}
      {layoutError ? <p className="settings-muted">The recorded bench layout could not be read ({layoutError}); pots are drawn in the schematic arrangement.</p> : null}
      {actionError ? <p className="settings-error-line" role="alert">{actionError}</p> : null}
      {unsaved ? (
        <div className="ac-interruption" role="alert">
          <strong>The last run's result is not saved on the server yet</strong>
          <p>{unsaved.saveError}</p>
          <div className="ac-actions">
            {!unsaved.lostLease ? <button type="button" className="settings-secondary-button" onClick={() => void autocalRunStore.retrySave()}>Save again</button> : null}
            <button type="button" className="settings-secondary-button" onClick={() => downloadJson(`exacth2o-autocalibration-${unsaved.runId}-unsaved.json`, { record: unsaved.record, result: unsaved.result })}>
              <Download size={14} aria-hidden="true" /> Download it
            </button>
          </div>
        </div>
      ) : null}

      {!loaded ? <p className="settings-muted">Loading…</p> : !pairings.length ? (
        <SettingsEmptyState title="No pairings reported">The controller has not reported any pairings, so there is nothing to calibrate yet.</SettingsEmptyState>
      ) : !ctx ? (
        <>
          {lastClosed ? <ClosedSummary row={lastClosed} byName={byName} /> : null}
          <SelectPots
            pairings={pairings}
            model={model}
            availability={availability}
            selected={selected}
            onSelected={setSelected}
            references={references}
            onReferences={setReferences}
            experiments={props.experiments}
            confirmedReferenceNames={confirmedNames}
            readingsCheckedAt={readingsCheckedAt}
            checkingReadings={checkingReadings}
            onCheckReadings={() => void checkReadings()}
            onInspect={setInspected}
            onPrepare={() => void createSession()}
            preparing={preparing}
            canPrepare={!blockedReason && !autocalRunStore.running}
            blockedReason={blockedReason}
            error={null}
            notice={notice}
          />
          {recent.length ? <SessionHistory rows={recent} store={store} /> : null}
        </>
      ) : stage === "prepare" ? <PrepareStep ctx={ctx} />
        : stage === "check" ? <CheckStep ctx={ctx} staleRun={derived.staleRun} />
          : stage === "run" ? <RunProgress ctx={ctx} live={runningHere ? live : null} />
            : stage === "review" ? <ReviewStep ctx={ctx} />
              : stage === "restore" ? <RestoreStep ctx={ctx} onBack={restoreView && session?.status !== "restoring" ? () => setRestoreView(false) : null} />
                : null}

      {inspectedPairing ? (
        <PotDetails
          pairing={inspectedPairing}
          onClose={() => setInspected(null)}
          availability={availability.get(inspectedPairing.name)}
          binding={bindings.find((binding) => binding.pairingName === inspectedPairing.name)}
          original={snapshot.find((pot) => pot.pairingName === inspectedPairing.name)}
          evidence={evidence}
          proposal={runResult?.proposals.find((proposal) => proposal.valveKey === recordedValve)}
          intoProposal={runResult?.proposals.find((proposal) => proposal.proposedSensorKey === inspectedPairing.sensor_key)}
          unresolved={runResult?.unresolved.find((item) => item.valveKey === recordedValve)}
          potForSensor={potForSensor}
          onOpenOutput={ctx ? ctx.openOutput : (valveKey) => {
            const parsed = parseValveKey(valveKey);
            if (parsed) setManual({ mode: "solenoid", relayAddress: parsed.relayAddress, channel: parsed.channel });
          }}
          runInProgress={Boolean(live)}
        />
      ) : null}
      <ManualWaterPanel open={manual != null} onClose={() => setManual(null)} projectId={projectId} deviceId={deviceId} controllerName="Controller" initial={manual} />
    </div>
  );
}

function ClosedSummary({ row, byName }: { row: CommissioningSessionRow; byName: ReadonlyMap<string, PairingRow> }) {
  const record = parseRecord(row);
  return (
    <section className="settings-card ac-step is-closed">
      <div className="settings-card-head">
        <h3>Last session · {formatWhen(row.ended_at)}</h3>
        <StatusChip tone={row.status === "restored" ? (record.heldBack.length ? "warning" : "ok") : "info"}>{row.status === "restored" ? "Restored" : row.status.replace(/_/g, " ")}</StatusChip>
      </div>
      <p className="settings-muted">
        {row.pot_count} pots. {record.heldBack.length
          ? `${record.heldBack.length} stayed sensing-only: ${record.heldBack.slice(0, 8).map((item) => potName(byName.get(item.pairingName)?.pot_number, item.pairingName)).join(", ")}${record.heldBack.length > 8 ? "…" : ""}. Their original settings are carried into the next session.`
          : "Every pot is back on its recorded settings."}
      </p>
    </section>
  );
}

function SessionHistory({ rows, store }: { rows: CommissioningSessionRow[]; store: ReturnType<typeof createCommissioningStore> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <details className="settings-card ac-history">
      <summary>Earlier sessions ({rows.length})</summary>
      <ul className="commission-records">
        {rows.map((row) => (
          <li key={row.id}>
            <div>
              <strong>{formatWhen(row.started_at)}</strong>
              <span className="commission-subtle">{row.run_id} · {row.pot_count} pots · {row.operator_label ?? "operator"}</span>
            </div>
            <StatusChip tone={row.active ? "info" : row.status === "restored" ? "ok" : "unknown"}>{row.active ? `Open: ${row.status}` : row.status.replace(/_/g, " ")}</StatusChip>
            <button type="button" className="settings-secondary-button" disabled={busy === row.run_id} onClick={async () => {
              setBusy(row.run_id);
              try {
                const result = await store.loadResult(row.run_id);
                downloadJson(`exacth2o-autocalibration-${row.run_id}.json`, { session: { ...row, run_token: undefined }, record: parseRecord(row), originalSettings: parseSnapshot(row), result });
              } finally {
                setBusy(null);
              }
            }}>
              <Download size={14} aria-hidden="true" /> Record
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
