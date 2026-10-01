import posthog from 'posthog-js/dist/module.no-external';
import config from './site-metrics.config.json';

const exclusionKey = 'exacth2o.analytics.excluded';
const allowedHosts = new Set(['exacth2o.com', 'www.exacth2o.com']);
const allowedPages = new Set(['/', '/index.html', '/about.html', '/applications.html', '/quote.html', '/support.html', '/about', '/applications', '/quote', '/support']);
const allowedEvents = new Set(['$pageview', '$pageleave', 'demo_clicked', 'quote_clicked', 'quote_submitted']);
function excluded() {
  try { return localStorage.getItem(exclusionKey) === '1'; } catch { return true; }
}
function cleanUrl(value) {
  try {
    const url = new URL(value, location.origin);
    const clean = new URL(url.origin + url.pathname);
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      const value = url.searchParams.get(key);
      if (value) clean.searchParams.set(key, value.slice(0, 120));
    }
    return clean.href;
  } catch { return ''; }
}
if (allowedHosts.has(location.hostname) && allowedPages.has(location.pathname)) {
  const params = new URLSearchParams(location.search);
  if (params.get('metrics') === 'off' || params.get('metrics') === 'on') {
    try { localStorage.setItem(exclusionKey, params.get('metrics') === 'off' ? '1' : '0'); } catch { /* Fail closed below. */ }
    params.delete('metrics');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '') + location.hash);
  }
  if (config.projectToken && !excluded()) {
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
      enable_surveys: false,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      respect_dnt: true,
      before_send(event) {
        if (!event || excluded() || !allowedEvents.has(event.event)) return null;
        const properties = event.properties;
        properties.site = 'exacth2o-public';
        properties.internal = false;
        properties.$current_url = cleanUrl(properties.$current_url || location.href);
        if (properties.$referrer) properties.$referrer = cleanUrl(properties.$referrer).split('?')[0];
        for (const key of Object.keys(properties)) {
          // No form values, user profiles, query-string secrets, or raw URL initial properties.
          if (key.startsWith('$initial_') || key === '$set' || key === '$set_once') delete properties[key];
        }
        return event;
      },
      loaded(client) {
        client.register({ site: 'exacth2o-public', internal: false });
        client.capture('$pageview', { $current_url: cleanUrl(location.href) });
      },
    });
    function capture(name, properties = {}) {
      if (!excluded() && allowedEvents.has(name)) posthog.capture(name, properties, { transport: 'sendBeacon', send_instantly: true });
    }
    document.addEventListener('click', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const url = new URL(anchor.href, location.href);
      if (!allowedHosts.has(url.hostname)) return;
      if (url.pathname === '/demo' || url.pathname === '/demo.html') capture('demo_clicked', { destination: '/demo' });
      if (url.pathname === '/quote' || url.pathname === '/quote.html') capture('quote_clicked', { destination: '/quote' });
    }, { capture: true });
    // The form emits only after the server confirms successful intake. No field contents are sent.
    document.addEventListener('exacth2o:quote-submitted', () => capture('quote_submitted'));
    window.addEventListener('storage', (event) => {
      if (event.key === exclusionKey) location.reload();
    });
  }
}
