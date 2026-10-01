import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const allowedOrigins = new Set(["https://exacth2o.com", "https://www.exacth2o.com", "http://localhost:5173", "http://127.0.0.1:5173"]);
const timezone = "America/Detroit";
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

    const project = Deno.env.get("POSTHOG_PROJECT_ID");
    const key = Deno.env.get("POSTHOG_READ_KEY");
    const region = Deno.env.get("POSTHOG_REGION") === "eu" ? "eu" : "us";
    const host = `https://${region}.posthog.com`;
    const dashboardUrl = project && /^\d+$/.test(project) ? `${host}/project/${project}/web` : null;
    if (!key || !dashboardUrl) return reply({ status: "setup", dashboardUrl, message: "Analytics connection pending" });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const cacheKey = `website-v1:${region}:${project}:${today}`;
    const readCache = () => service.from("website_analytics_cache").select("payload,fetched_at").eq("cache_key", cacheKey).maybeSingle();
    const { data: cached, error: cacheError } = await readCache();
    if (cacheError) return reply({ error: "Analytics cache unavailable" }, 503);
    const responseFrom = (row: typeof cached, stale: boolean) => reply({ status: row?.payload ? "ready" : "collecting", ...(row?.payload ?? {}), dashboardUrl, updatedAt: row?.fetched_at ?? null, stale, timezone });
    if (cached?.fetched_at && Date.now() - Date.parse(cached.fetched_at) < 300_000) return responseFrom(cached, false);
    const { data: claimed, error: leaseError } = await service.rpc("claim_website_analytics_refresh", { requested_key: cacheKey });
    if (leaseError) return reply({ error: "Analytics cache unavailable" }, 503);
    if (!claimed) return responseFrom(cached, true);
    try {
      // Query a true distinct 7-day total separately from daily unique counts.
      const where = `timestamp >= toStartOfDay(toTimeZone(now(), '${timezone}')) - INTERVAL 6 DAY AND timestamp <= now()
        AND event IN ('$pageview', 'demo_clicked', 'quote_clicked', 'quote_submitted')
        AND properties.site = 'exacth2o-public' AND properties.internal = false`;
      const aggregates = `uniqExactIf(distinct_id, event = '$pageview') AS visitors,
        countIf(event = 'demo_clicked') AS demo_clicks,
        countIf(event = 'quote_clicked') AS quote_clicks,
        countIf(event = 'quote_submitted') AS inquiries`;
      const query = `SELECT toString(toDate(toTimeZone(timestamp, '${timezone}'))) AS bucket, ${aggregates}
        FROM events WHERE ${where} GROUP BY bucket
        UNION ALL SELECT 'total' AS bucket, ${aggregates} FROM events WHERE ${where}`;
      const result = await fetch(`${host}/api/projects/${project}/query/`, {
        method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query }, refresh: "blocking" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) throw new Error(`PostHog returned ${result.status}`);
      const body = await result.json();
      if (!Array.isArray(body.results) || body.results.some((row: unknown) => !Array.isArray(row) || row.length < 5)) throw new Error("Incomplete query result");
      const counts = (row: unknown[]) => ({ visitors: Number(row[1]) || 0, demoClicks: Number(row[2]) || 0, quoteClicks: Number(row[3]) || 0, inquiries: Number(row[4]) || 0 });
      const total = body.results.find((row: unknown[]) => row[0] === "total");
      const days = Array.from({ length: 7 }, (_, index) => {
        const day = new Date(`${today}T12:00:00Z`); day.setUTCDate(day.getUTCDate() - 6 + index);
        const date = day.toISOString().slice(0, 10);
        const row = body.results.find((r: unknown[]) => r[0] === date);
        return { date, ...counts(row ?? [date, 0, 0, 0, 0]) };
      });
      const payload = { ...counts(total ?? ["total", 0, 0, 0, 0]), days };
      const fetchedAt = new Date().toISOString();
      const { error: saveError } = await service.from("website_analytics_cache").update({ payload, fetched_at: fetchedAt, refresh_after: new Date(Date.now() + 300_000).toISOString() }).eq("cache_key", cacheKey);
      if (saveError) throw new Error("Unable to save analytics cache");
      // Bound storage to the recent cache entries, not an ever-growing analytics database.
      await service.from("website_analytics_cache").delete().lt("fetched_at", new Date(Date.now() - 2 * 86400_000).toISOString());
      return responseFrom({ payload, fetched_at: fetchedAt }, false);
    } catch (error) {
      console.error("Website analytics refresh failed:", error instanceof Error ? error.message : "Unknown error");
      return cached?.payload ? responseFrom(cached, true) : reply({ status: "unavailable", dashboardUrl, message: "Traffic temporarily unavailable" });
    }
  } catch {
    return reply({ error: "Analytics unavailable" }, 503);
  }
});
