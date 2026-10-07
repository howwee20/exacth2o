# Website analytics

ExactH2O measures its public website with PostHog (free plan, project `638703`,
US) through the managed proxy `https://e.exacth2o.com`, and reports the results
inside the portal's admin **Web Analytics** workspace. This document is the
contract: what is collected, what each report means, and what it cannot tell you.

## Principles

- A small, explicit event vocabulary. No autocapture, session replay, heatmaps,
  surveys, person profiles, institution or network identification.
- No form contents, experiment values, credentials or free text ever leave the
  browser. Every event's properties are allowlisted and bounded in
  `research-portal/src/siteMetricsContract.ts`; anything else is removed before
  sending.
- Accepted inquiries are counted from server records (`quote_requests`), not from
  browser events. Analytics-observed submissions are shown beside them for
  reconciliation.
- At ExactH2O's traffic, read counts first. Percentages are shown beside counts,
  small denominators (< 20) are labelled, and percentiles need at least five
  samples.

## Public capture

`research-portal/site-metrics.js` is bundled with PostHog's slim core
(`posthog-js/dist/module.slim.no-external`, pinned in `package.json`) into the
root `/site-metrics.js`, loaded with `defer` by the five public pages. A
side-by-side capture showed the slim and full builds send identical events and
properties (the full build only adds a `$recording_status` field; replay is off).

Every event carries `site`, `internal=false`, `page` (normalised path),
`pageview_id` (random per page load), `device_class` (from viewport width:
mobile < 768 px, tablet < 1024 px, desktop) and `ev` (schema version, now 2).
URLs keep only `utm_source/medium/campaign/content/term`; `$direct` stays a
marker, not a URL.

| Event | When | Properties (beyond the common ones) | Since |
| --- | --- | --- | --- |
| `$pageview` | Page load | PostHog context ($current_url cleaned, $referring_domain, $device_type, $session_id) | 2026-10-01 |
| `$pageleave` | Leaving a page | PostHog context incl. `$prev_pageview_max_scroll_percentage` | 2026-10-01 |
| `demo_clicked` | Click on a `/demo` link | `destination`, `placement` (nav, menu, hero, cta_strip, footer, body; placement since v2) | 2026-10-01 |
| `quote_clicked` | Click on a `/quote` link | `destination`, `placement` | 2026-10-01 |
| `quote_submitted` | Server accepted the quote (incl. a recognised duplicate) | `submission_id`, `attempt`, `duplicate`, `notification_warning` (v2) | 2026-10-01 |
| `quote_form_viewed` | Form 40% visible | — | v2 |
| `quote_form_started` | First visitor input in a form field | `first_field` (field name only) | v2 |
| `quote_validation_failed` | Validation message shown | `fields`, `errors`, `issues`/`issue_list` (`field:missing` or `field:invalid_format`), `field_count` | v2 |
| `quote_submit_attempted` | Submit with a valid form | `submission_id`, `attempt` | v2 |
| `quote_submit_failed` | Submission not accepted | `submission_id`, `attempt`, `reason` (network, rate_limited, rejected, server, unknown), `status_class` | v2 |
| `demo_viewed` | Applications demo 40% visible for 1 s | `surface` | v2 |
| `demo_ready` | Demo overview rendered | `surface`, `load_ms` (wait after it came into view; 0 if ready first) | v2 |
| `demo_interacted` | Visitor-initiated click on a demo control | `surface`, `action` (fixed list), `view` (vwc/watering/overlay), `first` | v2 |
| `demo_load_failed` | Viewed but not ready within 20 s | `surface`, `reason=timeout` | v2 |
| `web_vitals` | Page hidden or unloaded, once per page view | `lcp_ms`, `lcp_element`, `cls`, `inp_ms`, `fcp_ms`, `ttfb_ms`, `navigation_type`, `sample_rate` (1.0) | v2 |
| `page_error` | Script, resource or promise error (max 3 per page) | `kind`, `source` (first/third party, inline), `resource_type` — no message, stack or URL | v2 |

A quote request has one `submission_id`, reused across retries, so retries never
inflate attempts or acceptances. Reports count distinct `submission_id`s.

### Embedded demo bridge

The Applications demo (`/applications-demo-app/`) keeps `connect-src 'none'` and
has no network access. `applications-preview/demo-bridge.ts` posts only
`{type: "exacth2o-demo", version: 1, name, action?, view?}` to the same-origin
parent, and only for trusted (visitor) events. The parent (`site-metrics.js`)
accepts a message only when `event.source` is the demo frame's window and
`event.origin` is the page's origin, validates it against the contract, rate
limits (one per action per 3 s, 40 per page view) and applies the visitor's
analytics preference. Automatic loading and live updates never count as use.
The standalone `/demo` page allows no network connections and is not measured
beyond clicks on links to it.

### Exclusions

