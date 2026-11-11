import { useEffect, useState } from "react";
import { navigatePortal, usePortalQueryValue } from "../portalRoute";
import { loadWalkerExperiment } from "../walkerExperimentClient";
import type { WalkerPortalExperiment } from "../walkerExperiments";
import { WalkerExperimentView } from "./WalkerExperimentView";
import { PortalHomeButton } from "../product/PortalHomeButton";
import { useWalkerOverview } from "../WalkerObservationView";
import { WalkerCreateExperiment } from "./WalkerCreateExperiment";

export function WalkerExperimentPage({ onBack }: { onBack: () => void }) {
  const id = usePortalQueryValue("study");
  const creating = usePortalQueryValue("view") === "walker-new-experiment";
  const [record, setRecord] = useState<WalkerPortalExperiment | null>(null);
  const [error, setError] = useState(false);
  const { experiments } = useWalkerOverview();
  useEffect(() => {
    let active = true;
    setRecord(null); setError(false);
    if (id) void loadWalkerExperiment(id).then(data => { if (active) setRecord(data); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id]);
  if (id && (!record || record.id !== id)) return <section className="px-page">
    <PortalHomeButton onClick={onBack} />
    <p role={error ? "alert" : "status"}>{error ? "This Walker experiment is unavailable." : "Loading experiment…"}</p>
  </section>;
  const choices = record && !experiments.some(experiment => experiment.id === record.id) ? [...experiments, record] : experiments;
  return <>
    <WalkerExperimentView key={id ?? "all-readings"} experiment={id ? record : null} onBack={onBack} tools={
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
