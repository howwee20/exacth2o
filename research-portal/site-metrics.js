import posthog from 'posthog-js/dist/module.no-external';
import config from './site-metrics.config.json';
import {
  allowedEventNames,
  classifyError,
  cleanUrl,
  createRateLimiter,
  ctaPlacement,
  cumulativeLayoutShift,
  demoSurfaces,
  deviceClass,
  interactionToNextPaint,
  metricsSchemaVersion,
  metricsSite,
  normalizePage,
  parseDemoMessage,
  quoteFailure,
  quoteFields,
  sanitizeEventProperties,
} from './src/siteMetricsContract';

// v2: the v1 key was also written by the internal analytics tile when the public demo
// embedded it, silently excluding ordinary visitors. Only the admin portal and the
// ?metrics= link set this key; the v1 value is ignored and removed.
const exclusionKey = 'exacth2o.analytics.excluded.v2';
const legacyExclusionKey = 'exacth2o.analytics.excluded';
const allowedHosts = new Set(['exacth2o.com', 'www.exacth2o.com']);
// Properties the SDK itself requires; every other non-"$" property must be in the contract.
const sdkProperties = new Set(['token', 'distinct_id', 'title']);
// Every page view is measured; the rate is recorded so reports can scale if it is ever lowered.
const webVitalsSampleRate = 1;
const demoReadyTimeoutMs = 20_000;
const maxErrorsPerPage = 3;

function excluded() {
  try { return localStorage.getItem(exclusionKey) === '1'; } catch { return true; }
}
function randomId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

const page = normalizePage(location.pathname);
if (allowedHosts.has(location.hostname) && page !== '/other') {
  try { localStorage.removeItem(legacyExclusionKey); } catch { /* Storage unavailable. */ }
  const params = new URLSearchParams(location.search);
  if (params.get('metrics') === 'off' || params.get('metrics') === 'on') {
    try { localStorage.setItem(exclusionKey, params.get('metrics') === 'off' ? '1' : '0'); } catch { /* Fail closed below. */ }
    params.delete('metrics');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '') + location.hash);
  }
  if (config.projectToken && !excluded()) {
    const pageviewId = randomId();
    const common = {
      site: metricsSite,
      internal: false,
      page,
      pageview_id: pageviewId,
      device_class: deviceClass(window.innerWidth),
      ev: metricsSchemaVersion,
    };
    posthog.init(config.projectToken, {
      api_host: config.apiHost,
      ui_host: config.uiHost,
      persistence: 'localStorage',
      cross_subdomain_cookie: false,
      person_profiles: 'never',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: true,
      disable_session_recording: true,
      enable_recording_console_log: false,
      capture_heatmaps: false,
      capture_performance: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      enable_surveys: false,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      respect_dnt: true,
      before_send(event) {
        if (!event || excluded() || !allowedEventNames.has(event.event)) return null;
        const properties = event.properties;
        properties.$current_url = cleanUrl(properties.$current_url || location.href, location.origin);
        if (properties.$referrer) properties.$referrer = cleanUrl(properties.$referrer, location.origin).split('?')[0];
        for (const key of Object.keys(properties)) {
          // No form values, user profiles, query-string secrets, or raw URL initial properties.
          if (key.startsWith('$initial_') || key === '$set' || key === '$set_once') delete properties[key];
        }
        // Contract enforcement: unknown or out-of-bounds custom properties never leave the browser.
        const sdk = {};
        for (const key of sdkProperties) if (key in properties) sdk[key] = properties[key];
        const cleaned = sanitizeEventProperties(event.event, properties);
        if (!cleaned) return null;
        event.properties = { ...cleaned, ...sdk, ...common };
        return event;
      },
      loaded(client) {
        client.register(common);
        client.capture('$pageview', { $current_url: cleanUrl(location.href, location.origin) });
      },
    });

    const capture = (name, properties = {}) => {
      if (excluded() || !allowedEventNames.has(name)) return;
      const cleaned = sanitizeEventProperties(name, properties);
      if (cleaned) posthog.capture(name, cleaned, { transport: 'sendBeacon', send_instantly: true });
    };
    const once = new Set();
    const captureOnce = (name, properties) => {
      if (once.has(name)) return;
      once.add(name);
      capture(name, properties);
    };

    // Links into the demo and the quote form, with where on the page the link sits.
    document.addEventListener('click', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { return; }
      if (!allowedHosts.has(url.hostname) && url.origin !== location.origin) return;
      const placement = ctaPlacement(anchor);
      if (url.pathname === '/demo' || url.pathname === '/demo.html') capture('demo_clicked', { destination: '/demo', placement });
      if (url.pathname === '/quote' || url.pathname === '/quote.html') capture('quote_clicked', { destination: '/quote', placement });
    }, { capture: true });

    if (page === '/quote') instrumentQuoteForm(capture, captureOnce);
    if (page === '/applications') instrumentEmbeddedDemo(capture, captureOnce);
    instrumentWebVitals(capture);
    instrumentErrors(capture);
    // Opting out in another tab takes effect immediately: every event re-checks excluded().
  }
}

