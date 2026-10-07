/**
 * The public website's analytics contract: which events exist, which
 * properties each may carry, and the bounds on every value. Anything not
 * listed here is removed before an event leaves the browser. No event carries
 * form contents, experiment values, credentials or free text.
 *
 * Shared by the public tracker (site-metrics.js), the embedded demo's message
 * bridge, and the portal's report definitions.
 */

/** Bumped when the vocabulary changes; reports use it to find when collection began. */
export const metricsSchemaVersion = 2;
export const metricsSite = "exacth2o-public";

export const sitePages = ["/", "/applications", "/about", "/support", "/quote"] as const;
export type SitePage = (typeof sitePages)[number];

export const ctaPlacements = ["nav", "menu", "hero", "cta_strip", "footer", "body"] as const;
export const deviceClasses = ["mobile", "tablet", "desktop"] as const;

export const quoteFields = ["name", "email", "phone", "organization", "application", "timeline", "message"] as const;
export const quoteErrorCodes = ["missing", "invalid_format"] as const;
export const quoteFailureReasons = ["network", "rate_limited", "rejected", "server", "unknown"] as const;
/** "email:invalid_format" — which field failed and why, from a fixed list. */
export const quoteIssues = quoteFields.flatMap((field) => quoteErrorCodes.map((code) => `${field}:${code}`));

export const demoSurfaces = ["applications_embed"] as const;
export const demoActions = [
  "open_experiment",
  "open_health",
  "open_calibration",
  "navigate_home",
  "change_graph_view",
  "select_pot",
  "toggle_pot_group",
  "filter_pots",
  "expand_chart",
  "change_time_range",
  "inspect_chart",
] as const;
export type DemoAction = (typeof demoActions)[number];
export const graphViews = ["vwc", "watering", "overlay"] as const;
export type GraphView = (typeof graphViews)[number];

export const errorKinds = ["script", "resource", "promise"] as const;
export const errorSources = ["first_party", "third_party", "inline", "unknown"] as const;
export const resourceTypes = ["img", "script", "link", "video", "iframe", "other"] as const;
export const navigationTypes = ["navigate", "reload", "back_forward", "prerender", "unknown"] as const;
export const lcpElements = ["img", "text", "video", "other"] as const;

type PropertySpec =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "enum_list"; values: readonly string[]; max: number }
  /** A "|"-joined list from a fixed vocabulary; easy to split in report queries. */
  | { kind: "joined_list"; values: readonly string[]; max: number }
  | { kind: "int"; min: number; max: number }
  | { kind: "decimal"; min: number; max: number; digits: number }
  | { kind: "bool" }
  | { kind: "id" };

const surface: PropertySpec = { kind: "enum", values: demoSurfaces };
const submissionId: PropertySpec = { kind: "id" };
const attempt: PropertySpec = { kind: "int", min: 1, max: 20 };

export const eventProperties: Record<string, Record<string, PropertySpec>> = {
  $pageview: {},
  $pageleave: {},
  demo_clicked: { destination: { kind: "enum", values: ["/demo"] }, placement: { kind: "enum", values: ctaPlacements } },
  quote_clicked: { destination: { kind: "enum", values: ["/quote"] }, placement: { kind: "enum", values: ctaPlacements } },
  quote_form_viewed: {},
  quote_form_started: { first_field: { kind: "enum", values: quoteFields } },
  quote_validation_failed: {
    fields: { kind: "enum_list", values: quoteFields, max: quoteFields.length },
    errors: { kind: "enum_list", values: quoteErrorCodes, max: quoteErrorCodes.length },
    issues: { kind: "enum_list", values: quoteIssues, max: quoteFields.length },
    issue_list: { kind: "joined_list", values: quoteIssues, max: quoteFields.length },
    field_count: { kind: "int", min: 1, max: quoteFields.length },
  },
  quote_submit_attempted: { submission_id: submissionId, attempt },
  quote_submitted: { submission_id: submissionId, attempt, duplicate: { kind: "bool" }, notification_warning: { kind: "bool" } },
  quote_submit_failed: {
    submission_id: submissionId,
    attempt,
    reason: { kind: "enum", values: quoteFailureReasons },
    status_class: { kind: "enum", values: ["4xx", "5xx", "none"] },
  },
  demo_viewed: { surface },
  demo_ready: { surface, load_ms: { kind: "int", min: 0, max: 120_000 } },
  demo_interacted: {
    surface,
    action: { kind: "enum", values: demoActions },
    view: { kind: "enum", values: graphViews },
    first: { kind: "bool" },
  },
  demo_load_failed: { surface, reason: { kind: "enum", values: ["timeout"] } },
  web_vitals: {
    lcp_ms: { kind: "int", min: 0, max: 120_000 },
    lcp_element: { kind: "enum", values: lcpElements },
    cls: { kind: "decimal", min: 0, max: 10, digits: 3 },
    inp_ms: { kind: "int", min: 0, max: 60_000 },
    fcp_ms: { kind: "int", min: 0, max: 120_000 },
    ttfb_ms: { kind: "int", min: 0, max: 120_000 },
    navigation_type: { kind: "enum", values: navigationTypes },
    sample_rate: { kind: "decimal", min: 0, max: 1, digits: 2 },
  },
  page_error: {
    kind: { kind: "enum", values: errorKinds },
    source: { kind: "enum", values: errorSources },
    resource_type: { kind: "enum", values: resourceTypes },
  },
};