- Browser Do Not Track is respected; ad/script blockers prevent capture.
- Admin browsers: the portal home sets `exacth2o.analytics.excluded.v2 = 1` the
  first time an admin opens it in the top-level signed-in portal; the Web
  Analytics workspace and tile toggle it. `?metrics=off` / `?metrics=on` on any
  public page set it before initialisation and are removed from the address bar.
- The v1 key `exacth2o.analytics.excluded` is ignored and removed. Before this
  change the public demos rendered the admin tile, which set the v1 key in
  ordinary visitors' browsers after their first Applications visit and reloaded
  the page; earlier traffic is therefore undercounted.
- Automated browsers (`navigator.webdriver`) are dropped by PostHog itself.

## Reports

`supabase/functions/website-analytics` validates the Supabase user and a
persisted project-level admin role, then serves one of eight fixed reports.
The browser sends only `{report, range, device}` from fixed lists;
`report-policy.mjs` builds every HogQL query from templates with validated
dates and filters. Ranges are `7d`, `30d`, `90d` or a custom `start`/`end`
(YYYY-MM-DD, from 2026-09-01, at most 180 days). Days are America/Detroit
calendar days; ranges that include today are partial and labelled.

| Report | Contents |
| --- | --- |
| tile | Seven-day visitors, link clicks, accepted inquiries, daily visitors (original response shape) |
| overview | Visitors, sessions, page views, engaged sessions, sessions reaching the quote page, actions, accepted and analytics-observed inquiries, daily series, previous-period comparison |
| acquisition | Sessions by first-touch referring domain, campaign (utm on the landing URL), landing page and device type, each with engaged / reached-quote / accepted outcomes; accepted inquiries by campaign from server records |
| journeys | Ordered demo funnel and quote funnel within a session, direct-to-quote routes, page before the quote page, entry and exit pages |
| demo | Applications → viewed → ready → used; load failures; wait after view; actions; demo link placements; use followed by quote |
| quote | Quote page → viewed → started → attempted → accepted; validation issues; failures; quote link placements; accepted inquiries (server) |
| experience | Field LCP / INP / CLS at the 75th percentile by page and device class with sample counts; error categories; demo and quote failures; scroll depth from page leaves |
| quality | Events received with first/last seen, schema versions (when v2 detail began), daily event volume, server-record availability |

### Definitions

- **Visitor**: distinct anonymous browser (`distinct_id`) with a page view in range.
- **Session**: PostHog session (`$session_id`), ending after 30 minutes idle.
- **Engaged session**: two or more page views, or a demo link click, quote link
  click, demo interaction or quote form start.
- **Accepted inquiry**: a stored `quote_requests` row created in range
  (America/Detroit day). Analytics-observed submissions are a lower bound.
- **Comparison**: the same number of days immediately before the range; when the
  range includes today, cut at the same time of day. No percentage is shown when
  the previous value is zero or the previous period begins before collection
  started (2026-10-01).
- **Funnel step order**: steps count in order of first occurrence within a session.
- **Device filter**: browser-reported `$device_type` (available since launch).
  Quality and the tile always use all traffic.

### Caching and cost

`website_analytics_cache` stores aggregate payloads only (RLS on, service role
only). Keys combine schema version (`website-v2`), region, project, report, range,
device, time zone and, for open ranges, today's date. Open ranges refresh after
five minutes, closed ranges after six hours. The atomic
`claim_website_analytics_refresh` lease lets one Edge instance refresh a key
while others serve the cached copy; failures return the last good payload
marked delayed. Each report is one PostHog query (journeys: two). The portal
fetches a report only while its tab is open and at most once a minute while
visible. Entries older than two days are deleted.

## Configuration

Supabase Edge Function secrets (project-wide):

- `POSTHOG_PROJECT_ID`, `POSTHOG_REGION` (`us`), `POSTHOG_READ_KEY` (personal API
  key scoped to Query:Read for this project only) — unchanged.
- `PUBLIC_INTAKE_PROJECT_ID` — already set for `submit-quote`; `website-analytics`
  now reads it to count accepted inquiries. Without it, reports show
  analytics-observed inquiries only and say so.

No database migration is required. The public write-only token and proxy host
stay in `research-portal/site-metrics.config.json`; never put a read key there.

## Build, verification and deployment

`npm run build --prefix research-portal` rebuilds the portal and `/site-metrics.js`.
`node --test supabase/functions/website-analytics/report-policy.test.mjs` covers
request validation, daylight-saving boundaries, cache separation, query shape,
injection attempts, zero baselines and inquiry reconciliation.

The HogQL templates have not been executed against the live PostHog project in
this change (no read key was used). Before relying on new reports, an admin can
deploy the function and open each workspace tab: a report that fails shows
"could not be computed (PostHog returned NNN)" without affecting the others.

Deploy `website-analytics` (`supabase functions deploy website-analytics`) and
publish the site. Rollback: redeploy the previous function revision; the old
portal tile keeps working against either version because the empty-body
response shape is unchanged.
