import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Play, RefreshCw, ShieldCheck, Square, Undo2 } from "lucide-react";
import { SettingsEmptyState, StatusChip } from "./SettingsChrome";
import type { StatusTone } from "./settingsPresentation";
import type { SettingsPlan } from "./settingsSpec";
import { summarizeBaseline } from "./commissioning/analysis";
import {
  CommissioningRun,
  defaultCommissioningConfig,
  hardLimits,
  requiredConfirmation,
} from "./commissioning/orchestrator";
import { evaluatePreflight, type PreflightReport } from "./commissioning/preflight";
import {
  browserStorage,
  loadRecords,
  recordFileName,
  saveRecord,
  type CommissioningRecord,
} from "./commissioning/runLog";
import { createSupabasePorts } from "./commissioningSupabasePorts";
import {
  buildPreparePlan,
  buildRestorePlan,
  buildTopologyPlan,
  commissioningIntervalSeconds,
  invertChanges,
  isWateringDisabled,
  snapshotPots,
  valveChangesFromProposals,
  verifyReadback,
  type PotSettingsSnapshot,
  type ValveChange,
} from "./commissioning/topologyPlan";
import type { CommissioningConfig, CommissioningMode, CommissioningResult, RunOutcome, SelectedPot } from "./commissioning/types";
import { confidenceLevel } from "./topology/confidence";
import type { PairingRow } from "./types";
import "./commissioning.css";

// REAL HARDWARE commissioning. Valve pulses go only through the portal's
// authenticated control-command service, and pairing changes go only through the
// existing reviewed settings batch passed in as onQueueSettingsPlan.

type CommissioningProps = {
  projectId: string;
  deviceId: string | null;
  operator: string | null;
  portalRole: string;
  experimentId: string;
  experimentName: string;
  pairings: readonly PairingRow[];
  configHash: string | null;
  controlBusy: boolean;
  onQueueSettingsPlan: (plan: SettingsPlan, configHash: string) => Promise<void>;
};

type Stage = "plan" | "running" | "review";

const outcomeText: Record<RunOutcome, { tone: StatusTone; label: string }> = {
  completed: { tone: "ok", label: "Completed" },
  completed_with_findings: { tone: "warning", label: "Completed with findings" },
  dry_run_completed: { tone: "info", label: "Rehearsal completed (no valve commands sent)" },
  aborted: { tone: "bad", label: "Stopped by the operator" },
  stopped_by_interlock: { tone: "bad", label: "Stopped by a safety interlock" },
  failed: { tone: "bad", label: "Failed" },
};

const faultText: Record<string, string> = {
  no_response: "No response",
  multiple_responses: "Several sensors responded",
  cross_talk: "Cross-talk",
  duplicate_claim: "Sensor claimed by two valves",
  overshoot: "Overshoot",
  low_confidence: "Low confidence",
  not_reached: "Not reached",
  command_failed: "No confirmed pulse",
};

const prepKey = (projectId: string) => `exacth2o.commissioning.prep.v1.${projectId || "default"}`;

function loadPrepSnapshot(projectId: string): PotSettingsSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(browserStorage()?.getItem(prepKey(projectId)) ?? "[]");
    return Array.isArray(parsed) ? parsed as PotSettingsSnapshot[] : [];
  } catch {
    return [];
  }
}

