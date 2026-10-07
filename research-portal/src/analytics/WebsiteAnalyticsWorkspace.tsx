import { AlertTriangle, ArrowLeft, Copy, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scheduleVisiblePolling } from "../visiblePolling";
import {
  type AnalyticsDevice,
  type AnalyticsRange,
  type AnalyticsReportName,
  fetchReport,
  preferReport,
  ReportCache,
  type ReportEnvelope,
  reportKey,
} from "../websiteAnalyticsClient";
import {
  campaignPages,
  campaignUrl,
  collectionStartDate,
  formatCount,
  formatDay,
  formatMs,
  formatRange,
  formatShare,
  minPercentileSamples,
  rateVital,
} from "./analyticsFormat";
import {
  AnalyticsSection,
  DailyChart,
  Funnel,
  KeyValueTable,
  OutcomeTable,
  StatCard,
} from "./AnalyticsParts";
import {
  type AcquisitionData,
  type DemoData,
  type ExperienceData,
  type JourneysData,
  type OverviewData,
  type QualityData,
  type QuoteData,
} from "./analyticsTypes";

// Shared with the public tracker (site-metrics.js) and the home tile.
const exclusionKey = "exacth2o.analytics.excluded.v2";
const refreshMs = 60_000;

const tabs: Array<{ id: AnalyticsReportName; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "acquisition", label: "Acquisition" },
  { id: "journeys", label: "Journeys" },
  { id: "demo", label: "Demo" },
  { id: "quote", label: "Quote form" },
  { id: "experience", label: "Site experience" },
  { id: "quality", label: "Data quality" },
];

const reportCache = new ReportCache();

function todayInDetroit() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/**
 * One report, fetched only while its tab is open. An answer is shown only if it is for the
 * selection on screen, and never replaces a stored report with an empty or older one; "Refreshing"
 * lasts exactly as long as a request for this selection is in flight.
 */
