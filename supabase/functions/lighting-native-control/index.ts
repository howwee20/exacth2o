import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  lightingBridgeIsReady,
  normalizeLightingIntensity,
} from "../_shared/lighting-native-policy.mjs";

const projectId = "44444444-4444-4444-8444-444444444441";
const deviceId = "lighting:beagle";
const allowedOrigins = new Set([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  "http://exacth2o.com",
  "http://www.exacth2o.com",
  "https://howwee20.github.io",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : "https://exacth2o.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Lighting control is not configured" }, 503, origin);
  }
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return jsonResponse({ error: "Authentication is required" }, 401, origin);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse({ error: "Authentication is required" }, 401, origin);
  }

  let payload: {
    action?: string;
    intensity?: unknown;
    expected_revision?: number;
    idempotency_key?: string;
  };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "A JSON body is required" }, 400, origin);
  }
  if (payload.action !== "set_intensity") {
    return jsonResponse({ error: "Unsupported action" }, 400, origin);
  }

  let intensity: number;
  try {
    intensity = normalizeLightingIntensity(payload.intensity);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "Invalid light intensity",
    }, 400, origin);
  }
  if (!Number.isInteger(payload.expected_revision) || (payload.expected_revision ?? -1) < 0) {
    return jsonResponse({ error: "A valid state revision is required" }, 400, origin);
  }
  if (typeof payload.idempotency_key !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.idempotency_key)) {
    return jsonResponse({ error: "A valid idempotency key is required" }, 400, origin);
  }

  const { data: allowed, error: accessError } = await userClient.rpc(
    "has_system_admin_installation_access",
    {
      check_project_id: projectId,
      check_device_id: deviceId,
      check_capability: "remote_control",
    },
  );
  if (accessError || allowed !== true) {
    return jsonResponse({ error: "System-admin installation access is required" }, 403, origin);
  }

  const { data: existing } = await serviceClient.from("lighting_commands")
    .select("id,status,intensity,created_at,expires_at")
    .eq("idempotency_key", payload.idempotency_key)
    .eq("requested_by", userData.user.id)
    .maybeSingle();
  if (existing) return jsonResponse({ ok: true, command: existing }, 200, origin);

  const { data: state, error: stateError } = await serviceClient
    .from("lighting_device_state")
    .select("bridge_connected,bridge_ready,last_bridge_at,state_revision")
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (stateError || !state) {
    return jsonResponse({ error: "Lighting state is unavailable" }, 503, origin);
  }
  if (!lightingBridgeIsReady(state)) {
    return jsonResponse({ error: "The lighting bridge is awaiting commissioning" }, 409, origin);
  }
  if (state.state_revision !== payload.expected_revision) {
    return jsonResponse({ error: "The lights changed; refresh before applying this value" }, 409, origin);
  }

  const oneSecondAgo = new Date(Date.now() - 1_000).toISOString();
  const { count } = await serviceClient.from("lighting_commands")
    .select("id", { count: "exact", head: true })
    .eq("requested_by", userData.user.id)
    .gte("created_at", oneSecondAgo);
  if ((count ?? 0) >= 3) {
    return jsonResponse({ error: "Lighting input rate limit exceeded" }, 429, origin);
  }

  const { data: command, error: commandError } = await serviceClient
    .from("lighting_commands")
    .insert({
      project_id: projectId,
      device_id: deviceId,
      requested_by: userData.user.id,
      intensity,
      expected_revision: payload.expected_revision,
      idempotency_key: payload.idempotency_key,
      metadata: { requested_from: "exacth2o_portal" },
    })
    .select("id,status,intensity,created_at,expires_at")
    .single();
  if (commandError || !command) {
    return jsonResponse({ error: "Unable to queue the lighting value" }, 503, origin);
  }

  const { data: updatedState, error: updateError } = await serviceClient
    .from("lighting_device_state")
    .update({ requested_intensity: intensity, updated_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .eq("state_revision", payload.expected_revision)
    .select("state_revision")
    .maybeSingle();
  if (updateError || !updatedState) {
    await serviceClient.from("lighting_commands").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: "Unable to record requested state",
    }).eq("id", command.id);
    return jsonResponse({ error: "Unable to record the lighting request" }, 503, origin);
  }

  return jsonResponse({ ok: true, command }, 201, origin);
});
