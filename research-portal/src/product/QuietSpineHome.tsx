import { Plus } from "lucide-react";
import { type ReactNode } from "react";
import { experimentIsCompleted, orderHomeExperiments } from "../experimentMeasurement";
import { isCalibrationExperiment, isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { type HomeException, primaryExperimentException } from "../homeExceptions";
import { formatMeasurementTime } from "../measurementFreshness";
import { PortalLink, useCopyRoute } from "./PortalLink";
import "./product.css";

export type InstallationState =
  | { status: "online" }
  | { status: "offline"; lastSeenAt: number | null }
  | { status: "unknown" }
  | { status: "hidden" };

const editableStatuses = new Set(["published_sensing", "active", "activation_failed"]);

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** The optional line under the name: only what distinguishes this experiment's mode. */
export function experimentModeLine(experiment: PortalExperiment, nowMs: number) {
  if (experimentIsCompleted(experiment, nowMs)) {
    const ended = experiment.endedAt ? Date.parse(experiment.endedAt) : Number.NaN;
    return Number.isFinite(ended) ? `Completed ${dateFormat.format(ended)}` : "Completed";
  }
  if (experiment.status === "activating") return "Starting on the controller";
  if (isCalibrationExperiment(experiment)) return "Calibration";
  if (isObservationOnlyExperiment(experiment)) return "Sensing only";
  return null;
}

function ExperimentOptions({
  experiment,
  canEdit,
  onEdit,
  recordAvailable,
}: {
  experiment: PortalExperiment;
  canEdit: boolean;
  onEdit?: (experiment: PortalExperiment) => void;
  recordAvailable: boolean;
}) {
  const { copied, copy } = useCopyRoute();
  const editable = !experiment.status || editableStatuses.has(experiment.status);
  const close = (element: HTMLElement) => element.closest("details")?.removeAttribute("open");
  return (
    <details
      className="px-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
      }}
    >
      <summary aria-label={`Options for ${experiment.name}`} title="Experiment options">⋯</summary>
      <div className="px-menu-panel" role="menu">
        <PortalLink role="menuitem" to={{ view: "experiment", experiment: experiment.id, tab: "overview", pot: null }}>Overview</PortalLink>
        <PortalLink role="menuitem" to={{ view: "experiment", experiment: experiment.id, tab: "pots", pot: null }}>Pots</PortalLink>
        {recordAvailable ? <PortalLink role="menuitem" to={{ view: "experiment", experiment: experiment.id, tab: "record", pot: null }}>Record</PortalLink> : null}
        <button type="button" role="menuitem" onClick={(event) => {
          close(event.currentTarget);
          void copy({ view: "experiment", experiment: experiment.id, tab: "overview", pot: null });
        }}>{copied ?? "Copy link"}</button>
        {canEdit && onEdit ? (
          <>
            <hr />
            <button type="button" role="menuitem" disabled={!editable}
              title={editable ? undefined : "Wait for the current experiment action to finish"}
              onClick={(event) => {
                close(event.currentTarget);
                onEdit(experiment);
              }}>Edit experiment</button>
          </>
        ) : null}
      </div>
    </details>
  );
}

function ExperimentCard({
  experiment,
  exceptions,
  nowMs,
  canEdit,
  onEdit,
  recordAvailable,
}: {
  experiment: PortalExperiment;
  exceptions: readonly HomeException[];
  nowMs: number;
  canEdit: boolean;
  onEdit?: (experiment: PortalExperiment) => void;
  recordAvailable: boolean;
}) {
  const count = experiment.pairingNames.length;
  const mode = experimentModeLine(experiment, nowMs);
  const issue = primaryExperimentException(exceptions, experiment.id);
  const completed = experimentIsCompleted(experiment, nowMs);
  const issueTab = issue?.primary.kind === "missing-observations" ? "pots" : "overview";
  return (
    <article className={`px-exp-card ${completed ? "is-completed" : ""}`} aria-label={experiment.name}>
      <PortalLink className="px-exp-open" to={{ view: "experiment", experiment: experiment.id, tab: "overview", pot: null }}>
        <span className="px-exp-name">{experiment.name}</span>
        <span className="px-exp-count">{count} {count === 1 ? "pot" : "pots"}</span>
        {mode ? <span className="px-exp-mode">{mode}</span> : null}
      </PortalLink>
      <ExperimentOptions experiment={experiment} canEdit={canEdit} onEdit={onEdit} recordAvailable={recordAvailable} />
      {issue ? (
        <p className={`px-exp-exception ${issue.primary.kind === "activation-failed" ? "is-bad" : ""}`}>
          <span aria-hidden="true">!</span>
          <span>
            {issue.primary.sentence}
            {issue.more ? ` (+${issue.more} more)` : ""}{" "}
            <PortalLink to={{ view: "experiment", experiment: experiment.id, tab: issueTab, pot: null }}>Review</PortalLink>
          </span>
        </p>
      ) : null}
    </article>
  );
}

