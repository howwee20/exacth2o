import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  agentPollBudget,
  holdQuietly,
  holdUntilWork,
  isAttended,
  syncHoldMs,
} from "../_shared/agent-polling.mjs";
import { agentWakeKey, openWakeListener } from "../_shared/agent-wake.mjs";
import { postgresWakeConnector } from "../_shared/agent-wake-postgres.ts";
import { splitExpiredCommands } from "../_shared/gas-mixer-native-policy.mjs";

const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
const gasMixerDeviceId = "gas-mixer:b827eb548a44";
const frameBucket = "gas-mixer-frames";
const framePath = `${gasMixerDeviceId}/latest.png`;
const maximumFrameBytes = 524_288;
const wakeConnector = postgresWakeConnector(Deno.env.get("SUPABASE_DB_URL"));

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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isPng(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);
}

// deno-lint-ignore no-explicit-any
type ServiceClient = SupabaseClient<any, "public", any>;
type Listener = Awaited<ReturnType<typeof openWakeListener>>;

serve(async (request) => {
  const startedAt = performance.now();
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const deviceToken = request.headers.get("x-device-token") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return response({ error: "Agent service is not configured" }, 503);
  }
  if (deviceToken.length < 32) {
    return response({ error: "Device authentication is required" }, 401);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const tokenHash = await sha256Hex(deviceToken);
  const { data: credential, error: credentialError } = await serviceClient
    .from("gas_mixer_agent_credentials")
    .select("enabled")
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (credentialError || !credential?.enabled) {
    return response({ error: "Device authentication failed" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return response({ error: "A JSON body is required" }, 400);
  }

  const action = payload.action;
  const holds = action === "heartbeat" || action === "frame" || action === "poll" || action === "sync";
  const listenerPromise = holds
    ? openWakeListener(wakeConnector, agentWakeKey("screen", gasMixerDeviceId), {
      timeoutMs: agentPollBudget.wakeConnectTimeoutMs,
      log: (error: unknown) => console.warn("screen wake listener unavailable", String(error)),
    })
    : Promise.resolve(null);
  try {
    return await handle(serviceClient, payload, request.signal, startedAt, listenerPromise);
  } finally {
    await (await listenerPromise)?.close();
  }
});

async function handle(
  serviceClient: ServiceClient,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  startedAt: number,
  listenerPromise: Promise<Listener>,
) {
  const action = payload.action;
  const legacyDeadline = startedAt + agentPollBudget.pythonResponseBudgetMs;

  if (action === "heartbeat") {
    // Listen before the write reports attention, so a session opened after
    // it still wakes this request.
    const listener = await listenerPromise;
    const recorded = await recordHeartbeat(serviceClient, payload);
    if (recorded.error) return response({ error: "Unable to record heartbeat" }, 503);
    // No open session: park the installed agent's sequential loop here until
    // a session or tap appears instead of capturing frames nobody watches.
    if (!isAttended(recorded.attentionUntil)) {
      await holdQuietly({ deadline: legacyDeadline, listener, signal });
    }
    return response({ ok: true, server_time: new Date().toISOString() });
  }

  if (action === "frame") {
    if (typeof payload.png_base64 !== "string") {
      return response({ error: "PNG frame is required" }, 400);
    }
    const listener = await listenerPromise;
    const stored = await storeFrame(serviceClient, payload.png_base64);
    if (stored.response) return stored.response;
    if (!isAttended(stored.attentionUntil)) {
      await holdQuietly({ deadline: legacyDeadline, listener, signal });
    }
    return response({ ok: true });
  }

  if (action === "poll") {
    // Listen before checking sessions, so a session opened after the check
    // still wakes this request.
    const listener = await listenerPromise;
    const sessions = await activeSessions(serviceClient);
    if (sessions.error) return response({ error: "Unable to check mixer sessions" }, 503);
    // Keep live view/control responsive: during a session the agent captures
    // frames between short polls; a tap wakes the poll immediately.
    const deadline = sessions.active
      ? startedAt + agentPollBudget.screenSessionHoldMs
      : legacyDeadline;
    const { data, error } = await holdUntilWork(() => readQueuedTaps(serviceClient), { deadline, listener, signal });
    if (error) return response({ error: "Unable to poll mixer commands" }, 503);
    return response({ ok: true, commands: data ?? [] });
  }

  if (action === "ack") {
    const result = await recordAcknowledgement(serviceClient, payload);
    if (result === "invalid") return response({ error: "Command IDs are required" }, 400);
    if (result === "error") {
      return response({ error: "Unable to acknowledge mixer commands" }, 503);
    }
    return response({ ok: true });
  }

  // Protocol 2: one call is the heartbeat, the tap poll, acknowledgements and,
  // only while a session is open, the newest frame.
  if (action === "sync" && payload.protocol === 2) {
    const acks = Array.isArray(payload.acks) ? payload.acks.slice(0, 20) : [];
    const ackResults = [];
    for (const ack of acks) {
      const result = ack && typeof ack === "object"
        ? await recordAcknowledgement(serviceClient, ack as Record<string, unknown>)
        : "invalid";
      ackResults.push({
        command_ids: Array.isArray((ack as Record<string, unknown>)?.command_ids)
          ? (ack as Record<string, unknown>).command_ids
          : [],
        recorded: result === "recorded",
        retry: result === "error",
      });
    }
    const ackRetry = ackResults.some((result) => result.retry);
    const recorded = await recordHeartbeat(serviceClient, payload);
    if (recorded.error) return response({ error: "Unable to record heartbeat" }, 503);
    let attended = isAttended(recorded.attentionUntil);
    if (attended && typeof payload.frame_png_base64 === "string") {
      const stored = await storeFrame(serviceClient, payload.frame_png_base64);
      if (stored.response) return stored.response;
    }
    const listener = await listenerPromise;
    const sessions = await activeSessions(serviceClient);
    if (sessions.error) return response({ error: "Unable to check mixer sessions" }, 503);
    attended = sessions.active;
    const requestedHold = ackRetry ? 0 : syncHoldMs(payload.hold_ms, payload.client_timeout_ms);
    const holdMs = attended ? Math.min(requestedHold, 1000) : requestedHold;
    const { data, error } = await holdUntilWork(() => readQueuedTaps(serviceClient), {
      deadline: startedAt + holdMs,
      listener,
      signal,
    });
    if (error) return response({ error: "Unable to poll mixer commands" }, 503);
    return response({
      ok: true,
      protocol: 2,
      server_time: new Date().toISOString(),
      commands: data ?? [],
      acks: ackResults,
      attended,
      next: {
        hold_ms: attended ? 1000 : agentPollBudget.syncHoldMaxMs,
        frame_interval_ms: attended ? 1250 : null,
      },
    });
  }

  return response({ error: "Unsupported action" }, 400);
}

async function recordHeartbeat(serviceClient: ServiceClient, payload: Record<string, unknown>) {
  const { data, error } = await serviceClient.from("gas_mixer_device_status")
    .upsert({
      project_id: gasMixerProjectId,
      device_id: gasMixerDeviceId,
      connected: true,
      last_heartbeat_at: new Date().toISOString(),
      agent_version: typeof payload.agent_version === "string"
        ? payload.agent_version.slice(0, 80)
        : null,
      capture_backend: typeof payload.capture_backend === "string"
        ? payload.capture_backend.slice(0, 80)
        : null,
      local_session_available: payload.local_session_available === true,
      metadata: {
        width: Number.isInteger(payload.width) ? payload.width : null,
        height: Number.isInteger(payload.height) ? payload.height : null,
      },
      updated_at: new Date().toISOString(),
    })
    .select("agent_attention_until")
    .maybeSingle();
  return { error, attentionUntil: data?.agent_attention_until };
}

async function storeFrame(serviceClient: ServiceClient, pngBase64: string) {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(pngBase64);
  } catch {
    return { response: response({ error: "Frame encoding is invalid" }, 400) };
  }
  if (!isPng(bytes) || bytes.byteLength > maximumFrameBytes) {
    return {
      response: response(
        { error: "Frame must be a PNG no larger than 512 KiB" },
        413,
      ),
    };
  }
  const { error: uploadError } = await serviceClient.storage
    .from(frameBucket)
    .upload(framePath, bytes, {
      contentType: "image/png",
      cacheControl: "0",
      upsert: true,
    });
  if (uploadError) {
    return { response: response({ error: "Unable to store mixer frame" }, 503) };
  }
  const { data } = await serviceClient.from("gas_mixer_device_status").update({
    connected: true,
    last_heartbeat_at: new Date().toISOString(),
    local_session_available: true,
    updated_at: new Date().toISOString(),
  }).eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId)
    .select("agent_attention_until").maybeSingle();
  return { attentionUntil: data?.agent_attention_until };
}

