import { ArrowRight } from "lucide-react";

export type WebsiteAnalyticsSummaryData = {
  status: "ready" | "setup" | "collecting" | "unavailable";
  dashboardUrl: string | null;
  visitors?: number;
  demoClicks?: number;
  quoteClicks?: number;
  inquiries?: number;
  inquirySource?: "server" | "analytics";
  demoInteractionSessions?: number;
  days?: { date: string; visitors: number }[];
  updatedAt?: string | null;
  stale?: boolean;
};

/** Shared by the live tile and the offline design preview. Does not fetch data. */
export function WebsiteAnalyticsSummary({ summary, failed = false, onOpen }: {
  summary: WebsiteAnalyticsSummaryData | null;
  failed?: boolean;
  onOpen: () => void;
}) {
  const ready = summary?.status === "ready";
  const days = summary?.days ?? [];
  const peak = Math.max(2, ...days.map(day => day.visitors));
  const points = days.map((day, index) => `${4 + index * 192 / Math.max(1, days.length - 1)},${54 - day.visitors / peak * 46}`);
  const status = failed || summary?.status === "unavailable" ? "Traffic unavailable" : summary?.status === "setup" ? "Connection pending" : summary ? "Collecting traffic" : "Loading traffic…";
  const metrics = [
    { label: "Unique visitors", value: summary?.visitors },
    { label: "Demo sessions", value: summary?.demoInteractionSessions },
    { label: "Quote clicks", value: summary?.quoteClicks },
    { label: summary?.inquirySource === "server" ? "Accepted inquiries" : "Inquiries", value: summary?.inquiries },
  ];
  return <button type="button" className="website-analytics-summary" onClick={onOpen} aria-label="Open website analytics">
    <span className="website-analytics-intro">
      <span className="website-analytics-title">Website analytics</span>
      <span className="website-analytics-period-label" title="Reports refresh every five minutes. Each browser counts once in the total and once on each day it visits.">
        Last 7 days{summary?.stale || (failed && ready) ? " · delayed" : ""}
        {summary?.updatedAt && Number.isFinite(Date.parse(summary.updatedAt)) ? <><br />Updated <time dateTime={summary.updatedAt}>{new Date(summary.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></> : null}
      </span>
    </span>
    {ready ? <>
      <span className="website-analytics-basic-stats">
        {metrics.map(metric => <span className="website-analytics-basic-stat" key={metric.label}>
          <strong>{metric.value == null ? "—" : metric.value.toLocaleString()}</strong>
          <span title={metric.label === "Demo sessions" ? "Sessions that interacted with the embedded demo on Applications." : undefined}>{metric.label}</span>
        </span>)}
      </span>
      <span className="website-analytics-trend">
        {days.length ? <svg viewBox="0 0 200 60" role="img" aria-label={`Daily visitors, last 7 days: ${days.map(day => `${day.date}: ${day.visitors}`).join(", ")}`}>
          <path d="M4 54H196" stroke="currentColor" opacity=".12" />
          <polygon points={`4,54 ${points.join(" ")} ${days.length > 1 ? 196 : 4},54`} fill="currentColor" opacity=".08" />
          <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {days.map((day, index) => <circle key={day.date} cx={4 + index * 192 / Math.max(1, days.length - 1)} cy={54 - day.visitors / peak * 46} r="2.4" fill="currentColor"><title>{day.date}: {day.visitors} visitors</title></circle>)}
        </svg> : <span className="website-analytics-period-label">No daily data</span>}
      </span>
    </> : <span className="website-analytics-status" role="status">{status}</span>}
    <ArrowRight className="website-analytics-open" size={18} aria-hidden="true" />
  </button>;
}