function InstallationNode({ state, checking, healthLink }: { state: InstallationState; checking: boolean; healthLink?: ReactNode }) {
  if (state.status === "hidden") return null;
  const tone = state.status === "offline" ? "is-bad" : state.status === "unknown" ? "is-unknown" : "";
  return (
    <div className={`px-node ${tone}`}>
      <span className="px-node-mark" aria-hidden="true" />
      <b>Research controller</b>
      {state.status === "offline" ? (
        <span className="px-node-detail">
          Offline{state.lastSeenAt ? ` since ${formatMeasurementTime(state.lastSeenAt)}` : ""}
        </span>
      ) : state.status === "unknown" ? (
        <span className="px-node-detail">Controller status unavailable</span>
      ) : checking ? (
        <span className="px-node-detail">Checking readings…</span>
      ) : null}
      {healthLink}
    </div>
  );
}

/**
 * The installation home: one compact card per experiment on the animated spine (identity only;
 * the motion never encodes data). Healthy operation is quiet; an affected experiment gets one
 * specific exception line, and installation-wide conditions are stated once above the spine.
 */
export function QuietSpineHome({
  experiments,
  exceptions,
  nowMs,
  checking,
  catalogError,
  installation,
  canCreate,
  onNewExperiment,
  onEditExperiment,
  healthLink,
  machines,
  tools,
  leading,
  recordAvailable,
}: {
  experiments: readonly PortalExperiment[];
  exceptions: readonly HomeException[];
  nowMs: number;
  checking: boolean;
  catalogError: string | null;
  installation: InstallationState;
  canCreate: boolean;
  onNewExperiment: () => void;
  onEditExperiment: (experiment: PortalExperiment) => void;
  healthLink?: ReactNode;
  machines?: ReactNode;
  tools?: ReactNode;
  leading?: ReactNode;
  recordAvailable: boolean;
}) {
  const installationNotices = exceptions.filter((item) => item.scope !== "experiment");
  const ordered = orderHomeExperiments(experiments, nowMs);
  return (
    <section className="px-home" aria-label="Experiments">
      <div className="px-home-top">
        <div className="px-home-heading"><h1 className="px-title">Experiments</h1><div className="px-home-links">
          <PortalLink className="px-button is-small" to={{ view: "trends" }}>Trends</PortalLink>
        </div></div>
        {canCreate ? (
          <button type="button" className="px-button is-primary" onClick={onNewExperiment}>
            <Plus size={16} aria-hidden="true" />
            New experiment
          </button>
        ) : null}
      </div>
      {installationNotices.map((notice) => (
        <p key={notice.kind} className={`px-notice ${notice.kind === "controller-offline" ? "is-bad" : ""}`} role="status">
          <span className="px-notice-mark" aria-hidden="true">{notice.kind === "refresh-failed" ? "↻" : "!"}</span>
          <span>{notice.sentence}</span>
        </p>
      ))}
      {catalogError ? (
        <p className="px-notice" role="status">The experiment list could not be refreshed: {catalogError}. Showing the last list loaded.</p>
      ) : null}
      <div className={`px-home-grid ${tools ? "" : "is-single"}`}>
        <div>
          {leading}
          {ordered.length ? (
            <div className="px-spine-wrap">
            <span className="px-dash-v" aria-hidden="true" />
            <ol className="px-spine" aria-label="Experiments on this controller">
              {ordered.map((experiment) => (
                <li className="px-spine-item" key={experiment.id}>
                  <span className="px-dash-h" aria-hidden="true" />
                  <ExperimentCard
                    experiment={experiment}
                    exceptions={exceptions}
                    nowMs={nowMs}
                    canEdit={canCreate}
                    onEdit={onEditExperiment}
                    recordAvailable={recordAvailable}
                  />
                </li>
              ))}
              <li className="px-spine-item">
                <span className="px-dash-h" aria-hidden="true" />
                <InstallationNode state={installation} checking={checking} healthLink={healthLink} />
              </li>
            </ol>
            </div>
          ) : (
            <p className="px-empty">{checking ? "Loading experiments…" : "No experiments are visible to this account yet."}</p>
          )}
          {machines ? <section className="px-machines" aria-label="Machines"><h2>Machines</h2>{machines}</section> : null}
        </div>
        {tools ? <aside className="px-tools" aria-label="Installation tools"><details className="px-admin-tools"><summary>Administration</summary><div className="px-admin-tools-body">{tools}</div></details></aside> : null}
      </div>
    </section>
  );
}
