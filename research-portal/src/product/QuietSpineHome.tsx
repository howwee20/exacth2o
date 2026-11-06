import { Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { experimentIsCompleted, orderHomeExperiments } from "../experimentMeasurement";
import { isCalibrationExperiment, isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { type HomeException, primaryExperimentException } from "../homeExceptions";
import { formatMeasurementTime } from "../measurementFreshness";
import { PortalLink, useCopyRoute } from "./PortalLink";
import { SystemSection } from "./SystemSection";
import "./product.css";

export type InstallationState =
  | { status: "online"; lastSeenAt?: number | null }
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
  if (isObservationOnlyExperiment(experiment)) return "Sensing-only plan";
  return null;
}

function ExperimentOptions({
  experiment,
  canEdit,
  onEdit,
  onArchive,
  recordAvailable,
}: {
  experiment: PortalExperiment;
  canEdit: boolean;
  onEdit?: (experiment: PortalExperiment) => void;
  onArchive?: (experiment: PortalExperiment) => void;
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
        <PortalLink role="menuitem" to={{ view: "experiment", experiment: experiment.id, tab: "pots", pot: null }}>Individual traces</PortalLink>
        <PortalLink role="menuitem" to={{ view: "experiment", experiment: experiment.id, tab: "overview", pot: null }}>Overview</PortalLink>
        {recordAvailable ? <PortalLink role="menuitem" to={{ view: "experiment", experiment: experiment.id, tab: "record", pot: null }}>Record</PortalLink> : null}
        <button type="button" role="menuitem" onClick={(event) => {
          close(event.currentTarget);
          void copy({ view: "experiment", experiment: experiment.id, tab: "pots", pot: null });
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
            {onArchive && experiment.mode === "observation" ? <button type="button" role="menuitem" disabled={experiment.status === "activating"} onClick={(event) => {
              close(event.currentTarget);
              onArchive(experiment);
            }}>Archive experiment</button> : null}
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
  onArchive,
  recordAvailable,
}: {
  experiment: PortalExperiment;
  exceptions: readonly HomeException[];
  nowMs: number;
  canEdit: boolean;
  onEdit?: (experiment: PortalExperiment) => void;
  onArchive?: (experiment: PortalExperiment) => void;
  recordAvailable: boolean;
}) {
  const count = experiment.pairingNames.length;
  const mode = experimentModeLine(experiment, nowMs);
  const issue = primaryExperimentException(exceptions, experiment.id);
  const completed = experimentIsCompleted(experiment, nowMs);
  const issueTab = issue?.primary.kind === "missing-observations" ? "pots" : "overview";
  return (
    <article className={`px-exp-card ${completed ? "is-completed" : ""}`} aria-label={experiment.name}>
      <PortalLink className="px-exp-open" to={{ view: "experiment", experiment: experiment.id, tab: "pots", pot: null }}>
        <span className="px-exp-name">{experiment.name}</span>
        <span className="px-exp-count">{count} {count === 1 ? "pot" : "pots"}</span>
        {mode ? <span className="px-exp-mode">{mode}</span> : null}
      </PortalLink>
      <ExperimentOptions experiment={experiment} canEdit={canEdit} onEdit={onEdit} onArchive={onArchive} recordAvailable={recordAvailable} />
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
    <div className={`px-node ${tone}`} aria-label="System status">
      {healthLink ?? <b>System health</b>}
      <span className="px-node-status">
        <span className="px-node-mark" aria-hidden="true" />
        {state.status === "offline" ? (
          <span className="px-node-detail">
            Offline{state.lastSeenAt ? ` since ${formatMeasurementTime(state.lastSeenAt)}` : ""}
          </span>
        ) : state.status === "unknown" ? (
          <span className="px-node-detail">Status unavailable</span>
        ) : checking ? (
          <span className="px-node-detail">Checking readings…</span>
        ) : <span className="px-node-detail">Online{state.lastSeenAt ? ` · seen ${formatMeasurementTime(state.lastSeenAt)}` : ""}</span>}
      </span>
    </div>
  );
}

/** Follow the actual card positions, including wrapped names and mobile status rows. */
function ExperimentConnection({ count, online }: { count: number; online: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState({ height: 1, path: "", branches: "" });
  useLayoutEffect(() => {
    const wrapper = ref.current?.parentElement;
    if (!wrapper) return;
    const items = [...wrapper.querySelectorAll<HTMLElement>(".px-spine > .px-spine-item")];
    const measure = () => {
      if (items.length < 2) return;
      const box = wrapper.getBoundingClientRect();
      const centers = items.map(item => {
        const rect = item.getBoundingClientRect();
        return rect.top - box.top + rect.height / 2;
      });
      const first = centers[0], last = centers[centers.length - 1];
      setGeometry({
        height: box.height,
        path: `M24 ${first} H14 Q6 ${first} 6 ${first + 8} V${last - 8} Q6 ${last} 14 ${last} H24`,
        branches: centers.slice(1, -1).map(y => `M6 ${y} H24`).join(" "),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    items.forEach(item => observer.observe(item));
    return () => observer.disconnect();
  }, [count]);
  return <svg ref={ref} className="px-system-connection" viewBox={`0 0 24 ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true" data-online={online}>
    <path className="px-system-connection-track" d={geometry.path} />
    <path className="px-system-connection-track" d={geometry.branches} />
    <path className="px-system-connection-pulse" d={geometry.path} pathLength="100" />
  </svg>;
}

/**
 * The installation home: one compact card per experiment on the shared controller connection (identity only;
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
  onArchiveExperiment,
  healthLink,
  machines,
  tools,
  leading,
  recordAvailable,
  systemName,
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
  onArchiveExperiment?: (experiment: PortalExperiment) => void;
  healthLink?: ReactNode;
  machines?: ReactNode;
  tools?: ReactNode;
  leading?: ReactNode;
  recordAvailable: boolean;
  systemName?: string;
}) {
  const installationNotices = exceptions.filter((item) => item.scope !== "experiment");
  const ordered = orderHomeExperiments(experiments, nowMs);
  const active = ordered.filter((experiment) => !experimentIsCompleted(experiment, nowMs));
  const completed = ordered.filter((experiment) => experimentIsCompleted(experiment, nowMs));
  const createAction = canCreate ? <button type="button" className="px-button is-primary" aria-label={`Create experiment${systemName ? ` on ${systemName}` : ""}`} onClick={onNewExperiment}>
    <Plus size={16} aria-hidden="true" />Create experiment
  </button> : null;
  const records = <>
          {ordered.length ? (
            <div className="px-spine-wrap">
            {active.length > 0 && installation.status !== "hidden" ? <ExperimentConnection key={active.map(experiment => experiment.id).join("|")} count={active.length} online={installation.status === "online"} /> : null}
            <ol className={`px-spine ${active.length && installation.status !== "hidden" ? "is-connected" : ""}`} data-system-status={installation.status} aria-label="Experiments on this controller">
              {active.map((experiment) => (
                <li className="px-spine-item" key={experiment.id}>
                  <ExperimentCard
                    experiment={experiment}
                    exceptions={exceptions}
                    nowMs={nowMs}
                    canEdit={canCreate}
                    onEdit={onEditExperiment}
                    onArchive={onArchiveExperiment}
                    recordAvailable={recordAvailable}
                  />
                </li>
              ))}
              {!active.length ? <li className="px-empty">No active experiments.</li> : null}
              {installation.status !== "hidden" ? <li className="px-spine-item">
                <InstallationNode state={installation} checking={checking} healthLink={healthLink} />
              </li> : null}
            </ol>
            </div>
          ) : (
            <p className="px-empty">{checking ? "Loading experiments…" : "No experiments are visible to this account yet."}</p>
          )}
          {completed.length ? (
            <details className="px-completed-experiments">
              <summary>Completed experiments <span>{completed.length}</span></summary>
              <ul className="px-completed-list" aria-label="Completed experiments">
                {completed.map((experiment) => (
                  <li key={experiment.id}>
                    <ExperimentCard
                      experiment={experiment}
                      exceptions={exceptions}
                      nowMs={nowMs}
                      canEdit={canCreate}
                      onEdit={onEditExperiment}
                      onArchive={onArchiveExperiment}
                      recordAvailable={recordAvailable}
                    />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
  </>;
  return (
    <section className="px-home" aria-label={systemName ? "Your systems" : "Experiments"}>
      {!systemName ? <div className="px-home-top">
        <div className="px-home-heading"><h1 className="px-title">Experiments</h1></div>
        {createAction}
      </div> : null}
      {installationNotices.map((notice) => (
        <p key={notice.kind} className={`px-notice ${notice.kind === "controller-offline" ? "is-bad" : ""}`} role="status">
          <span className="px-notice-mark" aria-hidden="true">{notice.kind === "refresh-failed" ? "↻" : "!"}</span>
          <span>{notice.sentence}</span>
        </p>
      ))}
      {catalogError ? (
        <p className="px-notice" role="status">The experiment list could not be refreshed: {catalogError}. Showing the last list loaded.</p>
      ) : null}
      <div className="px-home-grid is-single">
        <div className="px-system-list">
          {leading}
          {systemName ? <SystemSection name={systemName} action={createAction}>
            {records}
          </SystemSection> : records}
          {machines ? <div className="px-additional-systems">{machines}</div> : null}
        </div>
        {tools ? <aside className="px-tools" aria-label="Installation tools"><details className="px-admin-tools"><summary>Administration</summary><div className="px-admin-tools-body">{tools}</div></details></aside> : null}
      </div>
    </section>
  );
}