async function activeSessions(serviceClient: ServiceClient) {
  const { data, error } = await serviceClient
    .from("gas_mixer_remote_sessions")
    .select("id")
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .in("status", ["issued", "connected"])
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  return { error, active: Boolean(data?.length) };
}

async function readQueuedTaps(serviceClient: ServiceClient) {
  const { data, error } = await serviceClient.from("gas_mixer_remote_commands")
    .select("id,event_type,normalized_x,normalized_y,created_at,expires_at")
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) return { data: null, error };
  const { deliverable, expired } = splitExpiredCommands(data ?? [], Date.now());
  if (expired.length) {
    await serviceClient.from("gas_mixer_remote_commands")
      .update({ status: "expired", completed_at: new Date().toISOString() })
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("status", "queued")
      .in("id", expired.map((command) => command.id));
  }
  return { data: deliverable, error: null };
}

async function recordAcknowledgement(serviceClient: ServiceClient, payload: Record<string, unknown>) {
  const commandIds = Array.isArray(payload.command_ids)
    ? payload.command_ids.filter((value): value is string =>
      typeof value === "string"
    ).slice(0, 20)
    : [];
  const commandStatus = payload.status === "failed" ? "failed" : "executed";
  if (commandIds.length === 0) return "invalid";
  const { error } = await serviceClient.from("gas_mixer_remote_commands")
    .update({
      status: commandStatus,
      completed_at: new Date().toISOString(),
      error_message:
        commandStatus === "failed" && typeof payload.error === "string"
          ? payload.error.slice(0, 240)
          : null,
    })
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .eq("status", "queued")
    .in("id", commandIds);
  return error ? "error" : "recorded";
}
