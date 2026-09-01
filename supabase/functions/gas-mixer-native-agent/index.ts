import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { normalizeNativeMachineState } from "../_shared/gas-mixer-native-policy.mjs";

const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
const gasMixerDeviceId = "gas-mixer:b827eb548a44";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

serve(async (request) => {
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const deviceToken = request.headers.get("x-device-token") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return response({ error: "Native mixer agent is not configured" }, 503);
  if (deviceToken.length < 32) return response({ error: "Device authentication is required" }, 401);

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const tokenHash = await sha256Hex(deviceToken);
  const { data: credential, error: credentialError } = await serviceClient
    .from("gas_mixer_agent_credentials")
    .select("enabled")
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (credentialError || !credential?.enabled) return response({ error: "Device authentication failed" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return response({ error: "A JSON body is required" }, 400);
  }

  const now = new Date().toISOString();
  if (payload.action === "heartbeat") {
    const { error } = await serviceClient.from("gas_mixer_native_device_state").update({
      bridge_connected: true,
      bridge_ready: payload.bridge_ready === true,
      bridge_version: typeof payload.bridge_version === "string" ? payload.bridge_version.slice(0, 80) : null,
      last_bridge_at: now,
      metadata: {
        commissioning_state: payload.bridge_ready === true ? "ready" : "bridge_pending",
        existing_screen_bridge_preserved: true,
      },
      updated_at: now,
    }).eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId);
    return error ? response({ error: "Unable to record bridge heartbeat" }, 503) : response({ ok: true, server_time: now });
  }

  if (payload.action === "state") {
    let appliedState: Record<string, unknown>;
    let observedState: Record<string, unknown>;
    try {
      appliedState = normalizeNativeMachineState(payload.applied_state);
      observedState = normalizeNativeMachineState(payload.observed_state);
    } catch (error) {
      return response({ error: error instanceof Error ? error.message : "Invalid mixer state" }, 400);
    }
    if (!Number.isInteger(payload.state_revision) || (payload.state_revision as number) < 0) {
      return response({ error: "A valid state revision is required" }, 400);
    }
    const stateUpdate: Record<string, unknown> = {
      bridge_connected: true,
      bridge_ready: true,
      last_bridge_at: now,
      state_revision: payload.state_revision,
      applied_state: appliedState,
      observed_state: observedState,
      updated_at: now,
    };
    if (payload.sync_requested === true) stateUpdate.requested_state = appliedState;
    const { data, error } = await serviceClient.from("gas_mixer_native_device_state").update(stateUpdate)
      .eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId)
      .lte("state_revision", payload.state_revision as number)
      .select("state_revision")
      .maybeSingle();
    if (error) return response({ error: "Unable to record mixer state" }, 503);
    return data ? response({ ok: true }) : response({ error: "Stale mixer state was ignored" }, 409);
  }

  if (payload.action === "poll") {
    await serviceClient.from("gas_mixer_native_commands").update({
      status: "expired",
      completed_at: now,
      error_message: "Command expired before the bridge accepted it",
    })
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("status", "queued")
      .lt("expires_at", now);
    const { data, error } = await serviceClient.from("gas_mixer_native_commands")
      .select("id,command_type,payload,expected_revision,created_at,expires_at")
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("status", "queued")
      .gt("expires_at", now)
      .order("created_at", { ascending: true })
      .limit(10);
    return error ? response({ error: "Unable to poll native mixer commands" }, 503) : response({ ok: true, commands: data ?? [] });
  }

  if (payload.action === "ack") {
    const commandId = typeof payload.command_id === "string" ? payload.command_id : "";
    const status = typeof payload.status === "string" ? payload.status : "";
    const allowedStatuses = new Set(["accepted", "applied", "verified", "rejected", "failed"]);
    if (!/^[0-9a-f-]{36}$/i.test(commandId) || !allowedStatuses.has(status)) {
      return response({ error: "A valid command acknowledgement is required" }, 400);
    }
    const timestamps: Record<string, string> = {};
    if (status === "accepted") timestamps.accepted_at = now;
    if (status === "applied" || status === "verified") timestamps.applied_at = now;
    if (status === "verified" || status === "rejected" || status === "failed") timestamps.completed_at = now;
    const { error } = await serviceClient.from("gas_mixer_native_commands").update({
      status,
      ...timestamps,
      error_message: (status === "rejected" || status === "failed") && typeof payload.error === "string"
        ? payload.error.slice(0, 240)
        : null,
    })
      .eq("id", commandId)
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .in("status", ["queued", "accepted", "applied"]);
    return error ? response({ error: "Unable to acknowledge native mixer command" }, 503) : response({ ok: true });
  }

  return response({ error: "Unsupported action" }, 400);
});
