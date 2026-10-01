# Website analytics

The public website captures PostHog page views, page leaves, `demo_clicked`,
`quote_clicked`, and `quote_submitted`. The last event fires only after the quote
endpoint confirms intake. No form contents are sent. Demo clicks mean clicks
into the demo, not completion or meaningful use of it. The standalone demo and
Applications iframe retain their network-disabled policies.

## Launch status

PostHog project: `638703` (US), organization ExactH2O, free plan without a card.
The managed proxy at `https://e.exacth2o.com` is Live, with its Namecheap CNAME
and TLS certificate provisioned. Website capture routes through this hostname.

## Public capture

`research-portal/site-metrics.js` uses the pinned PostHog SDK with automatic
interaction capture, session replay, heatmaps, performance collection, and
person profiles disabled. Only the public marketing pages load the resulting
`/site-metrics.js`. The SDK is bundled locally rather than loaded from an
analytics vendor domain. The public write-only project token and proxy URL are
in `research-portal/site-metrics.config.json`; never put a personal read key there.

A PostHog managed proxy on `e.exacth2o.com` is the preferred route for the current
GitHub Pages / Namecheap setup. It requires a new DNS CNAME pointing to the exact
target provided by PostHog. For the current project it is
`3dcd450f05de3c92dacd.cf-prod-us-proxy.proxyhog.com`. Wait until the proxy is Live before using that host.
GitHub Pages cannot implement a server-side `/ingest` rewrite. The managed proxy
is free and does not require moving the apex domain or nameservers.

## Browser exclusion

The admin tile initially marks the current browser excluded, unless a previous
explicit preference exists. The tile button toggles that browser only. A public
link with `?metrics=off` excludes the browser before initialization; `?metrics=on`
includes it. These control parameters are removed from the address bar and never
sent to PostHog. Browser Do Not Track is respected. There is no campus/IP filter.
Already recorded events are not retroactively removed by opting out.

## Private summary

`website-analytics` validates the Supabase user and a persisted project-level
admin role before reading any data. Set these Supabase secrets:

- `POSTHOG_PROJECT_ID`: the numeric website project ID.
- `POSTHOG_REGION`: `us` or `eu`.
- `POSTHOG_READ_KEY`: a personal API key scoped to Query:Read and this project only.

The endpoint runs a fixed query; callers cannot provide SQL or choose projects.
The SQL query returns seven daily buckets and a separate distinct-visitor total.
The range is today and the preceding six calendar days in America/Detroit.
The graph counts daily visitors; the seven-day total deduplicates repeat browsers.
A visitor is an anonymous browser ID, not a verified person or institution.

`website_analytics_cache` stores only aggregate counts, never IPs or visitor IDs.
It has RLS enabled, no anon/authenticated grants, and service-role access only.
An atomic database refresh lease prevents concurrent edge instances from
repeatedly querying PostHog. Successful results cache for five minutes; failures
have a one-minute retry delay and return labeled stale data when available.
The portal refreshes at most once per minute while visible, and links to the
private PostHog dashboard. No public dashboard-sharing link is created.

## Build and deployment

Run `npm run build --prefix research-portal`; this also rebuilds the public metrics
script. Commit the generated portal assets and `site-metrics.js`. The Pages
workflow copies the metrics script to the published site. Deploy only the
`website-analytics` function and the analytics cache migration for this feature;
no controller deployment is needed.

## Cost and deferred work

Keep the PostHog account on its free plan without a payment method; collection
is capped by the provider's free allowance rather than incurring overages.
The Supabase summary uses existing project infrastructure. Institution/network
identification, in-portal detail pages, and interactions inside the sandboxed
demo are outside this release. Network ownership would only be a possible
institution signal, not proof of a specific visitor or a qualified lead.