function formatClock(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function Commissioning({
  projectId,
  deviceId,
  operator,
  portalRole,
  experimentId,
  experimentName,
  pairings,
  configHash,
  controlBusy,
  onQueueSettingsPlan,
}: CommissioningProps) {
  const isAdmin = portalRole === "admin";
  const [stage, setStage] = useState<Stage>("plan");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pulseSeconds, setPulseSeconds] = useState(String(defaultCommissioningConfig.pulseSeconds));
  const [escalatedSeconds, setEscalatedSeconds] = useState(String(defaultCommissioningConfig.escalatedPulseSeconds));
  const [budgetSeconds, setBudgetSeconds] = useState(String(defaultCommissioningConfig.maxTotalValveSeconds));
  const [mode, setMode] = useState<CommissioningMode>("dry_run");
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [reportAt, setReportAt] = useState<number | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [prepareConfirmed, setPrepareConfirmed] = useState(false);
  const [prepSnapshot, setPrepSnapshot] = useState<PotSettingsSnapshot[]>(() => loadPrepSnapshot(projectId));
  const [startError, setStartError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [result, setResult] = useState<CommissioningResult | null>(null);
  const [previousTopology, setPreviousTopology] = useState<PotSettingsSnapshot[]>([]);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [applyConfirmation, setApplyConfirmation] = useState("");
  const [submitted, setSubmitted] = useState<{ kind: "apply" | "rollback"; changes: ValveChange[]; at: string } | null>(null);
  const [records, setRecords] = useState<CommissioningRecord[]>(() => loadRecords(browserStorage(), projectId));
  const runRef = useRef<CommissioningRun | null>(null);

  const selectable = useMemo(() => pairings.filter((pairing) => pairing.valve_key && pairing.sensor_key), [pairings]);
  const pots = useMemo<SelectedPot[]>(() => selectable
    .filter((pairing) => selected.has(pairing.name))
    .map((pairing) => ({ pairingName: pairing.name, potNumber: pairing.pot_number, valveKey: pairing.valve_key, sensorKey: pairing.sensor_key })),
  [selectable, selected]);
  const config = useMemo<CommissioningConfig>(() => ({
    ...defaultCommissioningConfig,
    pulseSeconds: Number(pulseSeconds),
    escalatedPulseSeconds: Number(escalatedSeconds),
    maxTotalValveSeconds: Number(budgetSeconds),
  }), [pulseSeconds, escalatedSeconds, budgetSeconds]);
  const autoWatering = selectable.filter((pairing) => selected.has(pairing.name) && !isWateringDisabled(pairing));
  const slowCadence = selectable.filter((pairing) => selected.has(pairing.name) && pairing.measurement_interval_ms > commissioningIntervalSeconds * 1000);
  const ports = useMemo(() => (deviceId ? createSupabasePorts({ projectId, deviceId }) : null), [projectId, deviceId]);

  // Leaving this screen must never leave a run pulsing valves with no Stop button.
  useEffect(() => () => {
    runRef.current?.abort("The commissioning screen was closed, so the run was stopped.");
  }, []);

  // Any change to the plan invalidates the last preflight.
  useEffect(() => {
    setReport(null);
    setReportAt(null);
    setConfirmation("");
  }, [selected, pulseSeconds, escalatedSeconds, budgetSeconds, mode]);

  useEffect(() => {
    if (stage !== "running") return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [stage]);

  const runPreflight = useCallback(async () => {
    if (!ports) return;
    setPreflightBusy(true);
    setStartError(null);
    const nowMs = Date.now();
    const settle = async <T,>(task: () => Promise<T>): Promise<{ value: T | null; error: string | null }> => {
      try {
        return { value: await task(), error: null };
      } catch (error) {
        return { value: null, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const names = pots.map((pot) => pot.pairingName);
    const [controller, queue, automatic, intake, readings] = await Promise.all([
      settle(() => ports.readControllerStatus()),
      settle(() => ports.countActiveWateringCommands()),
      settle(() => ports.readAutoWateringPairings(names)),
      settle(() => ports.probePulseIntake()),
      settle(() => ports.readReadings(pots.map((pot) => pot.sensorKey), nowMs - config.baselineLookbackSeconds * 1000)),
    ]);
    setReport(evaluatePreflight({
      mode,
      role: portalRole,
      pots,
      config,
      nowMs,
      controller: controller.value,
      controllerError: controller.error,
      activeWateringCommands: queue.value,
      intake: intake.value ?? (intake.error ? { open: false, detail: intake.error } : null),
      baselines: readings.value ? pots.map((pot) => summarizeBaseline(pot.sensorKey, readings.value ?? [], config)) : [],
      // If the configuration copy cannot be read, fail closed: treat every selected pot as still automatic.
      autoWateringPairings: automatic.value ?? names,
    }));
    setReportAt(nowMs);
    setPreflightBusy(false);
  }, [ports, pots, config, mode, portalRole]);

  async function startRun() {
    if (!ports || !report?.canStart || !deviceId) return;
    if (reportAt == null || Date.now() - reportAt > 5 * 60_000) {
      setStartError("The preflight is more than 5 minutes old. Run it again.");
      return;
    }
    const snapshot = snapshotPots(pairings, pots.map((pot) => pot.pairingName));
    const run = new CommissioningRun({
      runId: `${mode === "real" ? "hw" : "rehearsal"}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
      mode,
      pots,
      ports,
      config,
      onUpdate: () => setTick((value) => value + 1),
    });
    runRef.current = run;
    setPreviousTopology(snapshot);
    setResult(null);
    setApproved(new Set());
    setSubmitted(null);
    setApplyConfirmation("");
    setStartError(null);
    setStage("running");
    try {
      const finished = await run.run({ confirmation });
      setResult(finished);
      const record: CommissioningRecord = {
        schemaVersion: 1,
        projectId,
        deviceId,
        experimentId,
        experimentName,
        operator,
        previousTopology: snapshot,
        result: finished,
        mappingChanges: [],
        physicalValidation: "pending",
      };
      saveRecord(browserStorage(), record);
      setRecords(loadRecords(browserStorage(), projectId));
      setStage("review");
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
      setStage("plan");
    }
    setConfirmation("");
  }

  async function submitPlan(plan: SettingsPlan, after?: () => void) {
    if (!configHash) return;
    await onQueueSettingsPlan(plan, configHash);
    after?.();
  }

  function recordMappingChange(kind: "apply" | "rollback", changes: ValveChange[]) {
    const at = new Date().toISOString();
    setSubmitted({ kind, changes, at });
    setApplyConfirmation("");
    if (!result || !deviceId) return;
    const existing = loadRecords(browserStorage(), projectId).find((item) => item.result.runId === result.runId);
    if (!existing) return;
    existing.mappingChanges.push({ at, kind, changes, submittedBy: operator, readbackVerifiedAt: null });
    existing.result.log.push({ seq: existing.result.log.length + 1, at, kind: "mapping_change", message: `${kind === "apply" ? "Reviewed mapping changes" : "Rollback"} submitted to the reviewed settings queue.`, data: { changes } });
    saveRecord(browserStorage(), existing);
    setRecords(loadRecords(browserStorage(), projectId));
  }

  if (!isAdmin) {
    return (
      <SettingsEmptyState title="Administrator access required">
        Autocalibrate opens real valves, so it is limited to project administrators.
      </SettingsEmptyState>
    );
  }
  if (!deviceId) {
    return (
      <SettingsEmptyState title="Autocalibrate is unavailable">
        No controller is linked to this project, so there is nothing to commission.
      </SettingsEmptyState>
    );
  }

  const run = runRef.current;
  const expectedConfirmation = requiredConfirmation(pots);
  const selectionCountOk = pots.length >= hardLimits.minPots && pots.length <= hardLimits.maxPots;

  const planStage = (
    <>
      <section className="settings-card">
        <div className="settings-card-head">
          <h3>1. Select pots in {experimentName}</h3>
          <StatusChip tone={selectionCountOk ? "ok" : "unknown"}>{pots.length} selected</StatusChip>
        </div>
        <p className="settings-muted">
          Choose the pots on the bench for this run: 10 to 20 is typical, {hardLimits.minPots} to {hardLimits.maxPots} are allowed.
          Identities come from the controller&apos;s last reported configuration and are read-only here.
        </p>
        {selectable.length === 0 ? (
          <SettingsEmptyState title="No pairings reported">The controller has not reported any pairings for this experiment.</SettingsEmptyState>
        ) : (
          <>
            <div className="commission-select-actions">
              <button type="button" className="settings-secondary-button" onClick={() => setSelected(new Set(selectable.slice(0, hardLimits.maxPots).map((pairing) => pairing.name)))}>
                Select first {Math.min(hardLimits.maxPots, selectable.length)}
              </button>
              <button type="button" className="settings-secondary-button" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
            <div className="settings-table-wrap is-scrollable">
              <table className="settings-table commission-table">
                <thead>
                  <tr>
                    <th scope="col"><span className="settings-visually-hidden">Select</span></th>
                    <th scope="col">Pot</th>
                    <th scope="col">Valve identity</th>
                    <th scope="col">Sensor identity</th>
                    <th scope="col">Automatic watering</th>
                    <th scope="col">Measures</th>
                  </tr>
                </thead>
                <tbody>
                  {selectable.map((pairing) => (
                    <tr key={pairing.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${pairing.name}`}
                          checked={selected.has(pairing.name)}
                          onChange={(event) => setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(pairing.name);
                            else next.delete(pairing.name);
                            return next;
                          })}
                        />
                      </td>
                      <td><b>{pairing.pot_number}</b> <span className="commission-subtle">{pairing.name}</span></td>
                      <td><code className="settings-identity">{pairing.valve_key}</code></td>
                      <td><code className="settings-identity">{pairing.sensor_key}</code></td>
                      <td>{isWateringDisabled(pairing) ? "Disabled" : `Target ${pairing.wtc_percent_limit}%`}</td>
                      <td>Every {Math.round(pairing.measurement_interval_ms / 1000)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <div className="settings-grid">
        <section className="settings-card">
          <h3>2. Limits</h3>
          <div className="settings-form">
            <div className="settings-field-grid is-two">
              <label>
                Diagnostic pulse (sec, max {hardLimits.maxPulseSeconds})
                <input type="number" min="1" max={hardLimits.maxPulseSeconds} step="1" value={pulseSeconds} onChange={(event) => setPulseSeconds(event.target.value)} />
              </label>
              <label>
                One retry pulse (sec, max {hardLimits.maxEscalatedPulseSeconds})
                <input type="number" min="1" max={hardLimits.maxEscalatedPulseSeconds} step="1" value={escalatedSeconds} onChange={(event) => setEscalatedSeconds(event.target.value)} />
              </label>
            </div>
            <label>
              Total water budget (valve-seconds, max {hardLimits.maxTotalValveSeconds})
              <input type="number" min="1" max={hardLimits.maxTotalValveSeconds} step="1" value={budgetSeconds} onChange={(event) => setBudgetSeconds(event.target.value)} />
            </label>
            <p className="settings-muted">
              One valve opens at a time. A valve that moves no sensor gets one retry, then is flagged. The run stops by
              itself before any pulse that would exceed the budget. Worst case for this selection:
              {" "}{pots.length * (Number(pulseSeconds) + Number(escalatedSeconds)) || 0} valve-seconds.
            </p>
          </div>
        </section>

        <section className="settings-card">
          <h3>3. Prepare the pots</h3>
          {pots.length === 0 ? (
            <p className="settings-muted">Select pots first.</p>
          ) : autoWatering.length === 0 && slowCadence.length === 0 ? (
            <p className="settings-muted">Automatic watering is disabled on every selected pot and they measure at least every {commissioningIntervalSeconds}s. Nothing to prepare.</p>
          ) : (
            <>
              <p className="settings-muted">
                The controller must keep running so its sensors report, but it must not water the selected pots on its own
                during the run. {autoWatering.length} selected pot(s) still have an active target and {slowCadence.length} measure
                less often than every {commissioningIntervalSeconds}s.
              </p>
              <p className="settings-muted">
                Preparing sends one reviewed settings change: disable automatic watering and measure every {commissioningIntervalSeconds}s
                on the selected pots. Today&apos;s settings are recorded first so they can be restored afterwards.
              </p>
              <label className="settings-check">
                <input type="checkbox" checked={prepareConfirmed} onChange={(event) => setPrepareConfirmed(event.target.checked)} />
                <span>I understand these {pots.length} pots will not be watered automatically until I restore them</span>
              </label>
              <button
                type="button"
                className="settings-primary-button"
                disabled={!prepareConfirmed || controlBusy || !configHash}
                onClick={() => {
                  const snapshot = snapshotPots(pairings, pots.map((pot) => pot.pairingName));
                  // Keep the first recorded settings for a pot; never overwrite them with its prepared state.
                  const merged = [...prepSnapshot, ...snapshot.filter((pot) => !prepSnapshot.some((item) => item.pairingName === pot.pairingName))];
                  try {
                    browserStorage()?.setItem(prepKey(projectId), JSON.stringify(merged));
                  } catch {
                    // The restore plan is also shown on screen below.
                  }
                  setPrepSnapshot(merged);
                  setPrepareConfirmed(false);
                  void submitPlan(buildPreparePlan(snapshot));
                }}
              >
                Queue reviewed change: prepare {pots.length} pots
              </button>
              {!configHash ? <p className="settings-error-line">The controller configuration copy is unavailable, so settings cannot be changed right now.</p> : null}
            </>
          )}
          {prepSnapshot.length ? (
            <div className="commission-restore">
              <p className="settings-muted">
                Recorded settings for {prepSnapshot.length} prepared pot(s) are saved in this browser.
              </p>
              <button
                type="button"
                className="settings-secondary-button"
                disabled={controlBusy || !configHash}
                onClick={() => void submitPlan(buildRestorePlan(prepSnapshot), () => {
                  try {
                    browserStorage()?.setItem(prepKey(projectId), "[]");
                  } catch {
                    // Nothing else to clear.
                  }
                  setPrepSnapshot([]);
                })}
              >
                <Undo2 size={14} aria-hidden="true" /> Queue reviewed change: restore recorded settings
              </button>
            </div>
          ) : null}
        </section>
      </div>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>4. Preflight</h3>
          <button type="button" className="settings-secondary-button" onClick={() => void runPreflight()} disabled={preflightBusy || pots.length === 0}>
            <RefreshCw size={14} aria-hidden="true" /> {preflightBusy ? "Checking…" : report ? "Run preflight again" : "Run preflight"}
          </button>
        </div>
        <fieldset className="commission-mode">
          <legend>What this run will do</legend>
          <label>
            <input type="radio" name="commission-mode" checked={mode === "dry_run"} onChange={() => setMode("dry_run")} />
            <span><strong>Rehearsal</strong>Runs every check and step against the live controller and sensors, but sends no valve command.</span>
          </label>
          <label>
            <input type="radio" name="commission-mode" checked={mode === "real"} onChange={() => setMode("real")} />
            <span><strong>Open real valves</strong>Sends one bounded pulse at a time through the controller command queue.</span>
          </label>
        </fieldset>
        {!report ? (
          <p className="settings-muted">Nothing has been checked yet. The run cannot start until every blocking check passes.</p>
        ) : (
          <>
            <ul className="commission-checks">
              {report.checks.map((check) => (
                <li key={check.id}>
                  <StatusChip tone={check.status === "pass" ? "ok" : check.status === "warn" ? "warning" : "bad"}>
                    {check.status === "pass" ? "Pass" : check.status === "warn" ? "Note" : check.blocks ? "Blocked" : "Not met"}
                  </StatusChip>
                  <div>
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="settings-muted">
              Checked at {formatClock(reportAt ? new Date(reportAt).toISOString() : null)}.
              {report.canStart && report.estimatedMinutes != null ? ` Estimated duration: about ${report.estimatedMinutes} min.` : ""}
            </p>
          </>
        )}
      </section>

      <section className={`settings-card commission-start${mode === "real" ? " is-real" : ""}`}>
        <h3>5. {mode === "real" ? "Confirm and open real valves" : "Start the rehearsal"}</h3>
        {mode === "real" ? (
          <>
            <p className="commission-real-banner"><AlertTriangle size={16} aria-hidden="true" /> <strong>REAL HARDWARE.</strong> This opens {pots.length} physical valves, one at a time, for {pulseSeconds}s each. Stay at the bench for the whole run.</p>
            <label className="commission-confirm">
              <span>Type <code>{expectedConfirmation}</code> to confirm</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={!report?.canStart} />
            </label>
          </>
        ) : (
          <p className="settings-muted">No valve command is sent in a rehearsal, so it cannot produce a mapping. It proves the checks, the sensor feed, the timing, and the log before you open valves.</p>
        )}
        <button
          type="button"
          className={mode === "real" ? "settings-danger-button" : "settings-primary-button"}
          disabled={!report?.canStart || (mode === "real" && confirmation !== expectedConfirmation)}
          onClick={() => void startRun()}
        >
          <Play size={14} aria-hidden="true" /> {mode === "real" ? `Open ${pots.length} real valves, one at a time` : "Start rehearsal"}
        </button>
        {report && !report.canStart ? <p className="settings-error-line">Unavailable: resolve the blocked checks above. Nothing falls back to a test mode.</p> : null}
        {startError ? <p className="settings-error-line" role="alert">{startError}</p> : null}
      </section>

      <section className="settings-card">
        <h3>Run records</h3>
        {records.length === 0 ? (
          <p className="settings-muted">No commissioning run has been recorded in this browser.</p>
        ) : (
          <ul className="commission-records">
            {records.map((record) => (
              <li key={record.result.runId}>
                <div>
                  <strong>{new Date(record.result.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong>
                  <span className="commission-subtle">{record.result.runId} · {record.result.pots.length} pots · {record.result.pulsesRequested} pulses requested · {record.mappingChanges.length} mapping change(s)</span>
                </div>
                <StatusChip tone={outcomeText[record.result.outcome].tone}>{outcomeText[record.result.outcome].label}</StatusChip>
                <button type="button" className="settings-secondary-button" onClick={() => downloadJson(recordFileName(record), record)}>
                  <Download size={14} aria-hidden="true" /> Log
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );

  const evidenceTable = (run: CommissioningRun | null, finished: CommissioningResult | null) => {
    const evidence = finished?.evidence ?? run?.evidence ?? [];
    if (evidence.length === 0) return <p className="settings-muted">No valve has been reached yet.</p>;
    return (
      <div className="settings-table-wrap is-scrollable">
        <table className="settings-table commission-table">
          <thead>
            <tr>
              <th scope="col">Valve</th>
              <th scope="col">Command requested</th>
              <th scope="col">Controller acknowledged</th>
              <th scope="col">Measured sensor response</th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((item) => {
              const responders = item.responses.filter((response) => response.detected);
              return (
                <tr key={item.step}>
                  <td><code className="settings-identity">{item.valveKey}</code><span className="commission-subtle">{item.pairingName}{item.escalated ? " · retry" : ""}</span></td>
                  <td>{item.acknowledgement.status === "not_sent" && !item.commandId ? <>Not sent<span className="commission-subtle">rehearsal, {item.requestedSeconds}s planned</span></> : <>{item.requestedSeconds}s at {formatClock(item.requestedAt)}<span className="commission-subtle">{item.commandId ?? "awaiting command ID"}</span></>}</td>
                  <td>
                    {item.acknowledgement.status === "not_sent"
                      ? <span className="settings-empty-value">{item.commandId ? "Waiting…" : "—"}</span>
                      : <>{item.acknowledgement.status === "succeeded" ? "Acknowledged" : `Reported ${item.acknowledgement.status}`} at {formatClock(item.acknowledgement.at)}<span className="commission-subtle">{item.acknowledgement.error ?? "Confirms the command only"}</span></>}
                  </td>
                  <td>
                    {responders.length
                      ? responders.map((response) => <span key={response.sensorKey} className="commission-response"><code className="settings-identity">{response.sensorKey}</code> +{response.deltaVwc.toFixed(1)}% VWC</span>)
                      : <span className="settings-empty-value">{item.responses.length ? "No selected sensor rose" : "Waiting for readings"}</span>}
                    <span className="commission-subtle">{item.responses.length} sensors read over {item.observedSeconds}s</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const runningStage = run ? (
    <>
      <p className={`commission-real-banner${run.mode === "real" ? "" : " is-rehearsal"}`} role="status">
        {run.mode === "real"
          ? <><AlertTriangle size={16} aria-hidden="true" /> <strong>REAL HARDWARE RUN IN PROGRESS.</strong> Keep this page open. Closing it stops any further pulses.</>
          : <><ShieldCheck size={16} aria-hidden="true" /> <strong>Rehearsal in progress.</strong> No valve command is being sent.</>}
      </p>
      <section className="settings-card">
        <div className="settings-card-head">
          <h3>{run.phase === "baseline" ? "Reading sensor baselines" : run.phase === "discovery" ? "Pulsing one valve at a time" : "Finishing"}</h3>
          <button type="button" className="commission-stop" onClick={() => run.abort("Stopped by the operator.")}>
            <Square size={14} aria-hidden="true" /> Stop now
          </button>
        </div>
        <div className="settings-rows">
          <div className="settings-row"><span>Active valve</span><strong>{run.activeValveKey ? <code className="settings-identity">{run.activeValveKey}</code> : <span className="settings-empty-value">None</span>}</strong></div>
          <div className="settings-row"><span>Pulses requested</span><strong>{run.pulsesRequested} of {run.config.maxPulses}</strong></div>
          <div className="settings-row"><span>Water budget used</span><strong>{run.valveSecondsRequested} of {run.config.maxTotalValveSeconds} valve-seconds</strong></div>
          <div className="settings-row"><span>Sensors with a usable baseline</span><strong>{run.baselines.filter((item) => item.valid).length} of {run.pots.length}</strong></div>
        </div>
        <p className="settings-muted">Stop prevents every further pulse. A pulse the controller has already accepted still ends on the controller&apos;s own timer.</p>
      </section>
      <section className="settings-card">
        <h3>Evidence</h3>
        {evidenceTable(run, null)}
      </section>
      <section className="settings-card">
        <h3>Log</h3>
        <ol className="commission-log">
          {run.log.slice(-10).map((entry) => <li key={entry.seq}><time>{formatClock(entry.at)}</time><em>{entry.kind.replace("_", " ")}</em><span>{entry.message}</span></li>)}
        </ol>
      </section>
    </>
  ) : null;

  const reviewStage = result ? (() => {
    const outcome = outcomeText[result.outcome];
    const chosen = result.proposals.filter((proposal) => approved.has(proposal.valveKey));
    const { changes, problems: changeProblems } = valveChangesFromProposals(chosen, previousTopology);
    const built = changes.length ? buildTopologyPlan(changes, previousTopology, "apply") : { plan: null, problems: [] as string[] };
    const applyPhrase = `APPLY ${changes.length} VALVE ${changes.length === 1 ? "CHANGE" : "CHANGES"}`;
    const readback = submitted ? verifyReadback(submitted.changes, pairings) : null;
    const rollback = submitted?.kind === "apply" ? buildTopologyPlan(invertChanges(submitted.changes), snapshotPots(pairings, submitted.changes.map((change) => change.pairingName)), "rollback") : null;
    return (
      <>
        <section className="settings-card">
          <div className="settings-card-head">
            <h3>{result.mode === "real" ? "Real hardware run" : "Rehearsal"} · {result.runId}</h3>
            <StatusChip tone={outcome.tone}>{outcome.label}</StatusChip>
          </div>
          {result.stopReason ? <p className="settings-error-line">{result.stopReason}</p> : null}
          <div className="settings-rows">
            <div className="settings-row"><span>Pulses requested</span><strong>{result.pulsesRequested} ({result.valveSecondsRequested} valve-seconds)</strong></div>
            <div className="settings-row"><span>Mappings proposed</span><strong>{result.proposals.length} of {result.pots.length}</strong></div>
            <div className="settings-row"><span>Valves unresolved</span><strong>{result.unresolved.length}</strong></div>
            <div className="settings-row"><span>Active pairings</span><strong>Unchanged by this run</strong></div>
            <div className="settings-row"><span>Physical validation</span><strong><StatusChip tone="warning">Pending</StatusChip></strong></div>
          </div>
          <p className="settings-muted">
            A proposal means a sensor rose after a valve was commanded. It is not proof that water reached the intended pot.
            Confirm each accepted mapping at the bench before relying on it.
          </p>
          <div className="commission-select-actions">
            <button type="button" className="settings-secondary-button" onClick={() => downloadJson(`exacth2o-commissioning-${result.runId}.json`, records.find((record) => record.result.runId === result.runId) ?? result)}>
              <Download size={14} aria-hidden="true" /> Download full log
            </button>
            <button type="button" className="settings-secondary-button" onClick={() => setStage("plan")}>Back to planning</button>
          </div>
        </section>

        {result.proposals.length ? (
          <>
            <div className="settings-section-heading">
              <h3>Proposed mappings</h3>
              <p>Tick the ones you have reviewed. Nothing is applied until you confirm below.</p>
            </div>
            <div className="settings-table-wrap is-scrollable">
              <table className="settings-table commission-table">
                <thead>
                  <tr>
                    <th scope="col">Approve</th>
                    <th scope="col">Valve</th>
                    <th scope="col">Sensor that responded</th>
                    <th scope="col">Recorded today</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Measured</th>
                  </tr>
                </thead>
                <tbody>
                  {result.proposals.map((proposal) => (
                    <tr key={proposal.valveKey} className={proposal.matchesRecord ? "" : "is-different"}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Approve mapping for valve ${proposal.valveKey}`}
                          checked={approved.has(proposal.valveKey)}
                          onChange={(event) => setApproved((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(proposal.valveKey);
                            else next.delete(proposal.valveKey);
                            return next;
                          })}
                        />
                      </td>
                      <td><code className="settings-identity">{proposal.valveKey}</code></td>
                      <td><code className="settings-identity">{proposal.proposedSensorKey}</code></td>
                      <td>{proposal.matchesRecord ? "Same sensor" : <><strong className="commission-different">Different</strong><span className="commission-subtle">recorded <code className="settings-identity">{proposal.recordedSensorKey}</code></span></>}</td>
                      <td>
                        {Math.round(proposal.confidence * 100)}% · {confidenceLevel(proposal.confidence)}
                        <span className="commission-subtle">{proposal.status === "proposed" ? "No findings" : proposal.faults.map((fault) => faultText[fault] ?? fault).join(", ")}</span>
                      </td>
                      <td>+{proposal.deltaVwc.toFixed(1)}% VWC after {proposal.pulseSeconds}s<span className="commission-subtle">{proposal.commandId}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {result.unresolved.length ? (
          <section className="settings-card">
            <h3>Unresolved valves</h3>
            <ul className="commission-plain">
              {result.unresolved.map((item) => (
                <li key={item.valveKey}><code className="settings-identity">{item.valveKey}</code><span><strong>{faultText[item.reason] ?? item.reason}.</strong> {item.detail}</span></li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="settings-card">
          <h3>Evidence</h3>
          {evidenceTable(null, result)}
        </section>

        {result.proposals.length ? (
          <section className="settings-card commission-start is-real">
            <h3>Apply reviewed mappings</h3>
            {changes.length === 0 ? (
              <p className="settings-muted">{chosen.length ? "The approved mappings already match the recorded pairings, so there is nothing to change." : "Approve at least one mapping that differs from the record to build a change."}</p>
            ) : (
              <>
                <p className="settings-muted">
                  A pairing&apos;s valve cannot be edited in place, so each change removes the pairing and recreates it with the same
                  pot, sensor, group, settings, and calibration on the measured valve. It is sent as one reviewed settings batch:
                  the controller is stopped, the configuration must still match what you reviewed, and the controller re-reads
                  its configuration afterwards. The previous topology is kept in the run record for rollback.
                </p>
                <ul className="commission-plain">
                  {(built.plan?.commands ?? []).map((command, index) => <li key={index}><span>{command.effect}</span></li>)}
                </ul>
                {[...changeProblems, ...built.problems].map((problem) => <p className="settings-error-line" key={problem}>{problem}</p>)}
                {built.plan && changeProblems.length === 0 ? (
                  <>
                    <label className="commission-confirm">
                      <span>Type <code>{applyPhrase}</code> to confirm</span>
                      <input value={applyConfirmation} onChange={(event) => setApplyConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
                    </label>
                    <button
                      type="button"
                      className="settings-danger-button"
                      disabled={applyConfirmation !== applyPhrase || controlBusy || !configHash}
                      onClick={() => void submitPlan(built.plan as SettingsPlan, () => recordMappingChange("apply", changes))}
                    >
                      Queue reviewed change: apply {changes.length} valve {changes.length === 1 ? "change" : "changes"}
                    </button>
                  </>
                ) : null}
              </>
            )}
            {submitted && readback ? (
              <div className="commission-readback">
                <div className="settings-card-head">
                  <strong>{submitted.kind === "apply" ? "Change" : "Rollback"} submitted at {formatClock(submitted.at)}</strong>
                  <StatusChip tone={readback.verified ? "ok" : "unknown"}>{readback.verified ? "Verified by controller readback" : "Waiting for controller readback"}</StatusChip>
                </div>
                <ul className="commission-plain">
                  {readback.rows.map((row) => (
                    <li key={row.pairingName}><span>{row.pairingName}: expected valve <code className="settings-identity">{row.expectedValveKey}</code>, controller reports <code className="settings-identity">{row.actualValveKey ?? "nothing yet"}</code> · {row.verified ? "matches" : "not yet"}</span></li>
                  ))}
                </ul>
                <p className="settings-muted">Readback confirms the controller&apos;s configuration, not the plumbing. Physical validation is still pending.</p>
                {submitted.kind === "apply" && rollback?.plan ? (
                  <button type="button" className="settings-secondary-button" disabled={controlBusy || !configHash || !readback.verified} onClick={() => void submitPlan(rollback.plan as SettingsPlan, () => recordMappingChange("rollback", invertChanges(submitted.changes)))}>
                    <Undo2 size={14} aria-hidden="true" /> Queue reviewed change: roll back to the previous topology
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </>
    );
  })() : null;

  return (
    <div className="commission">
      {stage === "plan" ? planStage : stage === "running" ? runningStage : reviewStage}
    </div>
  );
}