export const allowedEventNames = new Set(Object.keys(eventProperties));

/** Properties the tracker adds to every event. */
export const commonPropertyNames = new Set(["site", "internal", "page", "pageview_id", "device_class", "ev"]);

const idPattern = /^[a-z0-9-]{8,40}$/;

function cleanValue(spec: PropertySpec, value: unknown): unknown {
  switch (spec.kind) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? value : undefined;
    case "enum_list": {
      if (!Array.isArray(value)) return undefined;
      const cleaned = Array.from(new Set(value.filter((item): item is string => typeof item === "string" && spec.values.includes(item))));
      return cleaned.length ? cleaned.slice(0, spec.max).sort() : undefined;
    }
    case "joined_list": {
      const items = typeof value === "string" ? value.split("|") : Array.isArray(value) ? value : [];
      const cleaned = Array.from(new Set(items.filter((item): item is string => typeof item === "string" && spec.values.includes(item))));
      return cleaned.length ? cleaned.slice(0, spec.max).sort().join("|") : undefined;
    }
    case "int":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.max(spec.min, Math.min(spec.max, Math.round(value)))
        : undefined;
    case "decimal":
      return typeof value === "number" && Number.isFinite(value)
        ? Number(Math.max(spec.min, Math.min(spec.max, value)).toFixed(spec.digits))
        : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "id":
      return typeof value === "string" && idPattern.test(value) ? value : undefined;
  }
}

/**
 * PostHog's own "$" properties that may leave the browser. Everything else the SDK adds is
 * dropped, including whatever a future SDK version introduces: session-entry click IDs
 * ($session_entry_gclid, _fbclid, …), search keywords ($session_entry_ph_keyword), initial-visit
 * and person properties, and SDK debug fields. URL-valued keys are cleaned to origin + path +
 * utm_* parameters (referrers to origin + path) before they are kept.
 */
export const sdkPropertyNames = new Set([
  "$browser", "$browser_version", "$browser_language", "$browser_language_prefix",
  "$os", "$os_version", "$device_type", "$raw_user_agent",
  "$screen_height", "$screen_width", "$viewport_height", "$viewport_width",
  "$timezone", "$timezone_offset",
  "$host", "$pathname", "$current_url", "$referrer", "$referring_domain",
  "$session_entry_url", "$session_entry_host", "$session_entry_pathname",
  "$session_entry_referrer", "$session_entry_referring_domain",
  "$session_entry_utm_source", "$session_entry_utm_medium", "$session_entry_utm_campaign",
  "$session_entry_utm_content", "$session_entry_utm_term",
  "$prev_pageview_id", "$prev_pageview_pathname", "$prev_pageview_duration",
  "$prev_pageview_last_scroll", "$prev_pageview_last_scroll_percentage",
  "$prev_pageview_max_scroll", "$prev_pageview_max_scroll_percentage",
  "$prev_pageview_last_content", "$prev_pageview_last_content_percentage",
  "$prev_pageview_max_content", "$prev_pageview_max_content_percentage",
  "$session_id", "$window_id", "$pageview_id", "$device_id", "$insert_id", "$time",
  "$lib", "$lib_version", "$lib_custom_api_host", "$lib_rate_limit_remaining_tokens",
  "$config_defaults", "$configured_session_timeout_ms",
  "$is_identified", "$process_person_profile",
]);
const sdkUrlProperties = new Set(["$current_url", "$session_entry_url"]);
const sdkReferrerProperties = new Set(["$referrer", "$session_entry_referrer"]);
const sdkPathProperties = new Set(["$pathname", "$session_entry_pathname", "$prev_pageview_pathname"]);

