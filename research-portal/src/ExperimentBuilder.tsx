import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import {
  draftExperiment,
  publishExperiment,
} from "./experimentClient";
import {
  emptyExperimentDraft,
  manualExperimentDraft,
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
    target_vwc_percent: null,
    measurement_interval_minutes: Math.max(
      1,
      Math.round(pairing.measurement_interval_ms / 60_000),
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
  onClose,
  onCreated,
}: ExperimentBuilderProps) {
  const [step, setStep] = useState<BuilderStep>("prompt");
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<ExperimentDraft>(() => emptyExperimentDraft());
  const [source, setSource] = useState<ExperimentDraftSource>("manual");
  const [draftInventoryUpdatedAt, setDraftInventoryUpdatedAt] = useState<string | null>(
    inventoryUpdatedAt,
  );
  const [model, setModel] = useState<string | null>(null);
  const [promptFingerprint, setPromptFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

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

  const generateDraft = async () => {
    if (!prompt.trim()) {
      setError("Describe the experiment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await draftExperiment(projectId, prompt.trim());
      setDraft(normalizeExperimentDraft(result.draft));
      setSource("natural_language");
      setDraftInventoryUpdatedAt(result.inventory_updated_at);
      setModel(result.model);
      setPromptFingerprint(result.prompt_fingerprint);
      setStep("review");
      if (result.validation_messages.length) {
        setError(result.validation_messages.join(" "));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the draft.");
    } finally {
      setBusy(false);
    }
  };

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
  };

  const togglePairing = (pairing: PairingRow) => {
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
    value: string | number | null,
  ) => {
    setDraft((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) =>
        assignment.pairing_name === pairingName
          ? { ...assignment, [key]: value }
          : assignment
      ),
    }));
  };

  const createExperiment = async () => {
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
      const result = await publishExperiment({
        projectId,
        draft: normalized,
        inventoryUpdatedAt: draftInventoryUpdatedAt,
        source,
        model,
        promptFingerprint,
      });
      setCreatedSlug(result.experiment_slug);
      setStep("complete");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the experiment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="experiment-builder-backdrop" role="presentation">
      <section
        className="experiment-builder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="experiment-builder-title"
      >
        <header className="experiment-builder-header">
          <div>
            <p>Experiments</p>
            <h2 id="experiment-builder-title">New experiment</h2>
          </div>
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
              placeholder="Use pots 15–26 for a maize trial. Label half control and half drought."
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
                onClick={() => void generateDraft()}
                disabled={busy || !prompt.trim()}
              >
                {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : <Sparkles size={16} />}
                Generate draft
              </button>
            </div>
          </div>
        ) : null}

        {step === "review" ? (
          <>
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
                      updateDraft(
                        "mode",
                        event.target.value === "calibration" ? "calibration" : "observation",
                      )}
                  >
                    <option value="observation">Observation</option>
                    <option value="calibration">Calibration</option>
                  </select>
                </label>
                <label>
                  Start date
                  <input
                    type="date"
                    value={draft.start_date?.slice(0, 10) ?? ""}
                    onChange={(event) => updateDraft("start_date", event.target.value || null)}
                  />
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
                    </div>
                  ))}
                </div>
              ) : null}

              {draft.questions.length ? (
                <div className="experiment-builder-questions">
                  {draft.questions.map((question) => <p key={question}>{question}</p>)}
                </div>
              ) : null}
              <p className="experiment-builder-safety">Sensing only. Watering will not change.</p>
              {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
              {!error && validationIssues.length ? (
                <p className="experiment-builder-error" role="alert">
                  {validationIssues.map((issue) => issue.message).join(" ")}
                </p>
              ) : null}
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
              <button
                type="button"
                className="is-primary"
                onClick={() => void createExperiment()}
                disabled={busy || validationIssues.length > 0}
              >
                {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : null}
                Create experiment
              </button>
            </footer>
          </>
        ) : null}

        {step === "complete" ? (
          <div className="experiment-builder-complete">
            <span><Check size={22} /></span>
            <h3>Experiment created</h3>
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
