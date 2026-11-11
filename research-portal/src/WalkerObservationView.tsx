import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { scheduleVisiblePolling } from "./visiblePolling";
import { isWalkerAccessDenied, type WalkerLiveStatus } from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";
import { loadWalkerExperiments } from "./walkerExperimentClient";
import type { WalkerPortalExperiment } from "./walkerExperiments";
import { SystemSection } from "./product/SystemSection";
import { WalkerCreateExperiment } from "./walker/WalkerCreateExperiment";
import { MachineTile } from "./product/MachineHome";

const walkerStatusPollMs = 60_000;

export function WalkerMachineTile({ onOpen, onOpenExperiment, expanded = false }: { onOpen: () => void; onOpenExperiment: (id: string) => void; expanded?: boolean }) {
  const [status, setStatus] = useState<WalkerLiveStatus | null>(null);
  const [experiments, setExperiments] = useState<WalkerPortalExperiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const refreshCatalog = useCallback(async () => {
    try { setExperiments(await loadWalkerExperiments()); setCatalogFailed(false); }
    catch { setCatalogFailed(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      const [nextStatus, nextCatalog] = await Promise.allSettled([loadWalkerLiveStatus(), loadWalkerExperiments()]);
      if (!active || current !== request) return;
      if (nextStatus.status === "fulfilled") { setStatus(nextStatus.value); setFailed(false); }
      else if (isWalkerAccessDenied(nextStatus.reason)) setVisible(false);
      else setFailed(true);
      if (nextCatalog.status === "fulfilled") { setExperiments(nextCatalog.value); setCatalogFailed(false); }
      else setCatalogFailed(true);
      setLoading(false);
    };
    void refresh();
    const stop = scheduleVisiblePolling(refresh, walkerStatusPollMs);
    return () => { active = false; stop(); };
  }, []);

  if (!visible) return null;
  if (!expanded) return <MachineTile
    name="Walker Pi"
    description="Moisture sensing"
    detail={loading ? "Loading experiments…" : catalogFailed ? "Experiment list unavailable" : `${experiments.length} ${experiments.length === 1 ? "experiment" : "experiments"}`}
    status={failed ? "Status unavailable" : status ? `${status.current_sensor_count ?? status.evidenced_sensor_count} / ${status.expected_sensor_count} sensors` : "Checking sensors…"}
    to={{ view: "walker-home" }}
  />;
  return <>
    <SystemSection name="Walker Pi" action={<button type="button" className="px-button is-primary" onClick={() => setCreating(true)} aria-label="Create experiment on Walker Pi"><Plus size={16} aria-hidden="true" />Create experiment</button>}>
      {loading ? <p className="px-system-empty" role="status">Loading experiments…</p> : catalogFailed ? <p className="px-system-empty" role="alert">Could not load experiments. <button type="button" className="px-button" onClick={() => void refreshCatalog()}>Retry</button></p> : experiments.length ? experiments.map(experiment => <button key={experiment.id} type="button" className="px-walker-experiment" onClick={() => onOpenExperiment(experiment.id)}>
        <strong>{experiment.name}</strong><span>{experiment.sensor_ids.length} sensors</span>
      </button>) : <p className="px-system-empty">No experiments yet.</p>}
      <div className="px-system-links">
        <button type="button" className="px-system-text-button" onClick={onOpen}>View readings →</button>
        {failed ? <span>Readings status unavailable</span> : status ? <span>{status.current_sensor_count ?? status.evidenced_sensor_count} of {status.expected_sensor_count} reporting</span> : null}
      </div>
    </SystemSection>
    {creating ? <WalkerCreateExperiment onClose={() => setCreating(false)} onCreated={experiment => { setExperiments(current => [...current, experiment]); setCatalogFailed(false); setCreating(false); }} /> : null}
  </>;
}
