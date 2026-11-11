import { useEffect, useState } from "react";
import { scheduleVisiblePolling } from "./visiblePolling";
import { isWalkerAccessDenied, type WalkerLiveStatus } from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";
import { loadWalkerExperiments } from "./walkerExperimentClient";
import type { WalkerPortalExperiment } from "./walkerExperiments";
import { formatSettingsTimestamp } from "./portalFormat";
import { MachineTile } from "./product/MachineHome";
import { PortalHomeButton } from "./product/PortalHomeButton";

const walkerStatusPollMs = 60_000;

export function useWalkerOverview() {
  const [status, setStatus] = useState<WalkerLiveStatus | null>(null);
  const [experiments, setExperiments] = useState<WalkerPortalExperiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);
  const [catalogFailed, setCatalogFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let request = 0;
    const update = async () => {
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
    void update();
    const stop = scheduleVisiblePolling(update, walkerStatusPollMs);
    return () => { active = false; stop(); };
  }, []);

  return { status, experiments, loading, visible, failed, catalogFailed };
}

export function WalkerMachineTile() {
  const { status, experiments, loading, visible, failed, catalogFailed } = useWalkerOverview();
  if (!visible) return null;
  return <MachineTile
    name="Walker Pi"
    detail={loading ? "Loading experiments…" : catalogFailed ? "Experiment list unavailable" : `${experiments.length} ${experiments.length === 1 ? "experiment" : "experiments"}`}
    status={failed ? "Status unavailable" : status ? `${status.current_sensor_count ?? status.evidenced_sensor_count} / ${status.expected_sensor_count} sensors` : "Checking sensors…"}
    to={{ view: "walker" }}
    healthTo={{ view: "walker-health" }}
    calibration={{ unavailable: "Walker Pi currently provides moisture observations without irrigation calibration control." }}
  />;
}

export function WalkerHealthView({ onBack }: { onBack: () => void }) {
  const { status, loading, visible, failed } = useWalkerOverview();
  return <section className="px-page" aria-label="Walker Pi system health">
    <PortalHomeButton onClick={onBack} />
    <h1 className="px-title">Walker Pi system health</h1>
    {loading ? <p role="status">Checking Walker…</p> : null}
    {!visible || failed ? <p className="px-notice" role="alert">Walker status is unavailable.</p> : null}
    {status ? <dl className="px-facts px-card px-account-section">
      <div><dt>Status</dt><dd>{status.overall_status ?? "Unavailable"}</dd></div>
      <div><dt>Reporting sensors</dt><dd>{status.current_sensor_count ?? status.evidenced_sensor_count} / {status.expected_sensor_count}</dd></div>
      <div><dt>Last reading</dt><dd>{formatSettingsTimestamp(status.latest_live_reading_at)}</dd></div>
      <div><dt>Publisher</dt><dd>{status.publisher?.status ?? "Unavailable"}</dd></div>
      <div><dt>Last successful upload</dt><dd>{formatSettingsTimestamp(status.publisher?.last_success_at)}</dd></div>
      {status.publisher?.last_error ? <div><dt>Last upload error</dt><dd>{status.publisher.last_error}</dd></div> : null}
    </dl> : null}
  </section>;
}
