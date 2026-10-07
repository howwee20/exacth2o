import { useEffect, useState } from "react";

/**
 * Wall-clock time for judging how old measurements are ("4 min ago", current/delayed/stale).
 * It advances every `tickMs` while the page is visible and immediately on return, independently
 * of whether any data request succeeds: a failing request must not freeze a reading's age.
 */
export function usePageClock(tickMs = 30_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    };
    const intervalId = window.setInterval(tick, tickMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [tickMs]);
  return nowMs;
}
