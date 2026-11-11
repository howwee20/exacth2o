import { useEffect, useRef, useState } from "react";
import { scheduleVisiblePolling } from "./visiblePolling";
import { isWalkerAccessDenied, type WalkerLiveStatus } from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";
import { loadWalkerExperiments } from "./walkerExperimentClient";
import type { WalkerPortalExperiment } from "./walkerExperiments";
import { formatSettingsTimestamp } from "./portalFormat";
import { MachineTile } from "./product/MachineHome";
import { PortalHomeButton } from "./product/PortalHomeButton";
import { loadWalkerTraceSnapshot, rememberWalkerExperiments } from "./walkerTraceCache";

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

export function WalkerMachineTile({ userId }: { userId?: string }) {
  const { status, experiments, loading, visible, failed, catalogFailed } = useWalkerOverview();
  const preparedUser = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !visible) return;
    rememberWalkerExperiments(userId, experiments);
    if (preparedUser.current === userId) return;
    preparedUser.current = userId ?? null;
    void loadWalkerTraceSnapshot(userId).catch(() => { /* Opening traces retries a failed lookahead. */ });
    void import("./walker/WalkerExperimentPage").catch(() => {});
  }, [experiments, loading, userId, visible]);
  if (!visible) return null;
  const currentExperiment = experiments.at(-1);
  return <MachineTile
    name="Walker Pi"
    detail={currentExperiment?.name ?? (loading ? "Loading experiment…" : catalogFailed ? "Experiment unavailable" : "No active experiment")}
    status={failed ? "Status unavailable" : status ? `${status.current_sensor_count ?? status.evidenced_sensor_count} / ${status.expected_sensor_count} sensors` : "Checking sensors…"}
    statusTone={failed || !status ? "unknown" : status.overall_status === "offline" ? "offline"
      : status.overall_status === "operational" && (status.current_sensor_count ?? status.evidenced_sensor_count) > 0 ? "online" : "warning"}
    to={{ view: "walker" }}
    traceExtra={{ study: currentExperiment?.id ?? null }}
    onPrepare={() => { void loadWalkerTraceSnapshot(userId).catch(() => {}); }}
    healthTo={{ view: "walker-health" }}
    creation={{ to: { view: "walker-new-experiment" } }}
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
