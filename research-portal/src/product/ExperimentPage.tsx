import { type ReactNode } from "react";
import { experimentProgressText } from "../experimentMeasurement";
import type { PortalExperiment } from "../experimentRegistry";
import type { HomeException } from "../homeExceptions";
import type { ExperimentTab } from "../portalRoute";
import { PortalLink, useCopyRoute } from "./PortalLink";
import { experimentModeLine } from "./QuietSpineHome";
import "./product.css";

export function ExperimentNotFound({ id, loading }: { id: string; loading: boolean }) {
  return (
    <section className="px-page">
      <PortalLink className="px-crumb" to={{ view: "home" }}>← Experiments</PortalLink>
      {loading ? (
        <p className="px-empty" role="status">Loading the experiment…</p>
      ) : (
        <div className="px-empty" role="alert">
          <p><b>No experiment “{id}” is visible to this account.</b></p>
          <p>It may belong to another project, be archived, or be limited to other roles. Experiments you can open are listed on the home page.</p>
        </div>
      )}
    </section>
  );
}

/** Header and tabs shared by Overview, Pots and Record. Each tab is its own URL. */
export function ExperimentPage({
  experiment,
  tab,
  nowMs,
  exceptions,
  tabs,
  actions,
  children,
}: {
  experiment: PortalExperiment;
  tab: ExperimentTab;
  nowMs: number;
  exceptions: readonly HomeException[];
  tabs: ExperimentTab[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { copied, copy } = useCopyRoute();
  const count = experiment.pairingNames.length;
  const mode = experimentModeLine(experiment, nowMs);
  const progress = experimentProgressText(experiment, nowMs);
  const own = exceptions.filter((item) => item.scope !== "experiment" || item.experimentId === experiment.id);
  const labels: Record<ExperimentTab, string> = { overview: "Overview", pots: "Pots", record: "Record" };
  return (
    <section className="px-page is-wide" aria-label={experiment.name}>
      <PortalLink className="px-crumb" to={{ view: "home" }}>← Experiments</PortalLink>
      <div className="px-exp-head">
        <div className="px-exp-head-row">
          <h1 className="px-title">{experiment.name}</h1>
          <div className="px-toolbar">
            {actions}
            <button type="button" className="px-button is-small" onClick={() => void copy({ view: "experiment", experiment: experiment.id, tab, pot: null })}>{copied ?? "Copy link"}</button>
          </div>
        </div>
        <p className="px-subtitle">
          <span className="px-mono">{count} {count === 1 ? "pot" : "pots"}</span>
          {mode ? <span>{mode}</span> : null}
          {progress ? <span>{progress}</span> : null}
          {experiment.currentVersion ? <span>Revision {experiment.currentVersion}</span> : null}
        </p>
        {experiment.shortDescription ? <p className="px-lede">{experiment.shortDescription}</p> : null}
      </div>
      {own.map((item, index) => (
        <p key={`${item.kind}-${index}`} className={`px-notice ${item.kind === "controller-offline" || item.kind === "activation-failed" ? "is-bad" : ""}`} role="status">
          <span className="px-notice-mark" aria-hidden="true">{item.kind === "refresh-failed" ? "↻" : "!"}</span>
          <span>{item.sentence}</span>
        </p>
      ))}
      <nav className="px-tabs" aria-label="Experiment sections">
        {tabs.map((item) => (
          <PortalLink key={item} to={{ view: "experiment", experiment: experiment.id, tab: item, pot: null }} aria-current={item === tab ? "page" : undefined}>
            {labels[item]}
          </PortalLink>
        ))}
      </nav>
      {children}
    </section>
  );
}