// Quote funnel. The form announces each step with a DOM event; only fixed field
// names, error codes and counts are sent, never anything a visitor typed.
function instrumentQuoteForm(capture, captureOnce) {
  const form = document.getElementById('quoteForm');
  if (!form) return;
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        captureOnce('quote_form_viewed', {});
        observer.disconnect();
      }
    }, { threshold: 0.4 });
    observer.observe(form);
  }
  const started = (event) => {
    const name = event.target && event.target.name;
    if (!event.isTrusted || !quoteFields.includes(name)) return;
    captureOnce('quote_form_started', { first_field: name });
  };
  form.addEventListener('input', started);
  form.addEventListener('change', started);
  const detail = (event) => (event instanceof CustomEvent && event.detail && typeof event.detail === 'object' ? event.detail : {});
  document.addEventListener('exacth2o:quote-validation-failed', (event) => {
    const { fields = [], errors = [] } = detail(event);
    const issues = Array.isArray(fields) && Array.isArray(errors) ? fields.map((field, index) => `${field}:${errors[index]}`) : [];
    capture('quote_validation_failed', { fields, errors, issues, issue_list: issues, field_count: Array.isArray(fields) ? fields.length : 0 });
  });
  document.addEventListener('exacth2o:quote-submit-attempted', (event) => {
    const { submissionId, attempt } = detail(event);
    capture('quote_submit_attempted', { submission_id: submissionId, attempt });
  });
  // Fires only after the server confirms intake (including an already-recorded duplicate).
  document.addEventListener('exacth2o:quote-submitted', (event) => {
    const { submissionId, attempt, duplicate = false, warning = false } = detail(event);
    capture('quote_submitted', { submission_id: submissionId, attempt, duplicate, notification_warning: warning });
  });
  document.addEventListener('exacth2o:quote-submit-failed', (event) => {
    const { submissionId, attempt, status = null } = detail(event);
    capture('quote_submit_failed', { submission_id: submissionId, attempt, ...quoteFailure(status) });
  });
}

// Applications demo. The frame has no network access (connect-src 'none'); it may
// only post fixed messages to this page, which checks the sender, applies the
// visitor's analytics preference, rate-limits and forwards allowlisted values.
function instrumentEmbeddedDemo(capture, captureOnce) {
  const frame = document.querySelector('iframe.portal-demo-frame');
  if (!frame) return;
  const surface = demoSurfaces[0];
  let visibleAt = null;
  let ready = false;
  let firstInteraction = true;
  const allow = createRateLimiter({ minSpacingMs: 3000, maxTotal: 40 });

  if ('IntersectionObserver' in window) {
    let dwell = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible && dwell == null && visibleAt == null) {
        // Visible for a full second: scrolled to, not scrolled past.
        dwell = setTimeout(() => {
          visibleAt = performance.now();
          captureOnce('demo_viewed', { surface });
          observer.disconnect();
          setTimeout(() => {
            if (!ready) captureOnce('demo_load_failed', { surface, reason: 'timeout' });
          }, demoReadyTimeoutMs);
        }, 1000);
      } else if (!visible && dwell != null && visibleAt == null) {
        clearTimeout(dwell);
        dwell = null;
      }
    }, { threshold: 0.4 });
    observer.observe(frame);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const message = parseDemoMessage(event.data);
    if (!message) return;
    if (message.name === 'demo_ready') {
      if (ready) return;
      ready = true;
      // Time a visitor waited after the demo came into view; zero when it was ready first.
      captureOnce('demo_ready', { surface, load_ms: visibleAt == null ? 0 : performance.now() - visibleAt });
      return;
    }
    if (!allow(message.action, performance.now())) return;
    capture('demo_interacted', { surface, action: message.action, view: message.view, first: firstInteraction });
    firstInteraction = false;
  });
}

// One web-vitals event per page view, sent when the page is hidden or unloaded.
function instrumentWebVitals(capture) {
  if (!('PerformanceObserver' in window) || Math.random() >= webVitalsSampleRate) return;
  const shifts = [];
  const interactions = [];
  let lcp = null;
  let lcpElement = 'other';
  let fcp = null;
  const observe = (type, callback, extra = {}) => {
    try { new PerformanceObserver((list) => callback(list.getEntries())).observe({ type, buffered: true, ...extra }); } catch { /* Unsupported entry type. */ }
  };
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (!last) return;
    lcp = last.startTime;
    const tag = last.element && last.element.tagName;
    lcpElement = tag === 'IMG' || tag === 'image' ? 'img' : tag === 'VIDEO' ? 'video' : tag ? 'text' : 'other';
  });
  observe('layout-shift', (entries) => shifts.push(...entries));
  observe('event', (entries) => interactions.push(...entries), { durationThreshold: 40 });
  observe('paint', (entries) => {
    for (const entry of entries) if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
  });
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    const navigation = performance.getEntriesByType('navigation')[0];
    const inp = interactionToNextPaint(interactions);
    capture('web_vitals', {
      lcp_ms: lcp ?? undefined,
      lcp_element: lcp == null ? undefined : lcpElement,
      cls: cumulativeLayoutShift(shifts),
      inp_ms: inp ?? undefined,
      fcp_ms: fcp ?? undefined,
      ttfb_ms: navigation ? navigation.responseStart : undefined,
      navigation_type: navigation ? String(navigation.type).replace('-', '_') : 'unknown',
      sample_rate: webVitalsSampleRate,
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
  });
  window.addEventListener('pagehide', send);
}

// Page and resource errors as coarse categories only: no messages, stacks or URLs.
function instrumentErrors(capture) {
  const seen = new Set();
  const report = (input) => {
    if (seen.size >= maxErrorsPerPage) return;
    const classified = classifyError({ ...input, origin: location.origin });
    const key = `${classified.kind}:${classified.source}:${classified.resource_type ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    capture('page_error', classified);
  };
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && target instanceof Element) {
      report({ kind: 'resource', tagName: target.tagName, url: target.currentSrc || target.src || target.href || null });
    } else {
      report({ kind: 'script', url: event.filename || null });
    }
  }, true);
  window.addEventListener('unhandledrejection', () => report({ kind: 'promise' }));
}
