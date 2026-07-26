import { Activity, AlertTriangle, Clock3 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  isWalkerAccessDenied,
  type WalkerLiveStatus,
} from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";

function freshnessLabel(status?: WalkerLiveStatus | null) {
  if (!status) return "Checking live telemetry";
  if (status.freshness === "live") return "Live";
  if (status.freshness === "delayed") return "Delayed";
  if (status.freshness === "stale") return "Stale";
  return "Awaiting publisher";
}

function lastReadingLabel(value?: string | null) {
  if (!value) return "No live readings yet";
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))}`;
}

export function WalkerAdminTile({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<WalkerLiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    loadWalkerLiveStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch((error: { code?: string; message?: string }) => {
        if (!active) return;
        if (isWalkerAccessDenied(error)) setVisible(false);
        else setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!visible) return null;
  return (
    <button
      type="button"
      className="portal-launch-card is-experiment is-observation"
      onClick={onOpen}
    >
      <span className="portal-launch-top">
        <span className="portal-launch-icon">
          <Activity size={20} />
        </span>
        <span className={`portal-experiment-progress ${failed ? "is-failed" : "is-running"}`}>
          {failed ? <AlertTriangle size={12} /> : <Clock3 size={12} />}
          {failed ? "Unavailable" : freshnessLabel(status)}
        </span>
      </span>
      <span className="portal-launch-copy">
        <span className="portal-launch-title">Walker Pi 5</span>
        <strong>
          {loading
            ? "Checking sensor access..."
            : `${status?.evidenced_sensor_count ?? 96} / ${status?.expected_sensor_count ?? 100} sensors`}
        </strong>
        <em>72-hour VWC observation</em>
        <em>{failed ? "Open to retry" : lastReadingLabel(status?.latest_live_reading_at)}</em>
      </span>
    </button>
  );
}
