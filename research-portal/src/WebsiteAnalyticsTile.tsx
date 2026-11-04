import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { scheduleVisiblePolling } from "./visiblePolling";
import { WebsiteAnalyticsSummary, type WebsiteAnalyticsSummaryData as Summary } from "./WebsiteAnalyticsSummary";

// Shared with the public tracker (site-metrics.js); see the note there on the v2 key.
const exclusionKey = "exacth2o.analytics.excluded.v2";

/** Only the signed-in, top-level portal may exclude a browser by default, never an embedded or demo copy. */
function isAdminPortalWindow() {
  try {
    return window.self === window.top && /^\/portal(?:\.html)?(?:\/|$)/.test(window.location.pathname);
  } catch {
    return false;
  }
}

/** Home tile: the last seven days at a glance. The full workspace opens from it. */
export function WebsiteAnalyticsTile({ onOpen }: { onOpen: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [excluded, setExcluded] = useState(() => {
    try { return localStorage.getItem(exclusionKey) !== "0"; } catch { return true; }
  });
  const [preferenceError, setPreferenceError] = useState(false);
  useEffect(() => {
    // Admins default to excluded, with an explicit per-browser override for checking collection.
    try { if (isAdminPortalWindow() && localStorage.getItem(exclusionKey) === null) localStorage.setItem(exclusionKey, "1"); }
    catch { setPreferenceError(true); }
    let active = true;
    const refresh = async () => {
      try {
        const { data, error } = await supabase.functions.invoke<Summary>("website-analytics", { body: {} });
        if (error || !data?.status) throw error ?? new Error("Analytics unavailable");
        if (active) { setSummary(data); setFailed(false); }
      } catch { if (active) setFailed(true); }
    };
    void refresh();
    // Each read is an Edge invocation and the server caches for five minutes,
    // so match that cadence while visible.
    const stop = scheduleVisiblePolling(refresh, 5 * 60_000);
    return () => { active = false; stop(); };
  }, []);
  function toggleExclusion() {
    try { localStorage.setItem(exclusionKey, excluded ? "0" : "1"); setExcluded(!excluded); setPreferenceError(false); }
    catch { setPreferenceError(true); }
  }
  return <div className="portal-launch-card is-website-analytics">
    <WebsiteAnalyticsSummary summary={summary} failed={failed} onOpen={onOpen} />
    <button type="button" className="website-metrics-exclusion" onClick={toggleExclusion} aria-pressed={excluded} title="Applies only to this browser. Campus and shared IP addresses are never excluded.">{preferenceError ? "Browser preference unavailable" : excluded ? "This browser excluded" : "This browser included"}</button>
  </div>;
}
