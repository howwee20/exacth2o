import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  applyNativeField,
  bridgeIsReady,
  normalizeNativeField,
} from "../_shared/gas-mixer-native-policy.mjs";

const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
const gasMixerDeviceId = "gas-mixer:b827eb548a44";
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
    return jsonResponse({ error: "Native mixer control is not configured" }, 503, origin);
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
    field?: string;
    value?: unknown;
    expected_revision?: number;
    idempotency_key?: string;
  };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "A JSON body is required" }, 400, origin);
  }
  if (payload.action !== "set_field") {
    return jsonResponse({ error: "Unsupported action" }, 400, origin);
  }

  let normalized: { field: string; value: number | boolean };
  try {
    normalized = normalizeNativeField(payload.field, payload.value);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid mixer field" }, 400, origin);
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
      check_project_id: gasMixerProjectId,
      check_device_id: gasMixerDeviceId,
      check_capability: "remote_control",
    },
  );
  if (accessError || allowed !== true) {
    return jsonResponse({ error: "System-admin installation access is required" }, 403, origin);
  }

  const { data: existing } = await serviceClient.from("gas_mixer_native_commands")
    .select("id,status,created_at,expires_at")
    .eq("idempotency_key", payload.idempotency_key)
    .eq("requested_by", userData.user.id)
    .maybeSingle();
  if (existing) return jsonResponse({ ok: true, command: existing }, 200, origin);

  const { data: deviceState, error: stateError } = await serviceClient
    .from("gas_mixer_native_device_state")
    .select("bridge_connected,bridge_ready,last_bridge_at,state_revision,requested_state,observed_state")
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .maybeSingle();
  if (stateError || !deviceState) {
    return jsonResponse({ error: "Native mixer state is unavailable" }, 503, origin);
  }
  if (!bridgeIsReady(deviceState)) {
    return jsonResponse({ error: "The native mixer bridge is awaiting commissioning" }, 409, origin);
  }
  if (deviceState.state_revision !== payload.expected_revision) {
    return jsonResponse({ error: "The mixer changed; refresh before applying this value" }, 409, origin);
  }
  const fieldParts = normalized.field.split(".");
  if (fieldParts[0] === "mfc" && deviceState.observed_state?.channels?.[fieldParts[1]]?.available !== true) {
    return jsonResponse({ error: `MFC ${fieldParts[1]} is unavailable` }, 409, origin);
  }

  const oneSecondAgo = new Date(Date.now() - 1_000).toISOString();
  const { count } = await serviceClient.from("gas_mixer_native_commands")
    .select("id", { count: "exact", head: true })
    .eq("requested_by", userData.user.id)
    .gte("created_at", oneSecondAgo);
  if ((count ?? 0) >= 12) {
    return jsonResponse({ error: "Mixer input rate limit exceeded" }, 429, origin);
  }

  let requestedState: Record<string, unknown>;
  try {
    requestedState = applyNativeField(deviceState.requested_state, normalized.field, normalized.value);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Unable to calculate mixer state" }, 400, origin);
  }

  const { data: command, error: commandError } = await serviceClient
    .from("gas_mixer_native_commands")
    .insert({
      project_id: gasMixerProjectId,
      device_id: gasMixerDeviceId,
      requested_by: userData.user.id,
      command_type: "set_field",
      payload: normalized,
      expected_revision: payload.expected_revision,
      idempotency_key: payload.idempotency_key,
    })
    .select("id,status,created_at,expires_at")
    .single();
  if (commandError || !command) {
    return jsonResponse({ error: "Unable to queue the mixer value" }, 503, origin);
  }

  const { data: updatedState, error: updateError } = await serviceClient.from("gas_mixer_native_device_state")
    .update({ requested_state: requestedState, updated_at: new Date().toISOString() })
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .eq("state_revision", payload.expected_revision)
    .select("state_revision")
    .maybeSingle();
  if (updateError || !updatedState) {
    await serviceClient.from("gas_mixer_native_commands").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: "Unable to record requested state",
    }).eq("id", command.id);
    return jsonResponse({ error: "Unable to record the mixer request" }, 503, origin);
  }

  return jsonResponse({ ok: true, command, requested_state: requestedState }, 201, origin);
});