function sdkPropertyValue(key: string, value: unknown, origin: string) {
  if (sdkUrlProperties.has(key)) return typeof value === "string" ? cleanUrl(value, origin) || undefined : undefined;
  if (sdkReferrerProperties.has(key)) {
    // "$direct" is PostHog's marker for no referrer, not a URL.
    if (value === "$direct") return value;
    return typeof value === "string" ? cleanUrl(value, origin).split("?")[0] || undefined : undefined;
  }
  if (sdkPathProperties.has(key)) return typeof value === "string" ? value.split(/[?#]/)[0].slice(0, 200) : undefined;
  return value;
}

/**
 * Keep only the allowlisted, in-bounds properties of an event: the contract's own properties and
 * the allowlisted SDK "$" properties, with URLs cleaned. Returns null for events outside the
 * vocabulary.
 */
export function sanitizeEventProperties(name: string, properties: Record<string, unknown>, origin = "https://exacth2o.com") {
  const spec = eventProperties[name];
  if (!spec) return null;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith("$")) {
      if (!sdkPropertyNames.has(key)) continue;
      const next = sdkPropertyValue(key, value, origin);
      if (next !== undefined) cleaned[key] = next;
      continue;
    }
    if (commonPropertyNames.has(key)) {
      cleaned[key] = value;
      continue;
    }
    const propertySpec = spec[key];
    if (!propertySpec) continue;
    const next = cleanValue(propertySpec, value);
    if (next !== undefined) cleaned[key] = next;
  }
  return cleaned;
}

/** "/applications.html" and "/applications" are one page; anything else is "/other". */
export function normalizePage(pathname: string): SitePage | "/other" {
  const path = pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  return (sitePages as readonly string[]).includes(path) ? (path as SitePage) : "/other";
}

/** Layout class from the viewport width (what the visitor actually saw), not the user agent. */
export function deviceClass(viewportWidth: number) {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return "desktop";
  if (viewportWidth < 768) return "mobile";
  if (viewportWidth < 1024) return "tablet";
  return "desktop";
}

const campaignKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/** URL without its query, except bounded campaign parameters; never fragments or other parameters. */
export function cleanUrl(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    const clean = new URL(url.origin + url.pathname);
    for (const key of campaignKeys) {
      const parameter = url.searchParams.get(key);
      if (parameter) clean.searchParams.set(key, parameter.slice(0, 120));
    }
    return clean.href;
  } catch {
    return "";
  }
}

/** CTA placement from the nearest landmark of the clicked link. */
export function ctaPlacement(element: { closest: (selector: string) => unknown }) {
  if (element.closest(".mobile-menu")) return "menu";
  if (element.closest("nav")) return "nav";
  if (element.closest(".cinema-hero")) return "hero";
  if (element.closest(".cta-strip")) return "cta_strip";
  if (element.closest("footer")) return "footer";
  return "body";
}

/* ----- Embedded demo message bridge ------------------------------------- */

export const demoMessageType = "exacth2o-demo";
export const demoMessageVersion = 1;

export type DemoMessage =
  | { type: typeof demoMessageType; version: typeof demoMessageVersion; name: "demo_ready" }
  | { type: typeof demoMessageType; version: typeof demoMessageVersion; name: "demo_interacted"; action: DemoAction; view?: GraphView };

/**
 * Validate a message from the demo frame. Only these exact shapes are
 * accepted; extra fields are ignored and never forwarded.
 */
