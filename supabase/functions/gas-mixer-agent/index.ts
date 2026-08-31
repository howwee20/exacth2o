import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
const gasMixerDeviceId = "gas-mixer:b827eb548a44";
const frameBucket = "gas-mixer-frames";
const framePath = `${gasMixerDeviceId}/latest.png`;
const maximumFrameBytes = 524_288;

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

serve(async (request) => {
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
  if (action === "heartbeat") {
    const localSessionAvailable = payload.local_session_available === true;
    const { error } = await serviceClient.from("gas_mixer_device_status")
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
        local_session_available: localSessionAvailable,
        metadata: {
          width: Number.isInteger(payload.width) ? payload.width : null,
          height: Number.isInteger(payload.height) ? payload.height : null,
        },
        updated_at: new Date().toISOString(),
      });
    if (error) return response({ error: "Unable to record heartbeat" }, 503);
    return response({ ok: true, server_time: new Date().toISOString() });
  }

  if (action === "frame") {
    if (typeof payload.png_base64 !== "string") {
      return response({ error: "PNG frame is required" }, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(payload.png_base64);
    } catch {
      return response({ error: "Frame encoding is invalid" }, 400);
    }
    if (!isPng(bytes) || bytes.byteLength > maximumFrameBytes) {
      return response(
        { error: "Frame must be a PNG no larger than 512 KiB" },
        413,
      );
    }
    const { error: uploadError } = await serviceClient.storage
      .from(frameBucket)
      .upload(framePath, bytes, {
        contentType: "image/png",
        cacheControl: "0",
        upsert: true,
      });
    if (uploadError) {
      return response({ error: "Unable to store mixer frame" }, 503);
    }
    await serviceClient.from("gas_mixer_device_status").update({
      connected: true,
      last_heartbeat_at: new Date().toISOString(),
      local_session_available: true,
      updated_at: new Date().toISOString(),
    }).eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId);
    return response({ ok: true });
  }

  if (action === "poll") {
    const now = new Date().toISOString();
    await serviceClient.from("gas_mixer_remote_commands")
      .update({ status: "expired", completed_at: now })
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("status", "queued")
      .lt("expires_at", now);

    const { data, error } = await serviceClient.from(
      "gas_mixer_remote_commands",
    )
      .select("id,event_type,normalized_x,normalized_y,created_at,expires_at")
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("status", "queued")
      .gt("expires_at", now)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) return response({ error: "Unable to poll mixer commands" }, 503);
    return response({ ok: true, commands: data ?? [] });
  }

  if (action === "ack") {
    const commandIds = Array.isArray(payload.command_ids)
      ? payload.command_ids.filter((value): value is string =>
        typeof value === "string"
      ).slice(0, 20)
      : [];
    const commandStatus = payload.status === "failed" ? "failed" : "executed";
    if (commandIds.length === 0) {
      return response({ error: "Command IDs are required" }, 400);
    }
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
    if (error) {
      return response({ error: "Unable to acknowledge mixer commands" }, 503);
    }
    return response({ ok: true });
  }

  return response({ error: "Unsupported action" }, 400);
});
