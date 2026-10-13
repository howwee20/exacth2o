import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  Loader2,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import {
  ExperimentRequestError,
  draftExperiment,
  launchExperiment,
  preflightExperiment,
} from "./experimentClient";
import {
  emptyExperimentDraft,
  experimentDraftFromPortalExperiment,
  manualExperimentDraft,
  type ExperimentControlPlan,
  type ExperimentDraft,
  type ExperimentDraftAssignment,
  type ExperimentDraftSource,
} from "./experimentSpec";
import {
  activeExperimentPotOccupancy,
  type PortalExperiment,
} from "./experimentRegistry";
import {
  normalizeExperimentDraft,
  validateExperimentDraft,
} from "./experimentValidation";
import type { PairingRow } from "./types";
import { assignmentForMode, commonAssignmentValue } from "./experimentSetup";

type BuilderStep = "prompt" | "review" | "complete";
const noPortalExperiments: readonly PortalExperiment[] = [];

type ExperimentBuilderProps = {
  projectId: string;
  pairings: PairingRow[];
  inventoryUpdatedAt: string | null;
  initialPrompt?: string;
  autoGenerate?: boolean;
  direct?: boolean;
  experiment?: PortalExperiment | null;
  template?: PortalExperiment | null;
  experiments?: readonly PortalExperiment[];
  presentation?: "modal" | "inline";
  onClose: () => void;
  onCreated: (slug: string) => void;
};

class ExperimentBuilderErrorBoundary extends Component<{
  children: ReactNode;
  onClose: () => void;
}, {
  failed: boolean;
}> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Experiment editor failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="experiment-builder-backdrop" role="presentation">
        <section
          className="experiment-builder experiment-builder-recovery"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="experiment-builder-recovery-title"
        >
          <AlertTriangle size={24} aria-hidden="true" />
          <h2 id="experiment-builder-recovery-title">This experiment could not be opened</h2>
          <p>The portal kept your experiment unchanged. Close this screen and reload before trying again.</p>
          <button type="button" className="is-primary" onClick={this.props.onClose}>
            Close editor
          </button>
        </section>
      </div>
    );
  }
}

export function ExperimentBuilder(props: ExperimentBuilderProps) {
  return (
    <ExperimentBuilderErrorBoundary onClose={props.onClose}>
      <ExperimentBuilderContent {...props} />
    </ExperimentBuilderErrorBoundary>
  );
}

function optionalValue(value: string) {
  return value.trim() || null;
}

