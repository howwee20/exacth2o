import { useEffect, useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined } from "lucide-react";
import { supabase } from "./supabase";

const exclusionKey = "exacth2o.analytics.excluded";
type Summary = {
  status: "ready" | "setup" | "collecting" | "unavailable";
  dashboardUrl: string | null;
  visitors?: number;
  demoClicks?: number;
  quoteClicks?: number;
  inquiries?: number;
  days?: { date: string; visitors: number }[];
  updatedAt?: string | null;
  stale?: boolean;
};

export function WebsiteAnalyticsTile() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [excluded, setExcluded] = useState(() => {
    try { return localStorage.getItem(exclusionKey) !== "0"; } catch { return true; }
  });
  const [preferenceError, setPreferenceError] = useState(false);
  useEffect(() => {
    // Admins default to excluded, with an explicit per-browser override for checking collection.
    try { if (localStorage.getItem(exclusionKey) === null) localStorage.setItem(exclusionKey, "1"); }
    catch { setPreferenceError(true); }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const { data, error } = await supabase.functions.invoke<Summary>("website-analytics", { body: {} });
        if (error || !data?.status) throw error ?? new Error("Analytics unavailable");
        if (active) { setSummary(data); setFailed(false); }
      } catch { if (active) setFailed(true); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
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
  const updated = summary?.updatedAt ? new Date(summary.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const content = <>
    <span className="website-metrics-heading"><span className="portal-launch-title">Web Analytics</span><ChartNoAxesCombined size={17} aria-hidden="true" /></span>
    {ready ? <>
      <span className="website-metrics-counts"><span><b>{summary.visitors ?? 0}</b> visitors</span><span><b>{summary.demoClicks ?? 0}</b> demo clicks</span></span>
      <span className="website-metrics-actions">{summary.quoteClicks ?? 0} quote clicks <span aria-hidden="true">·</span> {summary.inquiries ?? 0} inquiries</span>
      <svg viewBox="0 0 200 48" className="website-metrics-chart" role="img" aria-label={`Daily visitors, last 7 days: ${days.map((day) => `${day.date}: ${day.visitors}`).join(", ")}`}>
        <path d="M4 43H196" stroke="currentColor" opacity=".12" />
        {points.length > 0 && <><polygon points={`4,43 ${points.join(" ")} 196,43`} fill="currentColor" opacity=".10" /><polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />{days.map((day, index) => <circle key={day.date} cx={4 + index * 192 / Math.max(1, days.length - 1)} cy={43 - day.visitors / peak * 35} r="2.4" fill="currentColor"><title>{day.date}: {day.visitors} visitors</title></circle>)}</>}
      </svg>
    </> : <span className="website-metrics-empty">{!summary && !failed ? "Loading traffic…" : status}</span>}
    <span className="website-metrics-footer"><span>Last 7 days{summary?.stale || failed && ready ? " · delayed" : ""}</span>{summary?.dashboardUrl ? <span>PostHog <ArrowUpRight size={12} /></span> : null}</span>
  </>;
  // Never render the API-provided URL unless it is the expected authenticated dashboard.
  const dashboard = summary?.dashboardUrl && /^https:\/\/(us|eu)\.posthog\.com\/project\/\d+\/web$/.test(summary.dashboardUrl) ? summary.dashboardUrl : null;
  return <div className="portal-launch-card is-website-analytics">
    {dashboard ? <a className="website-metrics-link" href={dashboard} target="_blank" rel="noopener noreferrer" title={updated ? `Updated ${updated}. Opens PostHog in a new tab.` : "Open PostHog"}>{content}</a> : <div className="website-metrics-link">{content}</div>}
    <button type="button" className="website-metrics-exclusion" onClick={toggleExclusion} aria-pressed={excluded} title="Applies only to this browser. Campus and shared IP addresses are never excluded.">{preferenceError ? "Browser preference unavailable" : excluded ? "This browser excluded" : "This browser included"}</button>
  </div>;
}