function useReport<T>(report: AnalyticsReportName, range: AnalyticsRange, device: AnalyticsDevice) {
  const key = reportKey(report, range, device);
  const [state, setState] = useState<{ key: string; data: ReportEnvelope<T> | null; loading: boolean; error: string | null }>(
    () => ({ key, data: reportCache.peek(key) as ReportEnvelope<T> | null, loading: false, error: null }),
  );
  const keyRef = useRef(key);
  const pending = useRef(new Map<string, number>());
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const load = useCallback(async (force = false) => {
    const fresh = reportCache.get(key);
    if (fresh && !force) {
      setState({ key, data: fresh as ReportEnvelope<T>, loading: false, error: null });
      return;
    }
    const inFlight = pending.current;
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    const settle = () => {
      const remaining = (inFlight.get(key) ?? 1) - 1;
      if (remaining > 0) inFlight.set(key, remaining);
      else inFlight.delete(key);
      return remaining > 0;
    };
    setState((current) => ({ key, data: (current.key === key ? current.data : null) ?? (reportCache.peek(key) as ReportEnvelope<T> | null), loading: true, error: null }));
    try {
      const data = await fetchReport<T>(report, range, device);
      // Only stored reports are cached; a "collecting" answer is asked again next time.
      if (data.status === "ready" && !data.partial) reportCache.set(key, preferReport(reportCache.peek(key) as ReportEnvelope<T> | null, data));
      const stillLoading = settle();
      if (keyRef.current !== key) return;
      setState((current) => ({
        key,
        data: preferReport(current.key === key ? current.data : null, data),
        loading: stillLoading,
        error: null,
      }));
    } catch {
      const stillLoading = settle();
      if (keyRef.current !== key) return;
      setState((current) => ({ ...current, key, loading: stillLoading, error: "The analytics service did not respond. Showing the last loaded results, if any." }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    void load();
    return scheduleVisiblePolling(() => load(true), refreshMs);
  }, [load]);

  const current = state.key === key ? state : { key, data: reportCache.peek(key) as ReportEnvelope<T> | null, loading: true, error: null };
  return { ...current, reload: () => load(true) };
}

function ReportFrame<T>({
  result,
  children,
}: {
  result: { data: ReportEnvelope<T> | null; loading: boolean; error: string | null; reload: () => void };
  children: (data: ReportEnvelope<T> & T) => ReactNode;
}) {
  const { data, loading, error, reload } = result;
  const updated = data?.updatedAt ? new Date(data.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : null;
  return (
    <div className="analytics-report" aria-busy={loading}>
      <div className="analytics-report-status" role="status" aria-live="polite">
        {loading ? <span><Loader2 size={13} className="chart-loading-spinner" aria-hidden="true" /> {data ? "Refreshing…" : "Loading report…"}</span> : null}
        {!loading && updated ? <span>Report computed {updated}{data?.stale ? " · delayed: showing the last successful refresh" : ""}{data?.partial ? " · incomplete: part of this report could not be computed" : ""}</span> : null}
        <button type="button" className="analytics-refresh" onClick={reload} disabled={loading}>
          <RefreshCw size={13} aria-hidden="true" />
          Refresh
        </button>
      </div>
      {error ? <div className="banner error" role="alert"><AlertTriangle size={16} />{error}</div> : null}
      {data?.status === "setup" ? <p className="analytics-empty">The analytics connection is not configured on the server yet.</p> : null}
      {data?.status === "unavailable" ? (
        <p className="analytics-empty">This report could not be computed{data.failure ? ` (${data.failure})` : ""}. Other reports may still work; it retries automatically.</p>
      ) : null}
      {data?.status === "collecting" ? <p className="analytics-empty">No results have been stored for this selection yet. Another refresh may be running; this view checks again automatically.</p> : null}
      {data?.status === "ready" ? children(data as ReportEnvelope<T> & T) : null}
    </div>
  );
}

function rangeLabel(data: { range?: ReportEnvelope<unknown>["range"] }) {
  const range = data.range;
  if (!range) return "";
  return `${formatRange(range.start, range.end)} · ${range.days} days${range.includesToday ? ", today so far" : ""} · Eastern Time`;
}

function previousNote(data: { range?: ReportEnvelope<unknown>["range"] }) {
  const range = data.range;
  if (!range) return null;
  if (range.previousStart < collectionStartDate) {
    return `Comparisons are off: the previous ${range.days} days begin before collection started on ${formatDay(collectionStartDate, { month: "short", day: "numeric", year: "numeric" })}.`;
  }
  return `Compared with ${formatRange(range.previousStart, range.previousEnd)}${range.includesToday ? " up to the same time of day" : ""}.`;
}

function OverviewView({ range, device }: { range: AnalyticsRange; device: AnalyticsDevice }) {
  const result = useReport<OverviewData>("overview", range, device);
  return (
    <ReportFrame result={result}>
      {(data) => {
        const previousStart = data.range?.previousStart;
        const sessions = data.sessions.value;
        const accepted = data.acceptedInquiries;
        return (
          <>
            <p className="analytics-range-line">{rangeLabel(data)}. {previousNote(data)}</p>
            <div className="analytics-stats">
              <StatCard label="Visitors" metric={data.visitors} previousStart={previousStart} detail="Distinct browsers (not people)" />
              <StatCard label="Sessions" metric={data.sessions} previousStart={previousStart} detail="Visits; a new one starts after 30 min idle" />
              <StatCard label="Page views" metric={data.pageviews} previousStart={previousStart} />
              <StatCard label="Engaged sessions" metric={data.engagedSessions} previousStart={previousStart} detail={formatShare(data.engagedSessions.value, sessions)} />
              <StatCard label="Reached the quote page" metric={data.quotePageSessions} previousStart={previousStart} detail={formatShare(data.quotePageSessions.value, sessions)} />
              <StatCard
                label="Accepted inquiries"
                emphasis
                metric={accepted ?? data.analyticsInquiries}
                previousStart={previousStart}
                detail={accepted
                  ? `Server records · analytics observed ${formatCount(data.analyticsInquiries.value)}`
                  : device !== "all"
                    ? "Analytics only: server records have no device type"
                    : "Analytics only: server records unavailable"}
              />
            </div>
            <AnalyticsSection title="Daily traffic" description="Bars are visitors and sessions per Eastern Time day; dots mark accepted inquiries from server records.">
              <DailyChart days={data.days} />
              <details className="analytics-details">
                <summary>Daily counts</summary>
                <KeyValueTable
                csvName="daily"
                headers={["Date", "Visitors", "Sessions", "Page views", "Accepted inquiries (server)", "Quote accepted (analytics)"]}
                rows={data.days.map((day) => [`${day.date}${day.partial ? " (partial)" : ""}`, day.visitors, day.sessions, day.pageviews, day.acceptedInquiries ?? "—", day.inquiries])}
                empty="No days in range."
                />
              </details>
            </AnalyticsSection>
            <AnalyticsSection title="Actions" description="Event and session counts in the selected range.">
              <div className="analytics-stats is-compact">
                <StatCard label="Demo link clicks" metric={data.demoClicks} previousStart={previousStart} detail="Links to the standalone /demo" />
                <StatCard label="Sessions using the embedded demo" metric={data.demoInteractionSessions} previousStart={previousStart} detail="Recorded since the instrumentation release" />
                <StatCard label="Quote link clicks" metric={data.quoteClicks} previousStart={previousStart} />
                <StatCard label="Sessions starting the quote form" metric={data.formStartSessions} previousStart={previousStart} detail="Recorded since the instrumentation release" />
              </div>
            </AnalyticsSection>
          </>
        );
      }}
    </ReportFrame>
  );
}

function CampaignLinkBuilder() {
  const [page, setPage] = useState("/");
  const [source, setSource] = useState("");
  const [medium, setMedium] = useState("");
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const [copied, setCopied] = useState(false);
  const url = campaignUrl({ page, source, medium, campaign, content });
  const complete = Boolean(source.trim() && medium.trim() && campaign.trim());
  return (
    <form className="analytics-builder" onSubmit={(event) => event.preventDefault()}>
      <label>Page
        <select value={page} onChange={(event) => setPage(event.target.value)}>
          {campaignPages.map(([path, label]) => <option key={path} value={path}>{label}</option>)}
        </select>
      </label>
      <label>Source<input value={source} onChange={(event) => setSource(event.target.value)} placeholder="newsletter" maxLength={60} /></label>
      <label>Medium<input value={medium} onChange={(event) => setMedium(event.target.value)} placeholder="email" maxLength={60} /></label>
      <label>Campaign<input value={campaign} onChange={(event) => setCampaign(event.target.value)} placeholder="fall-trials" maxLength={60} /></label>
      <label>Content (optional)<input value={content} onChange={(event) => setContent(event.target.value)} placeholder="header-link" maxLength={60} /></label>
      <output aria-live="polite">{url}</output>
      <button
        type="button"
        disabled={!complete}
        title={complete ? "Copy link" : "Add a source, medium and campaign first"}
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        <Copy size={13} aria-hidden="true" />{copied ? "Copied" : "Copy link"}
      </button>
      {!complete ? <p className="analytics-note">Source, medium and campaign are required for a link that reports cleanly.</p> : null}
    </form>
  );
}

function AcquisitionView({ range, device }: { range: AnalyticsRange; device: AnalyticsDevice }) {
  const result = useReport<AcquisitionData>("acquisition", range, device);
  return (
    <>
      <ReportFrame result={result}>
        {(data) => {
          const label = rangeLabel(data);
          return (
            <>
              <p className="analytics-range-line">{label}. Each session is attributed to how its first page view arrived.</p>
              <AnalyticsSection title="Referring sites" description="'Direct or unknown' includes typed URLs, bookmarks, apps and browsers that hide the referrer.">
                <OutcomeTable rows={data.referrers} keyLabel="Referrer" csvName="referrers" rangeLabel={label} />
              </AnalyticsSection>
              <AnalyticsSection title="Campaigns" description="From utm_source / utm_medium / utm_campaign on the landing URL.">
                <OutcomeTable rows={data.campaigns} keyLabel="Source / medium / campaign" csvName="campaigns" rangeLabel={label} />
                {data.canonicalCampaigns ? (
                  <>
                    <h3 className="analytics-subhead">Accepted inquiries by campaign (server records)</h3>
                    <p className="analytics-note">Tagged only when the visitor submitted the quote form from a tagged URL; campaigns that led to another page first appear as "No campaign tags".</p>
                    <KeyValueTable
                      csvName="campaign-inquiries"
                      headers={["Source / medium / campaign", "Accepted inquiries"]}
                      rows={data.canonicalCampaigns.map((row) => [row.key, row.inquiries])}
                      empty="No accepted inquiries in this range."
                    />
                  </>
                ) : null}
              </AnalyticsSection>
              <AnalyticsSection title="Landing pages">
                <OutcomeTable rows={data.landingPages} keyLabel="First page" csvName="landing-pages" rangeLabel={label} />
              </AnalyticsSection>
              <AnalyticsSection title="Devices" description="Browser-reported device type.">
                <OutcomeTable rows={data.devices} keyLabel="Device" csvName="devices" rangeLabel={label} />
              </AnalyticsSection>
            </>
          );
        }}
      </ReportFrame>
      <AnalyticsSection title="Campaign link builder" description="Create a tagged link for outreach so its visits and inquiries can be attributed.">
        <CampaignLinkBuilder />
      </AnalyticsSection>
    </>
  );
}

function JourneysView({ range, device }: { range: AnalyticsRange; device: AnalyticsDevice }) {
  const result = useReport<JourneysData>("journeys", range, device);
  return (
    <ReportFrame result={result}>
      {(data) => {
        const label = rangeLabel(data);
        const route = data.routes;
        return (
          <>
            <p className="analytics-range-line">{label}. Steps are counted within one session, in order of first occurrence.</p>
            <AnalyticsSection title="Path through the demo" description="Demo steps are recorded only since the instrumentation release; before it, those steps read zero because they were not measured.">
              <Funnel steps={data.demoFunnel} />
            </AnalyticsSection>
            <AnalyticsSection title="Quote form, from any page">
              <Funnel steps={data.quoteFunnel} />
              <div className="analytics-routes">
                <article><p>Entered directly on the quote page</p><strong>{formatCount(route.direct.sessions)}</strong><small>{formatCount(route.direct.inquirySessions)} accepted</small></article>
                <article><p>Reached quote without Applications</p><strong>{formatCount(route.withoutApplications.sessions)}</strong><small>{formatCount(route.withoutApplications.inquirySessions)} accepted</small></article>
                <article><p>Reached quote after Applications</p><strong>{formatCount(route.afterApplications.sessions)}</strong><small>{formatCount(route.afterApplications.inquirySessions)} accepted</small></article>
              </div>
            </AnalyticsSection>
            <AnalyticsSection title="Page before the quote page">
              {data.beforeQuote ? (
                <KeyValueTable csvName="before-quote" headers={["Previous page", "Sessions"]} rows={data.beforeQuote.map((row) => [row.key, row.sessions])} empty="No sessions reached the quote page." />
              ) : (
                <p className="analytics-note">Could not be computed for this range; the rest of this report is unaffected. Try Refresh later.</p>
              )}
            </AnalyticsSection>
            <AnalyticsSection title="Entry pages">
              <OutcomeTable rows={data.entryPages} keyLabel="Entry page" csvName="entry-pages" rangeLabel={label} />
            </AnalyticsSection>
            <AnalyticsSection title="Exit pages" description="Last page viewed in each session.">
              <KeyValueTable csvName="exit-pages" headers={["Exit page", "Sessions", "Single-page sessions"]} rows={data.exitPages.map((row) => [row.key, row.sessions, row.singlePage])} empty="No sessions in this range." />
            </AnalyticsSection>
          </>
        );
      }}
    </ReportFrame>
  );
}

const actionLabels: Record<string, string> = {
  open_experiment: "Opened an experiment",
  open_health: "Opened System Health",
  open_calibration: "Opened the calibration tile",
  navigate_home: "Returned home",
  change_graph_view: "Switched graph view",
  select_pot: "Selected a pot",
  toggle_pot_group: "Toggled a pot group",
  filter_pots: "Filtered pots",
  expand_chart: "Expanded a chart",
  change_time_range: "Changed the time range",
  inspect_chart: "Inspected the chart",
};

function DemoView({ range, device }: { range: AnalyticsRange; device: AnalyticsDevice }) {
  const result = useReport<DemoData>("demo", range, device);
  return (
    <ReportFrame result={result}>
      {(data) => {
        const stages = data.stages;
        return (
          <>
            <p className="analytics-range-line">{rangeLabel(data)}. The embedded demo reports only fixed action names; it sends no readings, values or form contents.</p>
            <AnalyticsSection title="Embedded demo on Applications">
              <Funnel steps={[
                { key: "applications", label: "Sessions viewing Applications", sessions: stages.applications.sessions },
                { key: "viewed", label: "Scrolled the demo into view (1 s)", sessions: stages.viewed.sessions },
                { key: "ready", label: "Demo finished loading", sessions: stages.ready.sessions },
                { key: "interacted", label: "Used the demo deliberately", sessions: stages.interacted.sessions },
              ]} />
              <div className="analytics-routes">
                <article><p>Demo failed to load within 20 s</p><strong>{formatCount(stages.loadFailed.sessions)}</strong><small>sessions</small></article>
                <article>
                  <p>Wait after coming into view</p>
                  <strong>{data.readyWait.samples >= minPercentileSamples ? formatMs(data.readyWait.medianMs) : "—"}</strong>
                  <small>{data.readyWait.samples >= minPercentileSamples ? `median of ${data.readyWait.samples}; 90th percentile ${formatMs(data.readyWait.p90Ms)}` : `${data.readyWait.samples} samples: too few for a median`}</small>
                </article>
                <article><p>Used the demo, then reached quote</p><strong>{formatCount(data.afterInteraction.reachedQuote)}</strong><small>of {formatCount(data.afterInteraction.sessions)} sessions; {formatCount(data.afterInteraction.submitted)} accepted</small></article>
              </div>
            </AnalyticsSection>
            <AnalyticsSection title="Demo actions" description="At most one per action every 3 seconds and 40 per page view.">
              <KeyValueTable
                csvName="demo-actions"
                headers={["Action", "View", "Events", "Sessions"]}
                rows={data.actions.map((row) => [actionLabels[row.action] ?? row.action, row.view ?? "", row.events, row.sessions])}
                empty="No demo interactions recorded in this range."
              />
            </AnalyticsSection>
            <AnalyticsSection title="Links to the standalone demo" description="Clicks on /demo links by position on the page. Use inside /demo itself is not measured: that page allows no network connections.">
              <KeyValueTable csvName="demo-links" headers={["Placement", "Clicks", "Sessions"]} rows={data.demoLinks.map((row) => [row.placement, row.events, row.sessions])} empty="No demo link clicks in this range." />
            </AnalyticsSection>
          </>
        );
      }}
    </ReportFrame>
  );
}

const issueLabels: Record<string, string> = {
  missing: "left blank",
  invalid_format: "not in the expected format",
};

function QuoteView({ range, device }: { range: AnalyticsRange; device: AnalyticsDevice }) {
  const result = useReport<QuoteData>("quote", range, device);
  return (
    <ReportFrame result={result}>
      {(data) => {
        const steps = data.steps;
        const accepted = data.acceptedInquiries;
        return (
          <>
            <p className="analytics-range-line">{rangeLabel(data)}. No field contents are ever recorded; only which required field failed and why.</p>
            <AnalyticsSection title="Quote form funnel" description="Sessions for viewing and starting; submissions are counted once each, across retries.">
              <Funnel steps={[
                { key: "page", label: "Opened the quote page", sessions: steps.quotePage.count },
                { key: "viewed", label: "Form came into view", sessions: steps.formViewed.count },
                { key: "started", label: "Started typing or choosing", sessions: steps.formStarted.count },
                { key: "attempted", label: "Pressed submit with a valid form", sessions: steps.submitAttempted.count },
                { key: "accepted", label: "Server accepted the request", sessions: steps.submitted.count },
              ]} />
              <div className="analytics-routes">
                <article><p>Sessions with a validation message</p><strong>{formatCount(steps.validationFailed.count)}</strong><small>{formatCount(steps.validationFailed.events)} messages shown</small></article>
                <article><p>Submissions that failed</p><strong>{formatCount(steps.submitFailed.count)}</strong><small>{formatCount(steps.submitFailed.events)} failed attempts</small></article>
                <article className="is-emphasis">
                  <p>Accepted inquiries (server records)</p>
                  <strong>{accepted ? formatCount(accepted.current) : "—"}</strong>
                  <small>{accepted
                    ? `Analytics observed ${formatCount(steps.submitted.count)}. ${accepted.current > steps.submitted.count ? `${formatCount(accepted.current - steps.submitted.count)} came from browsers analytics cannot see (Do Not Track, blockers, excluded browsers) or before the funnel was instrumented.` : "Analytics and records agree."}`
                    : device !== "all"
                      ? "Not shown with a device filter: server records have no device type, so they cannot be compared with one device's sessions."
                      : "Server records unavailable"}</small>
                </article>
              </div>
            </AnalyticsSection>
            <AnalyticsSection title="Validation messages" description="Field and reason only.">
              <KeyValueTable
                csvName="quote-validation"
                headers={["Field", "Reason", "Times shown"]}
                rows={data.issues.map((row) => {
                  const [field, code] = row.issue.split(":");
                  return [field, issueLabels[code] ?? code, row.events];
                })}
                empty="No validation messages in this range."
              />
            </AnalyticsSection>
            <AnalyticsSection title="Submission failures">
              <KeyValueTable csvName="quote-failures" headers={["Reason", "HTTP class", "Attempts"]} rows={data.failures.map((row) => [row.reason, row.statusClass, row.events])} empty="No failed submissions in this range." />
            </AnalyticsSection>
            <AnalyticsSection title="Quote links by placement">
              <KeyValueTable csvName="quote-links" headers={["Placement", "Clicks", "Sessions"]} rows={data.quoteLinks.map((row) => [row.placement, row.events, row.sessions])} empty="No quote link clicks in this range." />
            </AnalyticsSection>
          </>
        );
      }}
    </ReportFrame>
  );
}

function vitalCell(metric: "lcp" | "inp" | "cls", vital?: { samples: number; p75: number | null }) {
  if (!vital || vital.samples < minPercentileSamples) return `n=${vital?.samples ?? 0}`;
  const rating = rateVital(metric, vital.p75);
  const value = metric === "cls" ? (vital.p75 ?? 0).toFixed(3) : formatMs(vital.p75);
  return `${value} · ${rating} (n=${vital.samples})`;
}

function ExperienceView({ range, device }: { range: AnalyticsRange; device: AnalyticsDevice }) {
  const result = useReport<ExperienceData>("experience", range, device);
  return (
    <ReportFrame result={result}>
      {(data) => (
        <>
          <p className="analytics-range-line">{rangeLabel(data)}. Real visits (field data), one sample per page view. Laboratory measurements are documented separately and are not mixed in here.</p>
          <AnalyticsSection
            title="Core Web Vitals (75th percentile)"
            description={`Percentiles appear only with at least ${minPercentileSamples} samples. Thresholds: LCP 2.5 s / 4 s, INP 200 / 500 ms, CLS 0.1 / 0.25.`}
          >
            <KeyValueTable
              csvName="web-vitals"
              headers={["Page", "Device", "Largest paint (LCP)", "Interaction (INP)", "Layout shift (CLS)"]}
              rows={data.vitals.map((row) => [row.page, row.device === "all" ? "All devices" : row.device, vitalCell("lcp", row.lcp), vitalCell("inp", row.inp), vitalCell("cls", row.cls)])}
              empty="No web-vitals samples yet. They are collected from the instrumentation release onward."
            />
          </AnalyticsSection>
          <AnalyticsSection title="Errors and failures" description="Categories only: no messages, stack traces or URLs are collected.">
            <KeyValueTable
              csvName="errors"
              headers={["Page", "Kind : source : resource", "Events", "Sessions"]}
              rows={data.errors.map((row) => [row.page, row.category.replace(/:$/, ""), row.events, row.sessions])}
              empty="No page errors recorded in this range."
            />
            <KeyValueTable
              csvName="failures"
              headers={["Failure", "Events", "Sessions"]}
              rows={data.failures.map((row) => [row.event === "demo_load_failed" ? "Demo did not load within 20 s" : "Quote submission failed", row.events, row.sessions])}
              empty="No demo load or quote submission failures in this range."
            />
          </AnalyticsSection>
          <AnalyticsSection title="How far visitors read" description="Deepest scroll position on each page view, from page-leave events (available since launch).">
            <KeyValueTable
              csvName="scroll-depth"
              headers={["Page", "Page views measured", "Median deepest scroll", "Reached 75%"]}
              rows={data.scroll.map((row) => [row.page, row.samples, row.samples >= minPercentileSamples && row.medianMaxScroll != null ? `${Math.round(row.medianMaxScroll * 100)}%` : `n=${row.samples}`, formatShare(row.reached75, row.samples)])}
              empty="No page-leave events in this range."
            />
          </AnalyticsSection>
        </>
      )}
    </ReportFrame>
  );
}

const knownGaps = [
  "Visitors with Do Not Track, ad or script blockers, or an excluded browser are not counted. Accepted inquiries come from server records and include them.",
  "Use inside the standalone /demo is not measured; that page blocks all network connections by design.",
  "Demo, quote-form, web-vitals and error events exist only from the instrumentation release (schema version 2). Earlier zeros mean 'not measured'.",
  "Before this release, the embedded demo excluded ordinary visitors' browsers after their first Applications visit, so earlier traffic is undercounted.",
  "A visitor is a browser, not a person or an institution. No network or company identification is used.",
  "Today's numbers are partial and can lag ingestion by a few minutes.",
];

const definitions: Array<[string, string]> = [
  ["Visitor", "A distinct anonymous browser that viewed a public page in the range."],
  ["Session", "A visit; PostHog starts a new session after 30 minutes without activity."],
  ["Engaged session", "Two or more page views, or any deliberate action: demo link, quote link, demo interaction or starting the quote form."],
  ["Accepted inquiry", "A quote request stored by the server (quote_requests). Analytics-observed submissions are shown alongside for reconciliation."],
  ["Demo use", "A visitor-initiated click on a portal control inside the embedded demo; loading and automatic updates never count."],
  ["Comparison", "The same number of days immediately before; when the range includes today, cut at the same time of day."],
];

function QualityView({ range }: { range: AnalyticsRange }) {
  const result = useReport<QualityData>("quality", range, "all");
  const [excluded, setExcluded] = useState(() => {
    try { return localStorage.getItem(exclusionKey) !== "0"; } catch { return true; }
  });
  return (
    <>
      <ReportFrame result={result}>
        {(data) => {
          const v2 = data.schemas.find((schema) => schema.version === 2);
          const emptyDays = data.daily.filter((day) => day.events === 0 && !day.partial).length;
          return (
            <>
              <p className="analytics-range-line">{rangeLabel(data)}. All devices.</p>
              <div className="analytics-stats is-compact">
                <article className="analytics-stat"><p>Collection began</p><strong>{formatDay(data.collectionStartDate, { month: "short", day: "numeric", year: "numeric" })}</strong><small>Page views, page leaves, demo and quote links</small></article>
                <article className="analytics-stat"><p>Detailed events began</p><strong>{v2?.firstSeen ? new Date(v2.firstSeen).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Not yet"}</strong><small>Demo, quote funnel, web vitals, errors (schema 2)</small></article>
                <article className="analytics-stat"><p>Days with no events</p><strong>{formatCount(emptyDays)}</strong><small>No visits, or delayed ingestion. Not the same as zero visitors on a working tracker.</small></article>
                <article className="analytics-stat"><p>Server inquiry records</p><strong>{data.canonicalAvailable ? "Connected" : "Unavailable"}</strong><small>Used for accepted-inquiry counts</small></article>
              </div>
              <AnalyticsSection title="Events received">
                <KeyValueTable
                  csvName="event-coverage"
                  headers={["Event", "In range", "First seen", "Last seen"]}
                  rows={data.events.map((row) => [row.event, row.inRange, row.firstSeen ? new Date(row.firstSeen).toLocaleString("en-US") : "—", row.lastSeen ? new Date(row.lastSeen).toLocaleString("en-US") : "—"])}
                  empty="No events since collection began."
                />
              </AnalyticsSection>
              <AnalyticsSection title="Daily event volume" description="A day with no events means no visits or delayed ingestion; it is never filled in as zero traffic from a working tracker.">
                <details className="analytics-details" open={emptyDays > 0}>
                  <summary>{emptyDays ? `${emptyDays} ${emptyDays === 1 ? "day" : "days"} without events` : "Every day has events"}</summary>
                  <KeyValueTable
                    csvName="event-volume"
                    headers={["Date", "Events", "Visitors"]}
                    rows={data.daily.map((day) => [`${day.date}${day.partial ? " (partial)" : ""}${day.events === 0 && !day.partial ? " · no events" : ""}`, day.events, day.visitors])}
                    empty="No days in range."
                  />
                </details>
              </AnalyticsSection>
            </>
          );
        }}
      </ReportFrame>
      <AnalyticsSection title="Known gaps">
        <ul className="analytics-list">{knownGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
      </AnalyticsSection>
      <AnalyticsSection title="Definitions">
        <dl className="analytics-definitions">
          {definitions.map(([term, definition]) => (
            <div key={term}><dt>{term}</dt><dd>{definition}</dd></div>
          ))}
        </dl>
      </AnalyticsSection>
      <AnalyticsSection title="This browser" description="Exclude your own visits while working on the site. Applies only to this browser; already-recorded events are not removed.">
        <button
          type="button"
          className="website-metrics-exclusion"
          aria-pressed={excluded}
          onClick={() => {
            try {
              localStorage.setItem(exclusionKey, excluded ? "0" : "1");
              setExcluded(!excluded);
            } catch {
              /* Storage unavailable: preference cannot be changed. */
            }
          }}
        >
          {excluded ? "This browser excluded" : "This browser included"}
        </button>
      </AnalyticsSection>
    </>
  );
}

export default function WebsiteAnalyticsWorkspace({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<AnalyticsReportName>("overview");
  const [preset, setPreset] = useState<"7d" | "30d" | "90d" | "custom">("30d");
  const [device, setDevice] = useState<AnalyticsDevice>("all");
  const today = useMemo(() => todayInDetroit(), []);
  const [customStart, setCustomStart] = useState(collectionStartDate);
  const [customEnd, setCustomEnd] = useState(today);
  const customValid = customStart <= customEnd && customEnd <= today && customStart >= "2026-09-01";
  const range = useMemo<AnalyticsRange>(
    () => (preset === "custom" && customValid ? { start: customStart, end: customEnd } : { preset: preset === "custom" ? "30d" : preset }),
    [customEnd, customStart, customValid, preset],
  );
  const views: Record<AnalyticsReportName, ReactNode> = {
    overview: <OverviewView range={range} device={device} />,
    acquisition: <AcquisitionView range={range} device={device} />,
    journeys: <JourneysView range={range} device={device} />,
    demo: <DemoView range={range} device={device} />,
    quote: <QuoteView range={range} device={device} />,
    experience: <ExperienceView range={range} device={device} />,
    quality: <QualityView range={range} />,
  };

  return (
    <section className="sales-support-main website-analytics-page analytics-workspace" aria-label="Web Analytics">
      <button type="button" className="support-back-button" onClick={onBack}><ArrowLeft size={15} />Home</button>
      <header className="support-hero">
        <div>
          <p>ExactH2O website</p>
          <h1>Web Analytics</h1>
        </div>
      </header>
      <div className="analytics-filters" role="group" aria-label="Report filters">
        <label>
          Range
          <select value={preset} onChange={(event) => setPreset(event.target.value as typeof preset)}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {preset === "custom" ? (
          <>
            <label>From<input type="date" value={customStart} min="2026-09-01" max={today} onChange={(event) => setCustomStart(event.target.value)} /></label>
            <label>To<input type="date" value={customEnd} min="2026-09-01" max={today} onChange={(event) => setCustomEnd(event.target.value)} /></label>
            {!customValid ? <span className="analytics-note is-error" role="alert">Choose dates from Sep 1, 2026 to today, start before end (up to 180 days).</span> : null}
          </>
        ) : null}
        <label>
          Device
          <select value={device} onChange={(event) => setDevice(event.target.value as AnalyticsDevice)} disabled={tab === "quality"}>
            <option value="all">All devices</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
            <option value="tablet">Tablet</option>
          </select>
        </label>
      </div>
      <nav className="analytics-tabs" aria-label="Reports">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "is-selected" : ""}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {views[tab]}
    </section>
  );
}
