import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  draftExperiment,
  launchExperiment,
  preflightExperiment,
} from "./experimentClient";
import {
  emptyExperimentDraft,
  manualExperimentDraft,
  type ExperimentControlPlan,
  type ExperimentDraft,
  type ExperimentDraftAssignment,
  type ExperimentDraftSource,
} from "./experimentSpec";
import {
  normalizeExperimentDraft,
  validateExperimentDraft,
} from "./experimentValidation";
import type { PairingRow } from "./types";

type BuilderStep = "prompt" | "review" | "complete";

type ExperimentBuilderProps = {
  projectId: string;
  pairings: PairingRow[];
  inventoryUpdatedAt: string | null;
  initialPrompt?: string;
  autoGenerate?: boolean;
  presentation?: "modal" | "inline";
  onClose: () => void;
  onCreated: (slug: string) => void;
};

function assignmentForPairing(pairing: PairingRow): ExperimentDraftAssignment {
  return {
    pairing_name: pairing.name,
    crop: null,
    treatment: null,
    block: null,
    substrate: null,
    watering_enabled: pairing.wtc_percent_limit > -1_000,
    target_vwc_percent: pairing.wtc_percent_limit > -1_000
      ? pairing.wtc_percent_limit
      : null,
    valve_open_seconds: Math.max(1, pairing.valve_open_time_ms / 1_000),
    measurement_interval_minutes: Math.max(
      0.5,
      pairing.measurement_interval_ms / 60_000,
    ),
    notes: null,
  };
}

function optionalValue(value: string) {
  return value.trim() || null;
}

export function ExperimentBuilder({
  projectId,
  pairings,
  inventoryUpdatedAt,
  initialPrompt = "",
  autoGenerate = false,
  presentation = "modal",
  onClose,
  onCreated,
}: ExperimentBuilderProps) {
  const [step, setStep] = useState<BuilderStep>("prompt");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [draft, setDraft] = useState<ExperimentDraft>(() => emptyExperimentDraft());
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
  const [launchStatus, setLaunchStatus] = useState<"active" | "activating" | null>(null);
  const [createdOperationId, setCreatedOperationId] = useState<string | null>(null);
  const [createdCommandCount, setCreatedCommandCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const autoGenerateStarted = useRef(false);

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
  const stepIndex = step === "prompt" ? 0 : step === "review" ? 1 : 2;

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
          : [...current.assignments, assignmentForPairing(pairing)],
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

  const reviewExperiment = async () => {
    const normalized = normalizeExperimentDraft(draft);
    const issues = validateExperimentDraft(normalized, pairings);
    if (issues.length) {
      setError(issues.map((issue) => issue.message).join(" "));
      return;
    }
    if (!draftInventoryUpdatedAt) {
      setError("Current pot inventory is unavailable.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await preflightExperiment({
        projectId,
        draft: normalized,
        inventoryUpdatedAt: draftInventoryUpdatedAt,
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
      });
      setCreatedSlug(result.experiment_slug);
      setLaunchStatus(result.status);
      setCreatedOperationId(result.operation_id);
      setCreatedCommandCount(result.command_ids.length);
      setStep("complete");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the experiment.");
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
        className={`experiment-builder ${presentation === "inline" ? "is-inline" : ""}`}
        role={presentation === "inline" ? "region" : "dialog"}
        aria-modal={presentation === "modal" ? "true" : undefined}
        aria-labelledby="experiment-builder-title"
      >
        <header className="experiment-builder-header">
          <div>
            <p>ExactH2O Assistant</p>
            <h2 id="experiment-builder-title">Build an experiment</h2>
          </div>
          <ol className="experiment-builder-steps" aria-label="Experiment workflow">
            {["Describe", "Review", "Create"].map((label, index) => (
              <li className={index <= stepIndex ? "is-current" : ""} key={label}>
                <span>{index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <button type="button" onClick={onClose} aria-label="Close">
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
              <aside className="experiment-builder-conversation">
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
              </aside>
              <div className="experiment-builder-review">
              <div className="experiment-builder-fields">
                <label>
                  Name
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(event) => updateDraft("name", event.target.value)}
                  />
                </label>
                <label>
                  Description
                  <input
                    value={draft.description}
                    maxLength={300}
                    onChange={(event) => updateDraft("description", event.target.value)}
                  />
                </label>
                <label>
                  Type
                  <select
                    value={draft.mode}
                    onChange={(event) =>
                      updateMode(
                        event.target.value === "controlled"
                          ? "controlled"
                          : event.target.value === "calibration"
                            ? "calibration"
                            : "observation",
                      )}
                  >
                    <option value="controlled">Controlled</option>
                    <option value="observation">Observation</option>
                    <option value="calibration">Calibration</option>
                  </select>
                </label>
                <label>
                  Record start date
                  <input
                    type="date"
                    value={draft.start_date?.slice(0, 10) ?? ""}
                    onChange={(event) => updateDraft("start_date", event.target.value || null)}
                  />
                  <small>Confirmed changes apply immediately.</small>
                </label>
              </div>

              <div className="experiment-builder-pot-section">
                <div className="experiment-builder-section-heading">
                  <h3>Pots</h3>
                  <span>{draft.assignments.length} selected</span>
                </div>
                <div className="experiment-builder-pot-grid">
                  {sortedPairings.map((pairing) => {
                    const selected = selectedNames.has(pairing.name);
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : ""}
                        key={pairing.name}
                        onClick={() => togglePairing(pairing)}
                      >
                        <span>Pot {pairing.pot_number}</span>
                        <small>Zone {pairing.zone}</small>
                        {selected ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {draft.assignments.length ? (
                <div className="experiment-builder-assignment-list">
                  <div className="experiment-builder-section-heading">
                    <h3>Labels</h3>
                  </div>
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
                </div>
              ) : null}

              {draft.questions.length ? (
                <div className="experiment-builder-questions">
                  {draft.questions.map((question) => <p key={question}>{question}</p>)}
                </div>
              ) : null}
              {controlPlan ? (
                <section className="experiment-builder-preflight">
                  <div>
                    <h3>Ready to start</h3>
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
                    I reviewed the pots and controller changes.
                  </label>
                </section>
              ) : (
                <p className="experiment-builder-safety">
                  Review shows every controller change before anything is sent.
                </p>
              )}
              {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
              {!error && validationIssues.length ? (
                <p className="experiment-builder-error" role="alert">
                  {validationIssues.map((issue) => issue.message).join(" ")}
                </p>
              ) : null}
              </div>
            </div>

            <footer className="experiment-builder-actions">
              <button
                type="button"
                className="is-secondary"
                onClick={() => {
                  setError(null);
                  setStep("prompt");
                }}
              >
                <ArrowLeft size={16} />
                Back
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
                  Confirm and create
                </button>
              ) : (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void reviewExperiment()}
                  disabled={busy || validationIssues.length > 0}
                >
                  {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : null}
                  Review changes
                </button>
              )}
            </footer>
          </>
        ) : null}

        {step === "complete" ? (
          <div className="experiment-builder-complete">
            <span><Check size={22} /></span>
            <h3>{launchStatus === "activating" ? "Experiment starting" : "Experiment created"}</h3>
            <p>
              {launchStatus === "activating"
                ? "The reviewed controller steps are running in order. The tile shows the current status."
                : "The tile and graph are ready."}
            </p>
            <div className="experiment-builder-proof" aria-label="Creation receipt">
              <article>
                <span>Experiment</span>
                <strong>Created</strong>
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
            </div>
            <button
              type="button"
              className="is-primary"
              onClick={() => createdSlug && onCreated(createdSlug)}
            >
              Open experiment
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
