import { Activity, AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FreshnessPill, LatestReadingText } from "./experiment/MeasurementStatus";
import { scheduleVisiblePolling } from "./visiblePolling";
import {
  isWalkerAccessDenied,
  walkerFreshness,
  type WalkerLiveStatus,
} from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";

const walkerStatusPollMs = 60_000;

export function WalkerAdminTile({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<WalkerLiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      return loadWalkerLiveStatus()
        .then((nextStatus) => {
          if (!active || current !== request) return;
          setStatus(nextStatus);
          setFailed(false);
          setNowMs(Date.now());
        })
        .catch((error: { code?: string; message?: string }) => {
          if (!active || current !== request) return;
          if (isWalkerAccessDenied(error)) {
            setVisible(false);
          } else {
            // A failed request says nothing about the sensors; keep the last status and say so.
            setFailed(true);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    void refresh();
    const stop = scheduleVisiblePolling(refresh, walkerStatusPollMs);
    return () => {
      active = false;
      stop();
    };
  }, []);

  const freshness = useMemo(() => (status ? walkerFreshness(status, nowMs) : null), [nowMs, status]);

  if (!visible) return null;
  return (
    <button
      type="button"
      className="portal-launch-card is-experiment is-walker-live"
      onClick={onOpen}
    >
      <span className="portal-launch-top">
        <span className="portal-launch-icon">
          <Activity size={20} />
        </span>
        {failed ? (
          <span className="portal-experiment-progress is-failed" title="The portal could not check Walker status. This is not evidence that the sensors are offline.">
            <AlertTriangle size={12} />
            Check failed
          </span>
        ) : freshness ? (
          <FreshnessPill freshness={freshness} compact />
        ) : null}
      </span>
      <span className="portal-launch-copy">
        <span className="portal-launch-title">Walker Pi 5 Observation</span>
        <strong>
          {loading && !status
            ? "Checking sensor access..."
            : status
              ? `${status.current_sensor_count} / ${status.expected_sensor_count} sensors current`
              : "Sensor status unavailable"}
        </strong>
        <em>VWC · sensing only</em>
        <em>
          {freshness ? <LatestReadingText freshness={freshness} emptyText="No live readings yet" /> : failed ? "Open to retry" : null}
        </em>
      </span>
    </button>
  );
}
