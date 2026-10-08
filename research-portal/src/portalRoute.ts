import { useSyncExternalStore } from "react";

/**
 * Portal routes live in the query string under /portal. portal.html canonicalises every path to
 * /portal (keeping the query and hash) and the static host has no SPA fallback, so query routes
 * are the form that survives refresh, copied links, Back/Forward and printed QR labels.
 *
 *   /portal                                  Experiments (Quiet Spine home)
 *   /portal?view=trends                      Installation trends
 *   /portal?view=bench[&pot=Zone1-Pot3]      Bench layout
 *   /portal?view=workbench[&comparison=<id>] Workbench
 *   /portal?experiment=<slug>[&tab=pots|record][&pot=<pot>]
 *   /portal?pot=<pairing name | research pot id>
 *   /portal?view=pocket[&pot=<pot>][&note=1] At the bench
 *   /portal?view=health|support|walker|chamber|analytics
 *
 * `project` is carried on every link so a copied URL resolves to the same project.
 */

export type ExperimentTab = "overview" | "pots" | "record";
export type ToolView = "health" | "support" | "walker" | "chamber" | "analytics";

export type PortalRoute =
  | { view: "home" }
  | { view: "trends" }
  | { view: "bench"; pot: string | null }
  | { view: "workbench"; comparison: string | null; experiment: string | null }
  | { view: "experiment"; experiment: string; tab: ExperimentTab; pot: string | null }
  | { view: "pot"; pot: string }
  | { view: "pocket"; pot: string | null; note: boolean }
  | { view: ToolView };

const toolViews = new Set<ToolView>(["health", "support", "walker", "chamber", "analytics"]);
const tabs = new Set<ExperimentTab>(["overview", "pots", "record"]);

/** Keys that identify the account context and survive every navigation. */
const persistentKeys = ["project"] as const;
/** One-time authentication keys; never carried into a route URL. */
export const authQueryKeys = ["invite", "token", "email", "type"] as const;

const clean = (value: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function parsePortalRoute(search: string): PortalRoute {
  const params = new URLSearchParams(search);
  const view = clean(params.get("view"));
  const experiment = clean(params.get("experiment"));
  const pot = clean(params.get("pot"));
  if (view && toolViews.has(view as ToolView)) return { view: view as ToolView };
  if (view === "trends") return { view: "trends" };
  if (view === "bench") return { view: "bench", pot };
  if (view === "workbench") return { view: "workbench", comparison: clean(params.get("comparison")), experiment };
  if (view === "pocket") return { view: "pocket", pot, note: params.get("note") === "1" };
  if (experiment) {
    const tab = clean(params.get("tab"));
    return { view: "experiment", experiment, tab: tab && tabs.has(tab as ExperimentTab) ? (tab as ExperimentTab) : "overview", pot };
  }
  if (pot) return { view: "pot", pot };
  return { view: "home" };
}

function routeParams(route: PortalRoute) {
  const params = new URLSearchParams();
  switch (route.view) {
    case "home":
      break;
    case "trends":
      params.set("view", "trends");
      break;
    case "bench":
      params.set("view", "bench");
      if (route.pot) params.set("pot", route.pot);
      break;
    case "workbench":
      params.set("view", "workbench");
      if (route.comparison) params.set("comparison", route.comparison);
      if (route.experiment) params.set("experiment", route.experiment);
      break;
    case "experiment":
      params.set("experiment", route.experiment);
      if (route.tab !== "overview") params.set("tab", route.tab);
      if (route.pot) params.set("pot", route.pot);
      break;
    case "pot":
      params.set("pot", route.pot);
      break;
    case "pocket":
      params.set("view", "pocket");
      if (route.pot) params.set("pot", route.pot);
      if (route.note) params.set("note", "1");
      break;
    default:
      params.set("view", route.view);
  }
  return params;
}

/**
 * The query string for a route. Persistent context (`project`) comes from `current`; view-local
 * keys are dropped when the route changes and kept when only `extra` changes them.
 */
export function portalRouteSearch(route: PortalRoute, current = "", extra: Record<string, string | null> = {}) {
  const from = new URLSearchParams(current);
  const params = routeParams(route);
  for (const key of persistentKeys) {
    const value = clean(from.get(key));
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

function portalPath() {
  if (typeof window === "undefined") return "/portal";
  // On the production host the portal always lives at /portal (portal.html canonicalises it);
  // locally (dev server, previews) keep whatever path served the app.
  return window.location.hostname === "exacth2o.com" || window.location.hostname === "www.exacth2o.com"
    ? "/portal"
    : window.location.pathname;
}

export function portalRouteHref(route: PortalRoute, extra: Record<string, string | null> = {}) {
  const current = typeof window === "undefined" ? "" : window.location.search;
  return `${portalPath()}${portalRouteSearch(route, current, extra)}`;
}

/** Absolute link for copying or printing on a label. */
export function portalRouteUrl(route: PortalRoute, extra: Record<string, string | null> = {}) {
  const origin = typeof window === "undefined" ? "https://exacth2o.com" : window.location.origin;
  return `${origin}${portalRouteHref(route, extra)}`;
}

const changeEvent = "exacth2o:portal-route";

function notify() {
  window.dispatchEvent(new Event(changeEvent));
}

export function navigatePortal(route: PortalRoute, options: { replace?: boolean; extra?: Record<string, string | null> } = {}) {
  const href = portalRouteHref(route, options.extra);
  if (href === `${window.location.pathname}${window.location.search}`) return;
  if (options.replace) window.history.replaceState(window.history.state, "", href);
  else window.history.pushState(null, "", href);
  notify();
  if (!options.replace) window.scrollTo?.(0, 0);
}

/** Update view-local query keys without creating a history entry (filters, grouping, measure). */
export function setPortalQuery(values: Record<string, string | null>, options: { push?: boolean } = {}) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  const href = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (options.push) window.history.pushState(null, "", href);
  else window.history.replaceState(window.history.state, "", href);
  notify();
}

/**
 * Remove one-time authentication keys (invite tokens, recovery type, prefilled email) while
 * keeping the route, so finishing sign-in lands on the page that was asked for.
 */
export function stripAuthQuery() {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const key of authQueryKeys) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  const hash = window.location.hash;
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  const authHash = hashParams.has("access_token") || hashParams.has("type") || hashParams.has("error");
  if (!changed && !authHash) return;
  const search = params.toString();
  window.history.replaceState(null, "", `${portalPath()}${search ? `?${search}` : ""}${authHash ? "" : hash}`);
  notify();
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(changeEvent, onChange);
  };
}

const getSearch = () => window.location.search;
const getServerSearch = () => "";

/** The current query string; re-renders on navigation and Back/Forward. */
export function usePortalSearch() {
  return useSyncExternalStore(subscribe, getSearch, getServerSearch);
}

export function usePortalRoute(): PortalRoute {
  return parsePortalRoute(usePortalSearch());
}

/** One view-local query value (e.g. `group`, `measure`). */
export function usePortalQueryValue(key: string) {
  return new URLSearchParams(usePortalSearch()).get(key);
}

/** Same-tab navigation for ordinary links: modified clicks keep the browser's behaviour. */
export function followPortalLink(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number; preventDefault(): void }, route: PortalRoute, extra?: Record<string, string | null>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigatePortal(route, { extra });
}
