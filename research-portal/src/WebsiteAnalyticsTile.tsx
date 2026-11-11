import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { scheduleVisiblePolling } from "./visiblePolling";
import { WebsiteAnalyticsSummary, type WebsiteAnalyticsSummaryData as Summary } from "./WebsiteAnalyticsSummary";
import { withSupabaseTimeout } from "./supabaseTimeout";

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
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const [excluded, setExcluded] = useState(() => {
    try { return localStorage.getItem(exclusionKey) !== "0"; } catch { return true; }
  });
  const [preferenceError, setPreferenceError] = useState(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setRefreshing(true);
    try {
      const { data, error } = await withSupabaseTimeout(
        signal => supabase.functions.invoke<Summary>("website-analytics", { body: {}, signal }),
        30_000, "Website analytics",
      );
      if (error || !data?.status) throw error ?? new Error("Analytics unavailable");
      if (mounted.current) { setSummary(data); setFailed(false); }
    } catch { if (mounted.current) setFailed(true); }
    finally { pending.current = false; if (mounted.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    // Admins default to excluded, with an explicit per-browser override for checking collection.
    try { if (isAdminPortalWindow() && localStorage.getItem(exclusionKey) === null) localStorage.setItem(exclusionKey, "1"); }
    catch { setPreferenceError(true); }
    void refresh();
    // Each read is an Edge invocation and the server caches for five minutes,
    // so match that cadence while visible.
    const stop = scheduleVisiblePolling(refresh, 5 * 60_000);
    return () => { mounted.current = false; stop(); };
  }, [refresh]);
  function toggleExclusion() {
    try { localStorage.setItem(exclusionKey, excluded ? "0" : "1"); setExcluded(!excluded); setPreferenceError(false); }
    catch { setPreferenceError(true); }
  }
  return <div className="portal-launch-card is-website-analytics">
    <WebsiteAnalyticsSummary summary={summary} failed={failed} onOpen={onOpen} />
    <div className="website-analytics-actions">
      <button type="button" className="website-metrics-exclusion" onClick={toggleExclusion} aria-pressed={excluded} title="Your visits in this browser are excluded when this is on. Other visitors are still counted.">{preferenceError ? "Browser preference unavailable" : excluded ? "This browser excluded" : "This browser included"}</button>
      <button type="button" className="website-analytics-refresh" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh website analytics">{refreshing ? "Refreshing…" : "Refresh"}</button>
    </div>
  </div>;
}
