import { Activity, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import {
  isWalkerAccessDenied,
  type WalkerLiveStatus,
} from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";

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
    const refresh = () => {
      loadWalkerLiveStatus()
        .then((nextStatus) => {
          if (!active) return;
          setStatus(nextStatus);
          setFailed(false);
        })
        .catch((error: { code?: string; message?: string }) => {
          if (!active) return;
          if (isWalkerAccessDenied(error)) {
            setVisible(false);
          } else {
            setFailed(true);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

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
          <span className="portal-experiment-progress is-failed">
            <AlertTriangle size={12} />
            Unavailable
          </span>
        ) : null}
      </span>
      <span className="portal-launch-copy">
        <span className="portal-launch-title">Walker Pi 5 Observation</span>
        <strong>
          {loading
            ? "Checking sensor access..."
            : `${status?.evidenced_sensor_count ?? 96} / ${status?.expected_sensor_count ?? 100} sensors`}
        </strong>
        <em>Live VWC · sensing only</em>
        <em>{failed ? "Open to retry" : lastReadingLabel(status?.latest_live_reading_at)}</em>
      </span>
    </button>
  );
}
