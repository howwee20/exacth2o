import { useEffect, useState } from "react";
import { ArrowRight, ChartNoAxesCombined } from "lucide-react";
import { supabase } from "./supabase";
import { scheduleVisiblePolling } from "./visiblePolling";

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

type Summary = {
  status: "ready" | "setup" | "collecting" | "unavailable";
  dashboardUrl: string | null;
  visitors?: number;
  demoClicks?: number;
  quoteClicks?: number;
  inquiries?: number;
  /** "server" when inquiries are accepted quote requests from server records. */
  inquirySource?: "server" | "analytics";
  demoInteractionSessions?: number;
  days?: { date: string; visitors: number }[];
  updatedAt?: string | null;
  stale?: boolean;
};

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
    // Once a minute while visible; the server caches for five minutes.
    const stop = scheduleVisiblePolling(refresh, 60_000);
    return () => { active = false; stop(); };
  }, []);
  function toggleExclusion() {
    try { localStorage.setItem(exclusionKey, excluded ? "0" : "1"); setExcluded(!excluded); setPreferenceError(false); }
    catch { setPreferenceError(true); }
  }
  const ready = summary?.status === "ready";
  const days = summary?.days ?? [];
  const peak = Math.max(2, ...days.map((day) => day.visitors));
  const points = days.map((day, index) => `${4 + index * 192 / Math.max(1, days.length - 1)},${43 - day.visitors / peak * 35}`);
  const status = failed ? "Traffic unavailable" : summary?.status === "setup" ? "Connection pending" : summary?.status === "unavailable" ? "Traffic unavailable" : "Collecting traffic";
  const inquiryLabel = summary?.inquirySource === "server" ? "accepted inquiries" : "inquiries";
  return <div className="portal-launch-card is-website-analytics">
    <button type="button" className="website-metrics-link" onClick={onOpen} title="Open Web Analytics">
      <span className="website-metrics-heading"><span className="portal-launch-title">Web Analytics</span><ChartNoAxesCombined size={17} aria-hidden="true" /></span>
      {ready ? <>
        <span className="website-metrics-counts"><span><b>{summary.visitors ?? 0}</b> visitors</span><span><b>{summary.inquiries ?? 0}</b> {inquiryLabel}</span></span>
        <span className="website-metrics-actions">{summary.quoteClicks ?? 0} quote clicks <span aria-hidden="true">·</span> {summary.demoClicks ?? 0} demo link clicks{summary.demoInteractionSessions ? <> <span aria-hidden="true">·</span> {summary.demoInteractionSessions} demo sessions</> : null}</span>
        <svg viewBox="0 0 200 48" className="website-metrics-chart" role="img" aria-label={`Daily visitors, last 7 days: ${days.map((day) => `${day.date}: ${day.visitors}`).join(", ")}`}>
          <path d="M4 43H196" stroke="currentColor" opacity=".12" />
          {points.length > 0 && <><polygon points={`4,43 ${points.join(" ")} 196,43`} fill="currentColor" opacity=".10" /><polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />{days.map((day, index) => <circle key={day.date} cx={4 + index * 192 / Math.max(1, days.length - 1)} cy={43 - day.visitors / peak * 35} r="2.4" fill="currentColor"><title>{day.date}: {day.visitors} visitors</title></circle>)}</>}
        </svg>
      </> : <span className="website-metrics-empty">{!summary && !failed ? "Loading traffic…" : status}</span>}
      <span className="website-metrics-footer"><span>Last 7 days{summary?.stale || (failed && ready) ? " · delayed" : ""}</span><span>View analytics <ArrowRight size={12} /></span></span>
    </button>
    <button type="button" className="website-metrics-exclusion" onClick={toggleExclusion} aria-pressed={excluded} title="Applies only to this browser. Campus and shared IP addresses are never excluded.">{preferenceError ? "Browser preference unavailable" : excluded ? "This browser excluded" : "This browser included"}</button>
  </div>;
}
