import { useEffect, useState } from "react";
import { usePortalQueryValue } from "../portalRoute";
import { loadWalkerExperiment } from "../walkerExperimentClient";
import type { WalkerPortalExperiment } from "../walkerExperiments";
import { WalkerExperimentView } from "./WalkerExperimentView";
import { PortalHomeButton } from "../product/PortalHomeButton";

export function WalkerExperimentPage({ onBack }: { onBack: () => void }) {
  const id = usePortalQueryValue("study");
  const [record, setRecord] = useState<WalkerPortalExperiment | null>(null);
  const [error, setError] = useState(false);
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
  return <WalkerExperimentView key={id ?? "all-readings"} experiment={id ? record : null} onBack={onBack} />;
}
