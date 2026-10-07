import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ChartNoAxesCombined } from "lucide-react";
import { supabase } from "./supabase";

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
  days?: { date: string; visitors: number }[];
  updatedAt?: string | null;
  stale?: boolean;
};

export function WebsiteAnalyticsTile({ onOpen, onBack }: { onOpen?: () => void; onBack?: () => void }) {
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
    <span className="website-metrics-footer"><span>Last 7 days{summary?.stale || failed && ready ? " · delayed" : ""}</span><span>View analytics <ArrowRight size={12} /></span></span>
  </>;
  const exclusionControl = <button type="button" className="website-metrics-exclusion" onClick={toggleExclusion} aria-pressed={excluded} title="Applies only to this browser. Campus and shared IP addresses are never excluded.">{preferenceError ? "Browser preference unavailable" : excluded ? "This browser excluded" : "This browser included"}</button>;
  if (onBack) {
    const labelDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
    return <section className="sales-support-main website-analytics-page" aria-label="Web Analytics">
      <button type="button" className="support-back-button" onClick={onBack}><ArrowLeft size={15} />Home</button>
      <header className="support-hero"><div><p>ExactH2O website</p><h1>Web Analytics</h1></div><span className="website-analytics-period">Last 7 days · Eastern time</span></header>
      {(failed || summary?.stale) && <div className="banner error" role="status">{ready ? "Showing the last available data. Updates are temporarily delayed." : "Traffic is temporarily unavailable. This page retries automatically."}</div>}
      {ready ? <>
        <div className="website-analytics-stats">
          {[{ label: "Visitors", value: summary.visitors, note: "Unique browsers across the week" }, { label: "Demo clicks", value: summary.demoClicks, note: "Clicks into the product demo" }, { label: "Quote clicks", value: summary.quoteClicks, note: "Clicks to request a quote" }, { label: "Inquiries", value: summary.inquiries, note: "Successfully submitted quote forms" }].map(metric => <article key={metric.label}><p>{metric.label}</p><strong>{metric.value ?? 0}</strong><small>{metric.note}</small></article>)}
        </div>
        <section className="website-analytics-panel" aria-labelledby="traffic-title">
          <div className="website-analytics-panel-heading"><h2 id="traffic-title">Daily visitors</h2><span>{updated ? `Updated ${updated}` : "Waiting for data"}</span></div>
          <svg viewBox="0 0 700 220" className="website-analytics-full-chart" role="img" aria-label={`Daily visitors: ${days.map(day => `${day.date}: ${day.visitors}`).join(", ")}`}>
            {[0, 1, 2].map(tick => <g key={tick}><line x1="40" x2="670" y1={180 - tick * 75} y2={180 - tick * 75} stroke="currentColor" opacity=".12" /><text x="28" y={185 - tick * 75} textAnchor="end">{Math.ceil(peak / 2) * tick}</text></g>)}
            <polyline points={days.map((day, index) => `${40 + index * 630 / Math.max(1, days.length - 1)},${180 - day.visitors / (Math.ceil(peak / 2) * 2) * 150}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
            {days.map((day, index) => <g key={day.date}><circle cx={40 + index * 630 / Math.max(1, days.length - 1)} cy={180 - day.visitors / (Math.ceil(peak / 2) * 2) * 150} r="4" fill="currentColor"><title>{labelDate(day.date)}: {day.visitors} visitors</title></circle><text x={40 + index * 630 / Math.max(1, days.length - 1)} y="210" textAnchor="middle">{labelDate(day.date)}</text></g>)}
          </svg>
          {(summary.visitors ?? 0) === 0 && <p className="website-analytics-note">No visitors recorded yet. New visits will appear here as traffic arrives.</p>}
          <details><summary>Daily counts</summary><table><thead><tr><th>Date</th><th>Visitors</th></tr></thead><tbody>{days.map(day => <tr key={day.date}><td>{labelDate(day.date)}</td><td>{day.visitors}</td></tr>)}</tbody></table></details>
        </section>
      </> : !failed && <section className="website-analytics-panel" role="status"><h2>{!summary ? "Loading traffic…" : status}</h2><p>Website traffic and inquiry activity will appear here when available.</p></section>}
      <footer className="website-analytics-panel website-analytics-preferences"><div><h2>Your browser</h2><p>Exclude your own visits while working on the site. This preference applies only to this browser.</p>{exclusionControl}</div><p className="website-analytics-note">Updates about every five minutes. Visitors are estimated from browsers; demo and quote clicks are actions, not completed inquiries.</p></footer>
    </section>;
  }
  return <div className="portal-launch-card is-website-analytics">
    <button type="button" className="website-metrics-link" onClick={onOpen} title="Open Web Analytics">{content}</button>
    {exclusionControl}
  </div>;
}
