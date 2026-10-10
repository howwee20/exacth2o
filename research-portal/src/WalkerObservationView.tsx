import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { scheduleVisiblePolling } from "./visiblePolling";
import {
  isWalkerAccessDenied,
  type WalkerLiveStatus,
} from "./walkerObservation";
import { loadWalkerLiveStatus } from "./walkerObservationClient";

const walkerStatusPollMs = 60_000;

export function WalkerMachineTile({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<WalkerLiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);

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


  if (!visible) return null;
  return (
    <button
      type="button"
      className="px-machine-card"
      onClick={onOpen}
    >
        <span className="px-exp-name">Walker Pi 5 Observation</span>
        <span className="px-exp-count">
          {loading && !status
            ? "Checking sensor access..."
            : status
              ? `${status.expected_sensor_count} sensors`
              : "Sensor status unavailable"}
        </span>
        <span className="px-exp-mode">VWC · sensing only</span>
        {failed ? <span className="px-machine-error" title="The portal could not check Walker status. Open the machine to retry."><AlertTriangle size={12} />Check failed</span> : null}
    </button>
  );
}
