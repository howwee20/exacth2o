import { useEffect, useState } from "react";
import { navigatePortal, usePortalQueryValue } from "../portalRoute";
import { cachedWalkerExperiment, loadWalkerTraceExperiment, loadWalkerTraceSnapshot } from "../walkerTraceCache";
import type { WalkerPortalExperiment } from "../walkerExperiments";
import { WalkerExperimentView } from "./WalkerExperimentView";
import { PortalHomeButton } from "../product/PortalHomeButton";
import { useWalkerOverview } from "../WalkerObservationView";
import { WalkerCreateExperiment } from "./WalkerCreateExperiment";

export function WalkerExperimentPage({ onBack, userId }: { onBack: () => void; userId?: string }) {
  const id = usePortalQueryValue("study");
  const creating = usePortalQueryValue("view") === "walker-new-experiment";
  const [record, setRecord] = useState<WalkerPortalExperiment | null>(() => id ? cachedWalkerExperiment(userId, id) : null);
  const [error, setError] = useState(false);
  const { experiments } = useWalkerOverview();
  useEffect(() => {
    let active = true;
    setRecord(id ? cachedWalkerExperiment(userId, id) : null); setError(false);
    // On a direct link, start both reads together instead of waiting for the record first.
    void loadWalkerTraceSnapshot(userId).catch(() => {});
    if (id) void loadWalkerTraceExperiment(userId, id).then(data => { if (active) setRecord(data); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id, userId]);
  if (id && (!record || record.id !== id)) return <section className="px-page">
    <PortalHomeButton onClick={onBack} />
    <p role={error ? "alert" : "status"}>{error ? "This Walker experiment is unavailable." : "Loading experiment…"}</p>
  </section>;
  const choices = record && !experiments.some(experiment => experiment.id === record.id) ? [...experiments, record] : experiments;
  return <>
    <WalkerExperimentView key={id ?? "all-readings"} userId={userId} experiment={id ? record : null} onBack={onBack} tools={
      <div className="px-toolbar">
        <label className="px-select">Experiment<select aria-label="Walker experiment" value={id ?? ""} onChange={event => navigatePortal({ view: "walker" }, { extra: { study: event.target.value || null } })}>
          <option value="">All sensors</option>
          {choices.map(experiment => <option key={experiment.id} value={experiment.id}>{experiment.name}</option>)}
        </select></label>
        <button className="px-button" onClick={() => navigatePortal({ view: "walker-new-experiment" }, { extra: { study: id } })} aria-label="Create experiment on Walker Pi">New experiment</button>
      </div>
    } />
    {creating ? <WalkerCreateExperiment onClose={() => navigatePortal({ view: "walker" }, { extra: { study: id } })} onCreated={experiment => {
      navigatePortal({ view: "walker" }, { extra: { study: experiment.id } });
    }} /> : null}
  </>;
}