function ExperimentBuilderContent({
  projectId,
  pairings,
  inventoryUpdatedAt,
  initialPrompt = "",
  autoGenerate = false,
  direct = false,
  experiment = null,
  template = null,
  experiments = noPortalExperiments,
  presentation = "modal",
  onClose,
  onCreated,
}: ExperimentBuilderProps) {
  const editing = Boolean(experiment);
  const [step, setStep] = useState<BuilderStep>(direct ? "review" : "prompt");
  const [prompt, setPrompt] = useState(initialPrompt);
  const templateAssignments = useMemo(() => template ? experimentDraftFromPortalExperiment(template, pairings).assignments : [], [template, pairings]);
  const [draft, setDraft] = useState<ExperimentDraft>(() =>
    experiment
      ? experimentDraftFromPortalExperiment(experiment, pairings)
      : template
      ? { ...experimentDraftFromPortalExperiment(template, pairings), name: `${template.name} copy`, start_date: null, assignments: [], questions: [] }
      : direct
      ? manualExperimentDraft(pairings)
      : emptyExperimentDraft()
  );
  const [source, setSource] = useState<ExperimentDraftSource>("manual");
  const [draftInventoryUpdatedAt, setDraftInventoryUpdatedAt] = useState<string | null>(
    inventoryUpdatedAt,
  );
  const [model, setModel] = useState<string | null>(null);
  const [promptFingerprint, setPromptFingerprint] = useState<string | null>(null);
  const [revisionRequest, setRevisionRequest] = useState("");
  const [controlPlan, setControlPlan] = useState<ExperimentControlPlan | null>(null);
  const [reviewedConfigHash, setReviewedConfigHash] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [launchStatus, setLaunchStatus] = useState<"active" | "activating" | "activation_failed" | null>(null);
  const [createdOperationId, setCreatedOperationId] = useState<string | null>(null);
  const [createdCommandCount, setCreatedCommandCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const autoGenerateStarted = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const [potSearch, setPotSearch] = useState("");
  const [showOccupied, setShowOccupied] = useState(false);
  const [attemptedReview, setAttemptedReview] = useState(false);

  useEffect(() => {
    if (presentation !== "modal") return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLInputElement>("input, textarea")?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [presentation]);

  useEffect(() => {
    reviewRef.current?.scrollTo({ top: 0 });
    if (controlPlan) reviewRef.current?.focus();
  }, [controlPlan]);

  const sortedPairings = useMemo(
    () => pairings.slice().sort((left, right) =>
      left.zone - right.zone || left.pot_number - right.pot_number
    ),
    [pairings],
  );
  const validationIssues = useMemo(
    () => validateExperimentDraft(draft, pairings),
    [draft, pairings],
  );
  const selectedNames = useMemo(
    () => new Set(draft.assignments.map((assignment) => assignment.pairing_name)),
    [draft.assignments],
  );
  const occupiedByName = useMemo(
    () => activeExperimentPotOccupancy(
      experiments,
      experiment?.databaseId ?? experiment?.id,
    ),
    [experiment?.databaseId, experiment?.id, experiments],
  );
  const availablePairingCount = useMemo(
    () => sortedPairings.filter((pairing) => !occupiedByName.has(pairing.name)).length,
    [occupiedByName, sortedPairings],
  );
  const visiblePairings = sortedPairings.filter((pairing) =>
    (showOccupied || !occupiedByName.has(pairing.name))
    && `pot ${pairing.pot_number} zone ${pairing.zone} ${pairing.group_name ?? ""}`.toLowerCase().includes(potSearch.trim().toLowerCase())
  );
  const zones = [...new Set(visiblePairings.map((pairing) => pairing.zone))];
  const stepIndex = step === "complete"
    ? 2
    : direct && !controlPlan
    ? 0
    : step === "review"
    ? 1
    : 0;

  const generateDraft = useCallback(async (
    request: string,
    currentDraft?: ExperimentDraft,
  ) => {
    if (!request.trim()) {
      setError("Describe the experiment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await draftExperiment(projectId, request.trim(), currentDraft);
      setDraft(normalizeExperimentDraft(result.draft));
      setSource("natural_language");
      setDraftInventoryUpdatedAt(result.inventory_updated_at);
      setModel(result.model);
      setPromptFingerprint(result.prompt_fingerprint);
      setControlPlan(null);
      setReviewedConfigHash(null);
      setConfirmed(false);
      setRevisionRequest("");
      setStep("review");
      if (result.validation_messages.length) {
        setError(result.validation_messages.join(" "));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the draft.");
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (
      !autoGenerate ||
      autoGenerateStarted.current ||
      !initialPrompt.trim()
    ) return;
    autoGenerateStarted.current = true;
    void generateDraft(initialPrompt);
  }, [autoGenerate, generateDraft, initialPrompt]);

  const beginManualDraft = () => {
    setDraft(manualExperimentDraft(pairings));
    setSource("manual");
    setDraftInventoryUpdatedAt(inventoryUpdatedAt);
    setModel(null);
    setPromptFingerprint(null);
    setError(null);
    setStep("review");
  };

  const updateDraft = <Key extends keyof ExperimentDraft>(
    key: Key,
    value: ExperimentDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setControlPlan(null);
    setReviewedConfigHash(null);
    setConfirmed(false);
  };

  const updateMode = (mode: ExperimentDraft["mode"]) => {
    setDraft((current) => ({
      ...current,
      mode,
      assignments: mode === "observation"
        ? current.assignments.map((assignment) => ({
          ...assignment,
          watering_enabled: false,
          target_vwc_percent: null,
          valve_open_seconds: null,
        }))
        : current.assignments,
    }));
    setControlPlan(null);
    setReviewedConfigHash(null);
    setConfirmed(false);
  };

  const togglePairing = (pairing: PairingRow) => {
    const occupancy = occupiedByName.get(pairing.name);
    if (occupancy?.length) {
      setError(
        `Pot ${pairing.pot_number} is currently used by ${
          occupancy.map((item) => item.experimentName).join(", ")
        }. Remove it from that experiment before selecting it here.`,
      );
      return;
    }
    setControlPlan(null);
    setReviewedConfigHash(null);
    setConfirmed(false);
    setDraft((current) => {
      const exists = current.assignments.some(
        (assignment) => assignment.pairing_name === pairing.name,
      );
      return {
        ...current,
        assignments: exists
          ? current.assignments.filter(
            (assignment) => assignment.pairing_name !== pairing.name,
          )
          : [...current.assignments, assignmentForMode(pairing, current.mode, templateAssignments.length ? templateAssignments[current.assignments.length % templateAssignments.length] : undefined)],
      };
    });
  };

  const updateAssignment = (
    pairingName: string,
    key: keyof ExperimentDraftAssignment,
    value: string | number | boolean | null,
  ) => {
    setControlPlan(null);
    setReviewedConfigHash(null);
    setConfirmed(false);
    setDraft((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) =>
        assignment.pairing_name === pairingName
          ? { ...assignment, [key]: value }
          : assignment
      ),
    }));
  };

  const selectZone = (zone: number) => {
    const eligible = visiblePairings.filter((pairing) => pairing.zone === zone && !occupiedByName.has(pairing.name));
    const remove = eligible.every((pairing) => selectedNames.has(pairing.name));
    const names = new Set(eligible.map((pairing) => pairing.name));
    const assignments = remove
      ? draft.assignments.filter((assignment) => !names.has(assignment.pairing_name))
      : [...draft.assignments, ...eligible.filter((pairing) => !selectedNames.has(pairing.name)).map((pairing, index) =>
        assignmentForMode(pairing, draft.mode, templateAssignments.length ? templateAssignments[(draft.assignments.length + index) % templateAssignments.length] : undefined))];
    updateDraft("assignments", assignments);
  };

  const updateAll = (key: keyof ExperimentDraftAssignment, value: string | number | boolean | null) => {
    updateDraft("assignments", draft.assignments.map((assignment) => ({ ...assignment, [key]: value })));
  };

  const reviewExperiment = async () => {
    if (busy) return;
    setAttemptedReview(true);
    const normalized = normalizeExperimentDraft(draft);
    const issues = validateExperimentDraft(normalized, pairings);
    if (issues.length) {
      setError(issues.map((issue) => issue.message).join(" "));
      return;
    }
    if (!inventoryUpdatedAt) {
      setError("Current pot inventory is unavailable.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await preflightExperiment({
        projectId,
        draft: normalized,
        inventoryUpdatedAt,
        experimentId: experiment?.databaseId,
        expectedRevisionId: experiment?.currentRevisionId,
      });
      setDraft(normalizeExperimentDraft(result.draft));
      setControlPlan(result.plan);
      setReviewedConfigHash(result.config_hash);
      setDraftInventoryUpdatedAt(result.inventory_updated_at);
      setConfirmed(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not review the experiment.");
    } finally {
      setBusy(false);
    }
  };

  const startExperiment = async () => {
    if (busy) return;
    if (!controlPlan || !reviewedConfigHash || !draftInventoryUpdatedAt || !confirmed) {
      setError("Review and confirm the experiment first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await launchExperiment({
        projectId,
        draft: normalizeExperimentDraft(draft),
        inventoryUpdatedAt: draftInventoryUpdatedAt,
        source,
        model,
        promptFingerprint,
        reviewedConfigHash,
        experimentId: experiment?.databaseId,
        expectedRevisionId: experiment?.currentRevisionId,
      });
      setCreatedSlug(result.experiment_slug);
      setLaunchStatus(result.status);
      setCreatedOperationId(result.operation_id);
      setCreatedCommandCount(result.command_ids.length);
      setStep("complete");
    } catch (nextError) {
      if (nextError instanceof ExperimentRequestError && nextError.savedExperimentSlug) {
        setCreatedSlug(nextError.savedExperimentSlug);
        setLaunchStatus("activation_failed");
        setStep("complete");
      }
      setError(
        nextError instanceof Error
          ? nextError.message
          : editing
          ? "Could not save the experiment."
          : "Could not create the experiment.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={presentation === "inline"
        ? "experiment-builder-inline"
        : "experiment-builder-backdrop"}
      role="presentation"
    >
      <section
        className={`experiment-builder ${presentation === "inline" ? "is-inline" : ""} ${direct ? "is-direct" : ""}`}
        role={presentation === "inline" ? "region" : "dialog"}
        aria-modal={presentation === "modal" ? "true" : undefined}
        aria-labelledby="experiment-builder-title"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (presentation !== "modal") return;
          if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
          if (event.key !== "Tab") return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'
          ) ?? []).filter((element) => element.getClientRects().length > 0);
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === reviewRef.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <header className="experiment-builder-header">
          <div>
            <h2 id="experiment-builder-title">
              {editing ? `Edit ${experiment?.name ?? "experiment"}` : template ? "Duplicate experiment" : "New experiment"}
            </h2>
          </div>
          <ol className="experiment-builder-steps" aria-label="Experiment workflow">
            {(direct
              ? ["Set up", "Review", "Done"]
              : ["Describe", "Review", "Create"]).map((label, index) => (
              <li className={index <= stepIndex ? "is-current" : ""} aria-current={index === stepIndex ? "step" : undefined} key={label}>
                <span>{index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={18} />
          </button>
        </header>


        {step === "prompt" ? (
          <div className="experiment-builder-prompt">
            <label htmlFor="experiment-request">Describe the experiment</label>
            <textarea
              id="experiment-request"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={4_000}
              placeholder="Use pots 15–26 for a maize trial. Set half to 30% and keep half sensing only. Measure every 10 minutes."
              autoFocus
            />
            {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
            <div className="experiment-builder-actions">
              <button type="button" className="is-secondary" onClick={beginManualDraft}>
                Enter manually
              </button>
              <button
                type="button"
                className="is-primary"
                onClick={() => void generateDraft(prompt)}
                disabled={busy || !prompt.trim()}
              >
                {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : <Sparkles size={16} />}
                Build specification
              </button>
            </div>
          </div>
        ) : null}

        {step === "review" ? (
          <>
            <div className="experiment-builder-review-shell">
              {!direct ? <aside className="experiment-builder-conversation">
                <div>
                  <p>Request</p>
                  <strong>{prompt || "Manual experiment"}</strong>
                </div>
                <label htmlFor="experiment-revision">Change the draft</label>
                <textarea
                  id="experiment-revision"
                  value={revisionRequest}
                  onChange={(event) => setRevisionRequest(event.target.value)}
                  maxLength={4_000}
                  placeholder="Make pots 15–20 control at 30%. Disable watering for the other pots."
                />
                <button
                  type="button"
                  className="is-secondary"
                  disabled={busy || !revisionRequest.trim()}
                  onClick={() => void generateDraft(revisionRequest, draft)}
                >
                  {busy ? <Loader2 className="chart-loading-spinner" size={15} /> : <Sparkles size={15} />}
                  Update draft
                </button>
                <p className="experiment-builder-conversation-note">
                  ExactH2O validates every setting against the live pot inventory.
                </p>
              </aside> : null}
              <div className="experiment-builder-review" ref={reviewRef} tabIndex={-1}>
              <fieldset className="experiment-builder-editable" disabled={busy}>
              {!controlPlan ? <>
              {template ? <p className="settings-muted">Copied from {template.name}. Choose new pots and check their settings.</p> : null}
              <div className="experiment-builder-fields">
                <label>
                  Experiment name
                  <input
                    autoFocus={direct}
                    placeholder="e.g. Maize drought trial"
                    aria-required="true"
                    value={draft.name}
                    maxLength={120}
                    onChange={(event) => updateDraft("name", event.target.value)}
                  />
                </label>
                <fieldset className="experiment-builder-mode-field">
                  <legend>Experiment type</legend>
                  <div className="experiment-builder-mode-options">
                    {([
                      ["controlled", "Controlled", "Measure and water to a target"],
                      ["observation", "Observation", "Measure with watering off"],
                      ["calibration", "Calibration", "Measure a calibration trial"],
                    ] as const).map(([mode, label, description]) => (
                      <button
                        type="button"
                        className={draft.mode === mode ? `is-selected is-${mode}` : `is-${mode}`}
                        key={mode}
                        aria-pressed={draft.mode === mode}
                        onClick={() => updateMode(mode)}
                      >
                        <strong>{label}</strong>
                        <span>{description}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
              <details className="experiment-builder-details"><summary>Description and start date</summary><div className="experiment-builder-fields">
                <label>
                  Description (optional)
                  <input
                    value={draft.description}
                    maxLength={300}
                    onChange={(event) => updateDraft("description", event.target.value)}
                  />
                </label>
                <label>
                  Record start date (optional)
                  <input
                    type="date"
                    value={draft.start_date?.slice(0, 10) ?? ""}
                    onChange={(event) => updateDraft("start_date", event.target.value || null)}
                  />
                  <small>Leave blank to start today. This date does not schedule controller changes.</small>
                </label>
              </div></details>

              <div className="experiment-builder-pot-section">
                <div className="experiment-builder-section-heading">
                  <h3>Pots</h3>
                  <span aria-live="polite">{draft.assignments.length} selected · {availablePairingCount} available</span>
                </div>
                <div className="experiment-builder-pot-tools">
                  <input type="search" aria-label="Find pots" placeholder="Find a pot or zone" value={potSearch} onChange={(event) => setPotSearch(event.target.value)} />
                  {draft.assignments.length ? <button type="button" onClick={() => updateDraft("assignments", [])}>Clear selection</button> : null}
                  {occupiedByName.size ? <label><input type="checkbox" checked={showOccupied} onChange={(event) => setShowOccupied(event.target.checked)} />Show pots in use ({occupiedByName.size})</label> : null}
                </div>
                {!visiblePairings.length ? <p className="settings-muted">{availablePairingCount ? "No matching pots." : "All pots are in use. Show pots in use to see their experiments."}</p> : null}
                {zones.map((zone) => <div className="experiment-builder-zone" key={zone}>
                  <div className="experiment-builder-section-heading"><h4>Zone {zone}</h4>
                    <button type="button" disabled={!visiblePairings.some((pairing) => pairing.zone === zone && !occupiedByName.has(pairing.name))} onClick={() => selectZone(zone)}>
                      {visiblePairings.filter((pairing) => pairing.zone === zone && !occupiedByName.has(pairing.name)).every((pairing) => selectedNames.has(pairing.name)) ? "Clear zone" : "Select zone"}
                    </button>
                  </div>
                <div className="experiment-builder-pot-grid">
                  {visiblePairings.filter((pairing) => pairing.zone === zone).map((pairing) => {
                    const selected = selectedNames.has(pairing.name);
                    const occupancy = occupiedByName.get(pairing.name) ?? [];
                    const occupied = occupancy.length > 0;
                    const occupiedLabel = occupancy.length === 1
                      ? `In ${occupancy[0].experimentName}`
                      : `In ${occupancy.length} experiments`;
                    return (
                      <button
                        type="button"
                        className={[
                          selected ? "is-selected" : "",
                          occupied ? "is-occupied" : "",
                        ].filter(Boolean).join(" ")}
                        key={pairing.name}
                        onClick={() => togglePairing(pairing)}
                        disabled={occupied}
                        aria-pressed={selected}
                        aria-label={occupied
                          ? `Pot ${pairing.pot_number}, used by ${
                            occupancy.map((item) => item.experimentName).join(", ")
                          }`
                          : `Pot ${pairing.pot_number}, Zone ${pairing.zone}${
                            selected ? ", selected" : ""
                          }`}
                        title={occupied
                          ? `Used by ${occupancy.map((item) => item.experimentName).join(", ")}`
                          : undefined}
                      >
                        <span>Pot {pairing.pot_number}</span>
                        <small>{occupied ? occupiedLabel : `Zone ${pairing.zone}`}</small>
                        {selected ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                </div>
                </div>)}
              </div>

              {draft.assignments.length ? (
                <div className="experiment-builder-assignment-list">
                  <div className="experiment-builder-section-heading"><h3>Settings</h3><span>For all selected pots</span></div>
                  <div className="experiment-builder-bulk">
                    {([ ["crop", "Crop"], ["treatment", "Treatment"] ] as const).map(([key, label]) => <label key={key}>{label}<input value={commonAssignmentValue(draft.assignments, key) ?? ""} placeholder="Optional / mixed" onChange={(event) => updateAll(key, optionalValue(event.target.value))} /></label>)}
                    <label>Watering<select aria-label="Watering for all selected pots" disabled={draft.mode === "observation"} value={String(commonAssignmentValue(draft.assignments, "watering_enabled"))} onChange={(event) => updateAll("watering_enabled", event.target.value === "true")}><option value="" disabled>Mixed</option><option value="false">Off</option><option value="true">On</option></select></label>
                    {([
                      ["target_vwc_percent", "Target (% VWC)", 0, 80, 0.1],
                      ["valve_open_seconds", "Pulse (seconds)", 1, 120, 0.5],
                      ["measurement_interval_minutes", "Measure every (min)", 0.5, 60, 0.5],
                    ] as const).map(([key, label, min, max, increment]) => <label key={key}>{label}<input type="number" min={min} max={max} step={increment} disabled={key !== "measurement_interval_minutes" && !draft.assignments.some((assignment) => assignment.watering_enabled)} value={commonAssignmentValue(draft.assignments, key) ?? ""} placeholder="Mixed" onChange={(event) => updateAll(key, event.target.value === "" ? null : Number(event.target.value))} /></label>)}
                  </div>
                  <details className="experiment-builder-details"><summary>Adjust individual pots ({draft.assignments.length})</summary>
                  {draft.assignments.map((assignment) => (
                    <div className="experiment-builder-assignment" key={assignment.pairing_name}>
                      <strong>{assignment.pairing_name.replace(/^Zone(\d+)-Pot/i, "Z$1 · Pot ")}</strong>
                      <input
                        aria-label={`${assignment.pairing_name} crop`}
                        placeholder="Crop"
                        value={assignment.crop ?? ""}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.pairing_name,
                            "crop",
                            optionalValue(event.target.value),
                          )}
                      />
                      <input
                        aria-label={`${assignment.pairing_name} treatment`}
                        placeholder="Treatment"
                        value={assignment.treatment ?? ""}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.pairing_name,
                            "treatment",
                            optionalValue(event.target.value),
                          )}
                      />
                      <input
                        aria-label={`${assignment.pairing_name} block`}
                        placeholder="Block"
                        value={assignment.block ?? ""}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.pairing_name,
                            "block",
                            optionalValue(event.target.value),
                          )}
                      />
                      <label className="experiment-builder-watering-toggle">
                        <input
                          type="checkbox"
                          checked={assignment.watering_enabled}
                          disabled={draft.mode === "observation"}
                          onChange={(event) =>
                            updateAssignment(
                              assignment.pairing_name,
                              "watering_enabled",
                              event.target.checked,
                            )}
                        />
                        Water
                      </label>
                      <label>
                        Target %
                        <input
                          type="number"
                          min="0"
                          max="80"
                          step="0.1"
                          disabled={!assignment.watering_enabled || draft.mode === "observation"}
                          value={assignment.target_vwc_percent ?? ""}
                          onChange={(event) =>
                            updateAssignment(
                              assignment.pairing_name,
                              "target_vwc_percent",
                              event.target.value === "" ? null : Number(event.target.value),
                            )}
                        />
                      </label>
                      <label>
                        Valve sec
                        <input
                          type="number"
                          min="1"
                          max="120"
                          step="0.5"
                          disabled={!assignment.watering_enabled || draft.mode === "observation"}
                          value={assignment.valve_open_seconds ?? ""}
                          onChange={(event) =>
                            updateAssignment(
                              assignment.pairing_name,
                              "valve_open_seconds",
                              event.target.value === "" ? null : Number(event.target.value),
                            )}
                        />
                      </label>
                      <label>
                        Measure min
                        <input
                          type="number"
                          min="0.5"
                          max="60"
                          step="0.5"
                          value={assignment.measurement_interval_minutes ?? ""}
                          onChange={(event) =>
                            updateAssignment(
                              assignment.pairing_name,
                              "measurement_interval_minutes",
                              event.target.value === "" ? null : Number(event.target.value),
                            )}
                        />
                      </label>
                    </div>
                  ))}
                  </details>
                </div>
              ) : null}
              </> : null}

              {draft.questions.length ? (
                <div className="experiment-builder-questions">
                  {draft.questions.map((question) => <p key={question}>{question}</p>)}
                </div>
              ) : null}
              {controlPlan ? (
                <section className="experiment-builder-preflight">
                  <h3>{draft.name}</h3>
                  <p>{draft.assignments.length} {draft.assignments.length === 1 ? "pot" : "pots"} · {draft.mode === "observation" ? "Observation" : draft.mode === "calibration" ? "Calibration" : "Controlled"}{draft.start_date ? ` · Record starts ${draft.start_date.slice(0, 10)}` : " · Starts today"}</p>
                  <div className="experiment-builder-plan-table"><table><thead><tr><th>Pot</th><th>Crop / treatment</th><th>Watering</th><th>Pulse</th><th>Measure every</th></tr></thead><tbody>{draft.assignments.map((assignment) => <tr key={assignment.pairing_name}><th>{assignment.pairing_name.replace(/^Zone(\d+)-Pot/i, "Z$1 · Pot ")}</th><td>{[assignment.crop, assignment.treatment].filter(Boolean).join(" · ") || "—"}</td><td>{assignment.watering_enabled ? `${assignment.target_vwc_percent}% VWC` : "Off"}</td><td>{assignment.watering_enabled ? `${assignment.valve_open_seconds} s` : "—"}</td><td>{assignment.measurement_interval_minutes} min</td></tr>)}</tbody></table></div>
                  <div>
                    <h3>{editing ? "Ready to save" : "Ready to start"}</h3>
                    <span>
                      {controlPlan.change_count
                        ? `${controlPlan.change_count} pot setting${controlPlan.change_count === 1 ? "" : "s"} will change`
                        : "Current controller settings already match"}
                    </span>
                  </div>
                  {controlPlan.changes.map((change) => (
                    <div className="experiment-builder-change" key={JSON.stringify([
                      change.watering_enabled,
                      change.target_vwc_percent,
                      change.valve_open_seconds,
                      change.measurement_interval_minutes,
                    ])}>
                      <strong>
                        Pots {change.pairing_names
                          .map((name) => name.replace(/^Zone\d+-Pot/, ""))
                          .join(", ")}
                      </strong>
                      <span>
                        {change.watering_enabled
                          ? `${change.target_vwc_percent}% · ${change.valve_open_seconds}s`
                          : "Watering off"}
                        {" · "}
                        every {change.measurement_interval_minutes} min
                      </span>
                    </div>
                  ))}
                  {controlPlan.requires_controller_stop ? (
                    <p>
                      <AlertTriangle size={15} />
                      The controller will pause, apply these settings, then resume. If a step fails, it stays stopped.
                    </p>
                  ) : null}
                  <label className="experiment-builder-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    Apply these settings now.
                  </label>
                </section>
              ) : null}
              {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
              {attemptedReview && !error && validationIssues.length ? (
                <p className="experiment-builder-error" role="alert">
                  {validationIssues.map((issue) => issue.message).join(" ")}
                </p>
              ) : null}
              </fieldset>
              </div>
            </div>

            <footer className="experiment-builder-actions">
              <button
                type="button"
                className="is-secondary"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  if (controlPlan) { setControlPlan(null); setReviewedConfigHash(null); setConfirmed(false); }
                  else if (direct) onClose();
                  else setStep("prompt");
                }}
              >
                <ArrowLeft size={16} />
                {controlPlan ? "Edit setup" : direct ? "Cancel" : "Back"}
              </button>
              {controlPlan ? (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void startExperiment()}
                  disabled={busy || validationIssues.length > 0 || !confirmed}
                >
                  {busy
                    ? <Loader2 className="chart-loading-spinner" size={16} />
                    : <Play size={16} />}
                  {editing ? "Confirm and save" : "Confirm and create"}
                </button>
              ) : (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void reviewExperiment()}
                  disabled={busy || !draft.name.trim() || !draft.assignments.length}
                >
                  {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : null}
                  Review experiment
                </button>
              )}
            </footer>
          </>
        ) : null}

        {step === "complete" ? (
          <div className="experiment-builder-complete">
            <span>{launchStatus === "activation_failed" ? <AlertTriangle size={22} /> : <Check size={22} />}</span>
            <h3>
              {launchStatus === "activation_failed" ? "Experiment saved; changes paused" : launchStatus === "activating"
                ? editing ? "Changes are applying" : "Experiment starting"
                : editing ? "Experiment updated" : "Experiment created"}
            </h3>
            <p>
              {launchStatus === "activation_failed" ? "Open the saved experiment to review its status before retrying." : launchStatus === "activating"
                ? "The reviewed controller steps are running in order. The tile shows the current status."
                : editing ? "Your changes are saved." : `${draft.name} is ready.`}
            </p>
            {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
            {launchStatus !== "activation_failed" ? <details className="experiment-builder-details"><summary>Creation receipt</summary><div className="experiment-builder-proof" aria-label="Creation receipt">
              <article>
                <span>Experiment</span>
                <strong>{editing ? "Updated" : "Created"}</strong>
              </article>
              <article>
                <span>Operation</span>
                <strong>{createdOperationId ? createdOperationId.slice(0, 8) : "Recorded"}</strong>
              </article>
              <article>
                <span>Controller commands</span>
                <strong>
                  {createdCommandCount
                    ? `${createdCommandCount} queued`
                    : "None"}
                </strong>
              </article>
            </div></details> : null}
            <button
              type="button"
              className="is-primary"
              onClick={() => createdSlug && onCreated(createdSlug)}
            >
              View experiment
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
