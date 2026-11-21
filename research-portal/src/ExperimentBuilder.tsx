import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  Play,
  X,
} from "lucide-react";
import {
  ExperimentRequestError,
  launchExperiment,
  preflightExperiment,
} from "./experimentClient";
import {
  experimentDraftFromPortalExperiment,
  manualExperimentDraft,
  type ExperimentBuilderMode,
  type ExperimentControlPlan,
  type ExperimentDraft,
  type ExperimentDraftAssignment,
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
import { autocalRunStore, useAutocalRun } from "./autocalibrate/runStore";
import { potRanges } from "./product/directExperimentModel";
import {
  assignmentInGroup,
  groupTones,
  groupsFromAssignments,
  nextGroup,
  type ExperimentGroup,
} from "./experimentGroups";

// The whole experiment is set up on one screen. Autocalibration is a separate tool the screen can open and return
// from, and the last panel only shows while the new experiment opens or if its controller changes did not apply.
type BuilderStep = "setup" | "calibrate" | "complete";
const noPortalExperiments: readonly PortalExperiment[] = [];

// A new experiment is one of two kinds. Observation stays available only for an experiment that already is one.
const modeOptions: ReadonlyArray<readonly [ExperimentBuilderMode, string, string]> = [
  ["controlled", "Control", "Measure and water to a target"],
  ["calibration", "Calibration", "Measure a calibration trial"],
];
const observationOption = ["observation", "Observation", "Measure with watering off"] as const;

type ExperimentBuilderProps = {
  projectId: string;
  pairings: PairingRow[];
  inventoryUpdatedAt: string | null;
  experiment?: PortalExperiment | null;
  template?: PortalExperiment | null;
  experiments?: readonly PortalExperiment[];
  presentation?: "modal" | "inline";
  systemName?: string;
  /** The autocalibration of the draft's pots. It reports when its session ends and whether the test ran to the end. */
  renderCalibration?: (draft: ExperimentDraft, options: { onClosed: (outcome: { status: string; completed: boolean }) => void }) => ReactNode;
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
  experiment = null,
  template = null,
  experiments = noPortalExperiments,
  presentation = "modal",
  systemName,
  renderCalibration,
  onClose,
  onCreated,
}: ExperimentBuilderProps) {
  const editing = Boolean(experiment);
  const calibrationRunning = Boolean(useAutocalRun().live);
  const [step, setStep] = useState<BuilderStep>("setup");
  const templateAssignments = useMemo(() => template ? experimentDraftFromPortalExperiment(template, pairings).assignments : [], [template, pairings]);
  const [draft, setDraft] = useState<ExperimentDraft>(() =>
    experiment
      ? experimentDraftFromPortalExperiment(experiment, pairings)
      : template
      ? { ...experimentDraftFromPortalExperiment(template, pairings), name: `${template.name} copy`, start_date: null, assignments: [], questions: [] }
      : manualExperimentDraft(pairings)
  );
  const [offerObservation] = useState(draft.mode === "observation");
  // Pots are assigned to treatment groups. An experiment being edited brings its own groups and a copied one brings
  // the groups of the original; a new one starts with Control and Drought.
  const [initialGrouping] = useState(() => groupsFromAssignments(experiment ? draft.assignments : templateAssignments));
  const [groups, setGroups] = useState<ExperimentGroup[]>(initialGrouping.groups);
  const [groupByPot, setGroupByPot] = useState<Record<string, string>>(experiment ? initialGrouping.groupByPot : {});
  const [activeGroupId, setActiveGroupId] = useState(initialGrouping.groups[0].id);
  const [draftInventoryUpdatedAt, setDraftInventoryUpdatedAt] = useState<string | null>(
    inventoryUpdatedAt,
  );
  // The controller changes the server worked out for this setup. While they are set, the screen is asking for the
  // final confirmation and the form above is locked.
  const [controlPlan, setControlPlan] = useState<ExperimentControlPlan | null>(null);
  const [reviewedConfigHash, setReviewedConfigHash] = useState<string | null>(null);
  const [launchStatus, setLaunchStatus] = useState<"active" | "activating" | "activation_failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [showOccupied, setShowOccupied] = useState(false);
  // "Autocalibrate these pots first": ticked, the button runs the valve test for the chosen pots before anything is
  // created. `calibratedPots` remembers which selection was tested, so changing the pots asks for a new test.
  const [autocalibrate, setAutocalibrate] = useState(false);
  const [calibratedPots, setCalibratedPots] = useState<string | null>(null);
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
    if (!controlPlan) return;
    confirmRef.current?.scrollIntoView({ block: "nearest" });
    confirmRef.current?.focus();
  }, [controlPlan]);

  const sortedPairings = useMemo(
    () => pairings.slice().sort((left, right) =>
      left.pot_number - right.pot_number || left.name.localeCompare(right.name)
    ),
    [pairings],
  );
  const pairingByName = useMemo(
    () => new Map(pairings.map((pairing) => [pairing.name, pairing])),
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
  const visiblePairings = sortedPairings.filter((pairing) => showOccupied || !occupiedByName.has(pairing.name));
  const freePairings = visiblePairings.filter((pairing) => !occupiedByName.has(pairing.name));
  const allSelected = freePairings.length > 0 && freePairings.every((pairing) => selectedNames.has(pairing.name));
  // Two inventory entries can carry the same pot number; those are told apart by name.
  const repeatedNumbers = useMemo(() => {
    const seen = new Set<number>(); const repeated = new Set<number>();
    for (const pairing of pairings) (seen.has(pairing.pot_number) ? repeated : seen).add(pairing.pot_number);
    return repeated;
  }, [pairings]);
  const shownModes = offerObservation ? [...modeOptions, observationOption] : modeOptions;
  const modeLabel = [...modeOptions, observationOption].find(([mode]) => mode === draft.mode)?.[1] ?? "Control";
  const confirming = Boolean(controlPlan);
  const potsKey = draft.assignments.map((assignment) => assignment.pairing_name).sort().join("|");
  const calibrated = calibratedPots !== null && calibratedPots === potsKey;
  const calibrateFirst = Boolean(renderCalibration) && autocalibrate && !calibrated;

  /** "Pots 15–20, 41" for pots the inventory knows; their names as written otherwise. */
  const potsLabel = (names: readonly string[]) => {
    const numbers = names.map((name) => pairingByName.get(name)?.pot_number);
    return numbers.every((value): value is number => typeof value === "number")
      ? potRanges(numbers)
      : names.join(", ");
  };
  const assignmentLabel = (name: string) => {
    const pairing = pairingByName.get(name);
    return pairing && !repeatedNumbers.has(pairing.pot_number) ? `Pot ${pairing.pot_number}` : name;
  };

  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0];
  const valveSeconds = (name: string) => Math.max(1, (pairingByName.get(name)?.valve_open_time_ms ?? 1_000) / 1_000);
  /** The pot's assignment once it belongs to the group: its own settings if it has any, the inventory's otherwise. */
  const inGroup = (pairing: PairingRow, group: ExperimentGroup, mode: ExperimentDraft["mode"], current?: ExperimentDraftAssignment) =>
    assignmentInGroup(current ?? assignmentForMode(pairing, mode, group.base), group, mode, valveSeconds(pairing.name));

  const clearReview = () => {
    setControlPlan(null);
    setReviewedConfigHash(null);
  };

  const updateDraft = <Key extends keyof ExperimentDraft>(
    key: Key,
    value: ExperimentDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearReview();
  };

  const updateMode = (mode: ExperimentDraft["mode"]) => {
    setDraft((current) => ({
      ...current,
      mode,
      assignments: current.assignments.map((assignment) => {
        const group = groups.find((item) => item.id === groupByPot[assignment.pairing_name]);
        return group ? assignmentInGroup(assignment, group, mode, valveSeconds(assignment.pairing_name)) : assignment;
      }),
    }));
    clearReview();
  };

  // A click puts a free pot in the active group, moves a pot from another group into it, or takes it back out.
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
    clearReview();
    const leaving = selectedNames.has(pairing.name) && groupByPot[pairing.name] === activeGroup.id;
    setGroupByPot((current) => {
      const next = { ...current };
      if (leaving) delete next[pairing.name]; else next[pairing.name] = activeGroup.id;
      return next;
    });
    setDraft((current) => {
      const existing = current.assignments.find((assignment) => assignment.pairing_name === pairing.name);
      return {
        ...current,
        assignments: leaving
          ? current.assignments.filter((assignment) => assignment.pairing_name !== pairing.name)
          : existing
          ? current.assignments.map((assignment) => assignment === existing ? inGroup(pairing, activeGroup, current.mode, existing) : assignment)
          : [...current.assignments, inGroup(pairing, activeGroup, current.mode)],
      };
    });
  };

  const updateGroup = (id: string, patch: Partial<Pick<ExperimentGroup, "name" | "target">>) => {
    const group = groups.find((item) => item.id === id);
    if (!group) return;
    const next = { ...group, ...patch };
    setGroups(groups.map((item) => item.id === id ? next : item));
    setDraft((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) => groupByPot[assignment.pairing_name] === id
        ? assignmentInGroup(assignment, next, current.mode, valveSeconds(assignment.pairing_name))
        : assignment),
    }));
    clearReview();
  };

  const addGroup = () => {
    const group = nextGroup(groups);
    setGroups([...groups, group]);
    setActiveGroupId(group.id);
  };

  /** Removing a group frees its pots. */
  const removeGroup = (id: string) => {
    const remaining = groups.filter((group) => group.id !== id);
    if (!remaining.length) return;
    setGroups(remaining);
    if (activeGroupId === id) setActiveGroupId(remaining[0].id);
    setGroupByPot(Object.fromEntries(Object.entries(groupByPot).filter(([, groupId]) => groupId !== id)));
    updateDraft("assignments", draft.assignments.filter((assignment) => groupByPot[assignment.pairing_name] !== id));
  };

  const updateAssignment = (
    pairingName: string,
    key: keyof ExperimentDraftAssignment,
    value: string | number | boolean | null,
  ) => {
    clearReview();
    setDraft((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) =>
        assignment.pairing_name === pairingName
          ? { ...assignment, [key]: value }
          : assignment
      ),
    }));
  };

  /** Every free pot that is not in a group yet joins the active one. */
  const selectAll = () => {
    const joining = freePairings.filter((pairing) => !selectedNames.has(pairing.name));
    setGroupByPot({ ...groupByPot, ...Object.fromEntries(joining.map((pairing) => [pairing.name, activeGroup.id])) });
    updateDraft("assignments", [...draft.assignments, ...joining.map((pairing) => inGroup(pairing, activeGroup, draft.mode))]);
  };

  const clearSelection = () => {
    setGroupByPot({});
    updateDraft("assignments", []);
  };

  const updateAll = (key: keyof ExperimentDraftAssignment, value: string | number | boolean | null) => {
    updateDraft("assignments", draft.assignments.map((assignment) => ({ ...assignment, [key]: value })));
  };

  // First press: the server checks the setup against the live inventory and works out what the controller would
  // change. Nothing is created yet; the screen shows those changes and asks for confirmation.
  const reviewExperiment = async () => {
    if (busy || autocalRunStore.running) return;
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
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not check the experiment.");
    } finally {
      setBusy(false);
    }
  };

  // Second press: create the experiment exactly as it was checked, then open it.
  const startExperiment = async () => {
    if (busy || autocalRunStore.running) return;
    if (!controlPlan || !reviewedConfigHash || !draftInventoryUpdatedAt) {
      setError("Check the experiment first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await launchExperiment({
        projectId,
        draft: normalizeExperimentDraft(draft),
        inventoryUpdatedAt: draftInventoryUpdatedAt,
        source: "manual",
        model: null,
        promptFingerprint: null,
        reviewedConfigHash,
        experimentId: experiment?.databaseId,
        expectedRevisionId: experiment?.currentRevisionId,
      });
      setCreatedSlug(result.experiment_slug);
      setLaunchStatus(result.status);
      setStep("complete");
      onCreated(result.experiment_slug);
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
        className={`experiment-builder is-simple ${presentation === "inline" ? "is-inline" : ""}`}
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
          if (event.shiftKey && (document.activeElement === first || document.activeElement === confirmRef.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <header className="experiment-builder-header">
          <div>
            <h2 id="experiment-builder-title">
              {editing ? `Edit ${experiment?.name ?? "experiment"}` : template ? "Duplicate experiment" : "New experiment"}
            </h2>
            {systemName ? <p>{systemName}</p> : null}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        {step === "setup" ? (
          <>
            <div className="experiment-builder-review">
              <fieldset className="experiment-builder-editable" disabled={busy || confirming}>
                {template ? <p className="settings-muted">Copied from {template.name}. Choose its pots.</p> : null}
                <div className="xb-top">
                  <label className="xb-name">
                    Experiment name
                    <input
                      autoFocus
                      placeholder="e.g. Maize drought trial"
                      aria-required="true"
                      value={draft.name}
                      maxLength={120}
                      onChange={(event) => updateDraft("name", event.target.value)}
                    />
                  </label>
                  <fieldset className="xb-type">
                    <legend>Experiment type</legend>
                    <div className="xb-segment">
                      {shownModes.map(([mode, label, description]) => (
                        <button
                          type="button"
                          className={draft.mode === mode ? "is-selected" : ""}
                          key={mode}
                          aria-pressed={draft.mode === mode}
                          title={description}
                          onClick={() => updateMode(mode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>

                <section className="xb-section">
                  <div className="xb-heading">
                    <h3>Groups</h3>
                    <span>Pick a group, then click its pots.</span>
                    <div className="xb-heading-tools">
                      <button type="button" className="xb-link" onClick={addGroup}>Add group</button>
                    </div>
                  </div>
                  <div className="xb-groups" role="radiogroup" aria-label="Group to put pots in">
                    {groups.map((group) => {
                      const active = group.id === activeGroup.id;
                      const count = draft.assignments.filter((assignment) => groupByPot[assignment.pairing_name] === group.id).length;
                      const name = group.name.trim() || "Unnamed group";
                      return (
                        <div
                          className={active ? "xb-group is-active" : "xb-group"}
                          style={{ "--tone": groupTones[group.tone] } as CSSProperties}
                          key={group.id}
                          onClick={() => setActiveGroupId(group.id)}
                          onFocus={() => setActiveGroupId(group.id)}
                        >
                          <input type="radio" name="experiment-group" aria-label={name} checked={active} onChange={() => setActiveGroupId(group.id)} />
                          <input
                            className="xb-group-name"
                            aria-label={`${name} name`}
                            placeholder="Group name"
                            maxLength={80}
                            value={group.name}
                            onChange={(event) => updateGroup(group.id, { name: event.target.value })}
                          />
                          <label className="xb-group-target">
                            <input
                              type="number"
                              aria-label={`${name} target (% VWC)`}
                              min={0}
                              max={80}
                              step={0.1}
                              placeholder="Off"
                              disabled={draft.mode === "observation"}
                              value={draft.mode === "observation" ? "" : group.target ?? ""}
                              onChange={(event) => updateGroup(group.id, { target: event.target.value === "" ? null : Number(event.target.value) })}
                            />
                            % VWC
                          </label>
                          <span className="xb-group-count">{count} {count === 1 ? "pot" : "pots"}</span>
                          {groups.length > 1 ? <button type="button" className="xb-group-remove" aria-label={`Remove ${name}`} onClick={(event) => { event.stopPropagation(); removeGroup(group.id); }}>
                            <X size={15} aria-hidden="true" />
                          </button> : null}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="xb-section">
                  <div className="xb-heading">
                    <h3>Pots</h3>
                    <span aria-live="polite">{draft.assignments.length} selected · {availablePairingCount} available</span>
                    <div className="xb-heading-tools">
                      {freePairings.length && !allSelected ? <button type="button" className="xb-link" onClick={selectAll}>Select all</button> : null}
                      {draft.assignments.length ? <button type="button" className="xb-link" onClick={clearSelection}>Clear selection</button> : null}
                      {occupiedByName.size ? <label className="xb-check"><input type="checkbox" checked={showOccupied} onChange={(event) => setShowOccupied(event.target.checked)} />Show pots in use ({occupiedByName.size})</label> : null}
                    </div>
                  </div>
                  {!visiblePairings.length ? <p className="settings-muted">All pots are in use.</p> : null}
                  <div className="xb-pots">
                    {visiblePairings.map((pairing) => {
                      const selected = selectedNames.has(pairing.name);
                      const occupancy = occupiedByName.get(pairing.name) ?? [];
                      const occupied = occupancy.length > 0;
                      const repeated = repeatedNumbers.has(pairing.pot_number);
                      const group = selected ? groups.find((item) => item.id === groupByPot[pairing.name]) : undefined;
                      const groupName = group ? group.name.trim() || "Unnamed group" : "";
                      return (
                        <button
                          type="button"
                          style={group ? { "--tone": groupTones[group.tone] } as CSSProperties : undefined}
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
                            : `Pot ${pairing.pot_number}${repeated ? ` (${pairing.name})` : ""}${
                              selected ? `, ${groupName}` : ""
                            }`}
                          title={occupied
                            ? `Used by ${occupancy.map((item) => item.experimentName).join(", ")}`
                            : `${repeated ? pairing.name : `Pot ${pairing.pot_number}`}${selected ? ` · ${groupName}` : ""}`}
                        >
                          {pairing.pot_number}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <details className="experiment-builder-details">
                  <summary>More options</summary>
                  <div className="xb-more">
                    <label>
                      Description
                      <input
                        value={draft.description}
                        maxLength={300}
                        onChange={(event) => updateDraft("description", event.target.value)}
                      />
                    </label>
                    <label>
                      Record start date
                      <input
                        type="date"
                        value={draft.start_date?.slice(0, 10) ?? ""}
                        onChange={(event) => updateDraft("start_date", event.target.value || null)}
                      />
                    </label>
                    <label>Crop<input disabled={!draft.assignments.length} value={commonAssignmentValue(draft.assignments, "crop") ?? ""} onChange={(event) => updateAll("crop", optionalValue(event.target.value))} /></label>
                    {([
                      ["valve_open_seconds", "Pulse (seconds)", 1, 120, 0.5],
                      ["measurement_interval_minutes", "Measure every (min)", 0.5, 60, 0.5],
                    ] as const).map(([key, label, min, max, increment]) => <label key={key}>{label}<input type="number" min={min} max={max} step={increment} disabled={!draft.assignments.length || (key === "valve_open_seconds" && draft.mode === "observation")} value={commonAssignmentValue(draft.assignments, key) ?? ""} onChange={(event) => updateAll(key, event.target.value === "" ? null : Number(event.target.value))} /></label>)}
                  </div>
                  {draft.assignments.length ? <details className="experiment-builder-details"><summary>Individual pots ({draft.assignments.length})</summary>
                  {draft.assignments.map((assignment) => (
                    <div className="experiment-builder-assignment" key={assignment.pairing_name}>
                      <strong>{assignmentLabel(assignment.pairing_name)}{assignment.treatment ? ` · ${assignment.treatment}` : ""}</strong>
                      {([ ["crop", "Crop"], ["block", "Block"] ] as const).map(([key, label]) => (
                        <input
                          key={key}
                          aria-label={`${assignment.pairing_name} ${key}`}
                          placeholder={label}
                          value={assignment[key] ?? ""}
                          onChange={(event) => updateAssignment(assignment.pairing_name, key, optionalValue(event.target.value))}
                        />
                      ))}
                      {([
                        ["valve_open_seconds", "Pulse sec", 1, 120, 0.5],
                        ["measurement_interval_minutes", "Measure min", 0.5, 60, 0.5],
                      ] as const).map(([key, label, min, max, increment]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            min={min}
                            max={max}
                            step={increment}
                            disabled={key === "valve_open_seconds" && draft.mode === "observation"}
                            value={assignment[key] ?? ""}
                            onChange={(event) => updateAssignment(assignment.pairing_name, key, event.target.value === "" ? null : Number(event.target.value))}
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                  </details> : null}
                </details>

                {renderCalibration ? <label className="xb-check xb-autocal">
                  <input type="checkbox" checked={autocalibrate || calibrated} disabled={calibrated} onChange={(event) => setAutocalibrate(event.target.checked)} />
                  {calibrated ? "Autocalibrated" : "Autocalibrate these pots first"}
                </label> : null}
              </fieldset>
              {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
              {calibrationRunning ? <p className="settings-muted" role="status">Autocalibration is running. Finish or stop it first.</p> : null}
              {attemptedReview && !error && validationIssues.length ? (
                <p className="experiment-builder-error" role="alert">
                  {validationIssues.map((issue) => issue.message).join(" ")}
                </p>
              ) : null}
            </div>

            {controlPlan ? (
              <footer className="experiment-builder-actions is-confirming">
                <div className="xb-confirm" ref={confirmRef} tabIndex={-1} role="group" aria-label={editing ? "Ready to save" : "Ready to start"}>
                  <h3>{editing ? "Ready to save" : "Ready to start"}</h3>
                  <p>
                    {draft.assignments.length} {draft.assignments.length === 1 ? "pot" : "pots"} · {modeLabel}{draft.start_date ? ` · Record starts ${draft.start_date.slice(0, 10)}` : " · Starts today"}
                    {" · "}
                    {controlPlan.change_count
                      ? `${controlPlan.change_count} pot setting${controlPlan.change_count === 1 ? "" : "s"} will change`
                      : "Current controller settings already match"}
                  </p>
                  {controlPlan.changes.length ? <ul>
                    {controlPlan.changes.map((change) => (
                      <li key={JSON.stringify([
                        change.pairing_names,
                        change.watering_enabled,
                        change.target_vwc_percent,
                        change.valve_open_seconds,
                        change.measurement_interval_minutes,
                      ])}>
                        <strong>{potsLabel(change.pairing_names)}</strong>
                        <span>
                          {change.watering_enabled
                            ? `${change.target_vwc_percent}% · ${change.valve_open_seconds}s`
                            : "Watering off"}
                          {" · "}
                          every {change.measurement_interval_minutes} min
                        </span>
                      </li>
                    ))}
                  </ul> : null}
                  {controlPlan.requires_controller_stop ? (
                    <p className="xb-confirm-note">
                      <AlertTriangle size={15} aria-hidden="true" />
                      The controller will pause, apply these settings, then resume. If a step fails, it stays stopped.
                    </p>
                  ) : null}
                </div>
                <div className="xb-confirm-buttons">
                  <button type="button" className="is-secondary" disabled={busy} onClick={() => { setError(null); clearReview(); }}>
                    Edit setup
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => void startExperiment()}
                    disabled={busy || calibrationRunning || validationIssues.length > 0}
                  >
                    {busy
                      ? <Loader2 className="chart-loading-spinner" size={16} />
                      : <Play size={16} />}
                    {editing ? "Confirm and save" : "Confirm and create"}
                  </button>
                </div>
              </footer>
            ) : (
              <footer className="experiment-builder-actions">
                <button type="button" className="is-secondary" disabled={busy} onClick={() => { setError(null); onClose(); }}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => { if (calibrateFirst) { setError(null); setStep("calibrate"); } else void reviewExperiment(); }}
                  disabled={busy || calibrationRunning || !draft.name.trim() || !draft.assignments.length}
                >
                  {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : null}
                  {calibrateFirst ? (editing ? "Autocalibrate, then save" : "Autocalibrate, then create") : editing ? "Save changes" : "Create experiment"}
                </button>
              </footer>
            )}
          </>
        ) : null}

        {step === "calibrate" && renderCalibration ? <>
          <div className="experiment-builder-calibration">{renderCalibration(draft, { onClosed: ({ completed }) => {
            if (completed) setCalibratedPots(potsKey);
            setStep("setup");
          } })}</div>
          <footer className="experiment-builder-actions">
            <button type="button" className="is-secondary" onClick={() => setStep("setup")}>
              <ArrowLeft size={16} /> Back to experiment setup
            </button>
          </footer>
        </> : null}

        {step === "complete" ? (
          <div className="experiment-builder-complete">
            <span>{launchStatus === "activation_failed" ? <AlertTriangle size={22} /> : <Check size={22} />}</span>
            <h3>
              {launchStatus === "activation_failed" ? "Experiment saved; changes paused" : launchStatus === "activating"
                ? editing ? "Changes are applying" : "Experiment starting"
                : editing ? "Experiment updated" : "Experiment created"}
            </h3>
            <p>
              {launchStatus === "activation_failed"
                ? "Open the saved experiment to review its status before retrying."
                : `Opening ${draft.name}…`}
            </p>
            {error ? <p className="experiment-builder-error" role="alert">{error}</p> : null}
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
