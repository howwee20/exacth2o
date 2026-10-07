import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { publicIntakeProjectId } from "../_shared/installation-config.mjs";
import {
  buildReportQueries,
  parseReportRequest,
  parseRows,
  reportCacheKey,
  reportTtlMs,
  shapeReport,
  summarizeAcceptedInquiries,
  timezone,
} from "./report-policy.mjs";

const allowedOrigins = new Set(["https://exacth2o.com", "https://www.exacth2o.com", "http://localhost:5173", "http://127.0.0.1:5173"]);
// Reports that include accepted-inquiry counts from server records.
const canonicalReports = new Set(["tile", "overview", "acquisition", "quote", "quality"]);

serve(async (request) => {
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://exacth2o.com",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (origin && !allowedOrigins.has(origin)) return reply({ error: "Origin not allowed" }, 403);
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !serviceKey) return reply({ error: "Analytics unavailable" }, 503);
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return reply({ error: "Sign in required" }, 401);
  const user = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  try {
    const { data: identity, error: authError } = await user.auth.getUser();
    if (authError || !identity.user) return reply({ error: "Sign in required" }, 401);
    // Same persisted admin role as the portal; never trust a role in the request.
    const { data: access, error: accessError } = await service.from("portal_access").select("id")
      .eq("user_id", identity.user.id).eq("role", "admin").eq("access_scope", "project").limit(1);
    if (accessError) return reply({ error: "Unable to check access" }, 503);
    if (!access?.length) return reply({ error: "Admin access required" }, 403);

    // Only a report name, a date range and a device filter are read from the body, and only from fixed lists.
    let body: unknown = {};
    try {
      const text = await request.text();
      if (text.length > 2_000) return reply({ error: "Request too large" }, 413);
      body = text ? JSON.parse(text) : {};
    } catch {
      return reply({ error: "Invalid request body" }, 400);
    }
    const parsed = parseReportRequest(body, new Date());
    const report = parsed.ok ? parsed.request : undefined;
    if (!report) return reply({ error: parsed.error ?? "Invalid request" }, 400);

    const project = Deno.env.get("POSTHOG_PROJECT_ID");
    const key = Deno.env.get("POSTHOG_READ_KEY");
    const region = Deno.env.get("POSTHOG_REGION") === "eu" ? "eu" : "us";
    const host = `https://${region}.posthog.com`;
    const dashboardUrl = project && /^\d+$/.test(project) ? `${host}/project/${project}/web` : null;
    if (!key || !dashboardUrl) return reply({ status: "setup", report: report.report, dashboardUrl, message: "Analytics connection pending" });

    const cacheKey = reportCacheKey(report, { region, project: project as string });
    const ttlMs = reportTtlMs(report);
    const readCache = () => service.from("website_analytics_cache").select("payload,fetched_at").eq("cache_key", cacheKey).maybeSingle();
    const { data: cached, error: cacheError } = await readCache();
    if (cacheError) return reply({ error: "Analytics cache unavailable" }, 503);
    const responseFrom = (row: typeof cached, stale: boolean, failure?: string) => reply({
      status: row?.payload ? "ready" : "collecting",
      report: report.report,
      ...(row?.payload ?? {}),
      dashboardUrl,
      updatedAt: row?.fetched_at ?? null,
      stale,
      ...(failure ? { failure } : {}),
      timezone,
    });
    if (cached?.fetched_at && Date.now() - Date.parse(cached.fetched_at) < ttlMs) return responseFrom(cached, false);
    // The database lease lets one Edge instance refresh a report at a time; others serve the cache.
    const { data: claimed, error: leaseError } = await service.rpc("claim_website_analytics_refresh", { requested_key: cacheKey });
    if (leaseError) return reply({ error: "Analytics cache unavailable" }, 503);
    if (!claimed) return responseFrom(cached, true);
    try {
      const runQuery = async (query: string) => {
        const result = await fetch(`${host}/api/projects/${project}/query/`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: { kind: "HogQLQuery", query }, refresh: "blocking" }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!result.ok) throw new Error(`PostHog returned ${result.status}`);
        const body = await result.json();
        // Throws when PostHog reports more rows than the query limit: never a silently partial report.
        return parseRows(body.results, body.hasMore === true);
      };
      const queries = buildReportQueries(report);
      // Server records have no device type, so they are only fetched for the all-devices view.
      const wantsCanonical = canonicalReports.has(report.report) && report.device === "all";
      let partial = false;
      const [rows, secondary, canonical] = await Promise.all([
        runQuery(queries.main),
        queries.secondary
          ? runQuery(queries.secondary).catch(() => { partial = true; return null; })
          : Promise.resolve(undefined),
        wantsCanonical
          ? acceptedInquiries(service, report).catch(() => { partial = true; return null; })
          : Promise.resolve(null),
      ]);
      const payload = shapeReport(report, rows, { secondary, canonical });
      // A report with a failed part is shown but not stored, so the next request tries again
      // instead of serving the gap as a result for the cache lifetime.
      if (partial) return reply({ status: "ready", report: report.report, ...payload, dashboardUrl, updatedAt: new Date().toISOString(), stale: false, partial: true, timezone });
      const fetchedAt = new Date().toISOString();
      const { error: saveError } = await service.from("website_analytics_cache").update({ payload, fetched_at: fetchedAt, refresh_after: new Date(Date.now() + 300_000).toISOString() }).eq("cache_key", cacheKey);
      if (saveError) throw new Error("Unable to save analytics cache");
      // Bound storage to recent aggregate entries, not an ever-growing analytics database.
      await service.from("website_analytics_cache").delete().lt("fetched_at", new Date(Date.now() - 2 * 86400_000).toISOString());
      return responseFrom({ payload, fetched_at: fetchedAt }, false);
    } catch (error) {
      const failure = error instanceof Error && /^PostHog returned \d+$/.test(error.message) ? error.message : "query_failed";
      console.error("Website analytics refresh failed:", report.report, error instanceof Error ? error.message : "Unknown error");
      return cached?.payload
        ? responseFrom(cached, true, failure)
        : reply({ status: "unavailable", report: report.report, dashboardUrl, failure, message: "Traffic temporarily unavailable", timezone });
    }
  } catch {
    return reply({ error: "Analytics unavailable" }, 503);
  }
});

// Accepted inquiries from server records: counts and campaign tags only.
// deno-lint-ignore no-explicit-any
type ServiceClient = any;

async function acceptedInquiries(
  service: ServiceClient,
  report: { start: string; end: string; previousStart: string; previousEnd: string; days: number; includesToday: boolean },
) {
  const projectId = publicIntakeProjectId(Deno.env.toObject());
  if (!projectId) return null;
  const from = new Date(`${report.previousStart}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${report.end}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  const { data, error } = await service.from("quote_requests")
    .select("created_at,source_url")
    .eq("project_id", projectId)
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString())
    .limit(5_000);
  if (error) throw error;
  return summarizeAcceptedInquiries((data ?? []) as Array<{ created_at?: string; source_url?: string | null }>, report);
}