export function parseDemoMessage(data: unknown): { name: "demo_ready" } | { name: "demo_interacted"; action: DemoAction; view?: GraphView } | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type !== demoMessageType || message.version !== demoMessageVersion) return null;
  if (message.name === "demo_ready") return { name: "demo_ready" };
  if (message.name !== "demo_interacted") return null;
  if (typeof message.action !== "string" || !(demoActions as readonly string[]).includes(message.action)) return null;
  const view = typeof message.view === "string" && (graphViews as readonly string[]).includes(message.view)
    ? message.view as GraphView
    : undefined;
  return { name: "demo_interacted", action: message.action as DemoAction, ...(view ? { view } : {}) };
}

/** Per-key spacing plus a per-page ceiling. Returns true when an event may be sent. */
export function createRateLimiter(options: { minSpacingMs: number; maxTotal: number }) {
  const lastByKey = new Map<string, number>();
  let total = 0;
  return (key: string, nowMs: number) => {
    if (total >= options.maxTotal) return false;
    const last = lastByKey.get(key);
    if (last != null && nowMs - last < options.minSpacingMs) return false;
    lastByKey.set(key, nowMs);
    total += 1;
    return true;
  };
}

/* ----- Web vitals (computed in the browser, sent once per page) -------- */

/** Cumulative Layout Shift: the largest session window (gaps < 1 s, windows <= 5 s). */
export function cumulativeLayoutShift(shifts: Array<{ startTime: number; value: number; hadRecentInput?: boolean }>) {
  let max = 0;
  let current = 0;
  let windowStart = -Infinity;
  let previous = -Infinity;
  for (const shift of shifts) {
    if (shift.hadRecentInput) continue;
    if (shift.startTime - previous > 1000 || shift.startTime - windowStart > 5000) {
      current = 0;
      windowStart = shift.startTime;
    }
    current += shift.value;
    previous = shift.startTime;
    max = Math.max(max, current);
  }
  return max;
}

/** Interaction to Next Paint: the slowest interaction, or the 98th percentile with many interactions. */
export function interactionToNextPaint(events: Array<{ interactionId?: number; duration: number }>) {
  const byInteraction = new Map<number, number>();
  for (const event of events) {
    if (!event.interactionId) continue;
    byInteraction.set(event.interactionId, Math.max(byInteraction.get(event.interactionId) ?? 0, event.duration));
  }
  const durations = Array.from(byInteraction.values()).sort((a, b) => b - a);
  if (!durations.length) return null;
  return durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))];
}

/* ----- Errors ---------------------------------------------------------- */

const resourceTagTypes: Record<string, (typeof resourceTypes)[number]> = {
  IMG: "img",
  SCRIPT: "script",
  LINK: "link",
  VIDEO: "video",
  SOURCE: "video",
  IFRAME: "iframe",
};

/** Classify an error without its message, stack or URL; only coarse, fixed categories leave the page. */
export function classifyError(input: {
  kind: "script" | "resource" | "promise";
  tagName?: string | null;
  url?: string | null;
  origin: string;
}) {
  let source: (typeof errorSources)[number] = "unknown";
  if (input.url) {
    try {
      source = new URL(input.url, input.origin).origin === input.origin ? "first_party" : "third_party";
    } catch {
      source = "unknown";
    }
  } else if (input.kind === "script") {
    source = "inline";
  }
  return {
    kind: input.kind,
    source,
    resource_type: input.kind === "resource" ? resourceTagTypes[String(input.tagName ?? "").toUpperCase()] ?? "other" : undefined,
  };
}

/* ----- Quote form ------------------------------------------------------ */

/** Coarse failure category for a quote submission; never the server's message text. */
export function quoteFailure(status: number | null) {
  if (status == null) return { reason: "network" as const, status_class: "none" as const };
  if (status === 429) return { reason: "rate_limited" as const, status_class: "4xx" as const };
  if (status >= 400 && status < 500) return { reason: "rejected" as const, status_class: "4xx" as const };
  if (status >= 500) return { reason: "server" as const, status_class: "5xx" as const };
  return { reason: "unknown" as const, status_class: "none" as const };
}
