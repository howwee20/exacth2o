import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Cache-Control": "no-store",
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply({ error: "Use POST." }, 405);
  try {
    const authorization = request.headers.get("authorization") ?? "";
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
    } = await client.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
    if (!user) return reply({ error: "Sign in to take a reading." }, 401);
    const { projectId, deviceId, sensorId, sensorKey, capabilities } = await request.json();
    if (
      projectId !== Deno.env.get("HEALTH_SYNC_PROJECT_ID") ||
      deviceId !== Deno.env.get("HEALTH_SYNC_DEVICE_ID") ||
      !projectId ||
      !deviceId
    ) {
      return capabilities === true
        ? reply({ singleProbe: false })
        : reply({ error: "Direct capture is unavailable on this installation." }, 409);
    }
    const { data: access } = await client
      .from("portal_access")
      .select("role")
      .eq("access_scope", "project")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!access || !["admin", "researcher"].includes(access.role))
      return reply({ error: "Project operator access required." }, 403);
    const params = new URLSearchParams();
    if (capabilities === true) params.set("capabilities", "1");
    else {
      if (
        !Number.isSafeInteger(sensorId) ||
        sensorId < 1 ||
        typeof sensorKey !== "string" ||
        !sensorKey ||
        sensorKey.length > 120
      )
        return reply({ error: "Select a valid probe." }, 400);
      params.set("id", String(sensorId));
      params.set("key", sensorKey);
    }
    const base = Deno.env.get("OWNER_HEALTH_BASE_URL") || `https://${deviceId}.balena-devices.com/owner-health`;
    const username = Deno.env.get("OWNER_HEALTH_USER") || Deno.env.get("MATT_OWNER_HEALTH_USER");
    const password = Deno.env.get("OWNER_HEALTH_PASSWORD") || Deno.env.get("MATT_OWNER_HEALTH_PASSWORD");
    if (!username || !password) return reply({ error: "Controller connection is unavailable." }, 503);
    const response = await fetch(`${base.replace(/\/$/, "")}/api/bench-sensor-read?${params}`, {
      headers: { Authorization: "Basic " + btoa(username + ":" + password) },
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
    if (capabilities === true && response.status === 404) return reply({ singleProbe: false });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      return reply(
        { error: data.error || "Controller could not read this probe." },
        response.status === 409 ? 409 : 503,
      );
    if (capabilities === true) return reply({ singleProbe: data.singleProbe === true });
    if (data.sensorKey !== sensorKey || !Number.isFinite(data.rawValue))
      return reply({ error: "Controller returned an invalid reading." }, 502);
    return reply({ sensorKey, rawValue: data.rawValue, capturedAt: data.capturedAt || new Date().toISOString() });
  } catch {
    return reply({ error: "Controller connection failed. Try again or enter the reading manually." }, 503);
  }
});
