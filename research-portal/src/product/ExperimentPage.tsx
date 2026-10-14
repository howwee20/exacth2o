import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** Header and tabs shared by individual traces, Overview and Record. Each tab is its own URL. */
export function ExperimentPage({
  experiment,
  tab,
  nowMs,
  readingStatus,
  onExport,
  exceptions,
  tabs,
  actions,
  secondaryActions,
  children,
}: {
  experiment: PortalExperiment;
  tab: ExperimentTab;
  nowMs: number;
  readingStatus?: string;
  onExport?: () => void;
  exceptions: readonly HomeException[];
  tabs: ExperimentTab[];
  actions?: ReactNode;
  secondaryActions?: ReactNode;
  children: ReactNode;
}) {
  const { copied, copy } = useCopyRoute();
  useEffect(() => { const previous = document.title; document.title = `${experiment.name} · ExactH2O`; return () => { document.title = previous; }; }, [experiment.name]);
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(64);
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('.px-header');
    let frame = 0;
    const update = () => { frame = 0; const height = header?.getBoundingClientRect().height ?? 0; setHeaderHeight(height); setCompact((headerRef.current?.getBoundingClientRect().bottom ?? Infinity) < height); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    if (header) resize.observe(header);
    if (headerRef.current) resize.observe(headerRef.current);
    window.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule); update();
    return () => { window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); resize.disconnect(); cancelAnimationFrame(frame); };
  }, [experiment.id]);
  const count = experiment.pairingNames.length;
  const mode = experimentModeLine(experiment, nowMs);
  const progress = experimentProgressText(experiment, nowMs);
  const own = exceptions.filter((item) => item.scope !== "experiment" || item.experimentId === experiment.id);
  const labels: Record<ExperimentTab, string> = { overview: "Overview", pots: "Traces", record: "Record" };
  return (
    <section className={`px-page is-wide px-experiment-page ${tab === "pots" ? "is-traces" : ""}`} aria-label={experiment.name}>
      <PortalLink className="px-crumb" to={{ view: "home" }}>← Experiments</PortalLink>
      {compact ? <div className="px-compact-experiment" style={{ top: headerHeight }} aria-label="Current experiment">
        <div><strong>{experiment.name}</strong>{readingStatus ? <span>{readingStatus}</span> : null}</div>
        {onExport ? <button className="px-button is-small" onClick={onExport}>Export</button> : null}
      </div> : null}
      <div className="px-exp-head" ref={headerRef}>
        <div className="px-exp-head-row">
          <h1 className="px-title">{experiment.name}</h1>
          <div className="px-toolbar">
            {actions}
            <details className="px-menu px-more-actions" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
              <summary>More</summary><div className="px-menu-panel" onClick={(event) => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
              {secondaryActions}
              <button type="button" onClick={() => void copy({ view: "experiment", experiment: experiment.id, tab, pot: null })}>{copied ?? "Copy link"}</button>
              </div>
            </details>
          </div>
        </div>
        <p className="px-subtitle">
          <span className="px-mono">{count} {count === 1 ? "pot" : "pots"}</span>
          {mode ? <span>{mode}</span> : null}
          {progress ? <span>{progress}</span> : null}

        </p>
        {experiment.shortDescription || experiment.currentVersion ? <details className="px-details"><summary>Experiment details</summary>{experiment.shortDescription ? <p>{experiment.shortDescription}</p> : null}{experiment.sourceNote ? <div className="px-source-note"><h2>Data source</h2><p>{experiment.sourceNote}</p></div> : null}{experiment.currentVersion ? <p className="px-muted">Revision {experiment.currentVersion}</p> : null}</details> : null}
      </div>
      {own.map((item, index) => (
        <p key={`${item.kind}-${index}`} className={`px-notice ${item.kind === "controller-offline" || item.kind === "activation-failed" ? "is-bad" : ""}`} role="status">
          <span className="px-notice-mark" aria-hidden="true">{item.kind === "refresh-failed" ? "↻" : "!"}</span>
          <span>{item.sentence}{item.kind === "measurement-quality" ? <> <PortalLink to={{view: "experiment", experiment: experiment.id, tab: "pots", pot: item.pairingNames[0]}}>Review reading →</PortalLink></> : null}</span>
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
