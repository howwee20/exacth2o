import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  capabilityForSessionMode,
  deviceIsReady,
  gasMixerSessionTtlSeconds,
  normalizeSessionMode,
  sessionExpiresAt,
} from "./session-policy.mjs";

const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
const gasMixerDeviceId = "gas-mixer:b827eb548a44";
const frameBucket = "gas-mixer-frames";
const framePath = `${gasMixerDeviceId}/latest.png`;

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
  const allowedOrigin = origin && allowedOrigins.has(origin)
    ? origin
    : "https://exacth2o.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
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

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
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

serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("authorization") ?? "";

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(
      { error: "Session service is not configured" },
      503,
      origin,
    );
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
    mode?: string;
    session_token?: string;
    event_type?: string;
    normalized_x?: number;
    normalized_y?: number;
  };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "A JSON body is required" }, 400, origin);
  }

  if (payload.action === "status") {
    const { data, error } = await userClient.rpc("gas_mixer_remote_status", {
      requested_project_id: gasMixerProjectId,
      requested_device_id: gasMixerDeviceId,
    });
    if (error) {
      return jsonResponse(
        { error: error.message },
        error.code === "42501" ? 403 : 503,
        origin,
      );
    }
    return jsonResponse({ ok: true, status: data }, 200, origin);
  }

  if (
    payload.action === "send_input" || payload.action === "end_session" ||
    payload.action === "refresh_session" || payload.action === "refresh_frame"
  ) {
    if (
      typeof payload.session_token !== "string" ||
      payload.session_token.length < 32
    ) {
      return jsonResponse(
        { error: "A valid session token is required" },
        401,
        origin,
      );
    }
    const tokenHash = await sha256Hex(payload.session_token);
    const { data: activeSession, error: activeSessionError } =
      await serviceClient
        .from("gas_mixer_remote_sessions")
        .select("id,user_id,mode,status,expires_at")
        .eq("project_id", gasMixerProjectId)
        .eq("device_id", gasMixerDeviceId)
        .eq("token_hash", tokenHash)
        .eq("user_id", userData.user.id)
        .in("status", ["issued", "connected"])
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
    if (activeSessionError || !activeSession) {
      return jsonResponse(
        { error: "The remote session is invalid or expired" },
        403,
        origin,
      );
    }

    if (
      payload.action === "refresh_session" ||
      payload.action === "refresh_frame"
    ) {
      const capability = capabilityForSessionMode(activeSession.mode);
      const { data: allowed, error: accessError } = await userClient.rpc(
        "has_system_admin_installation_access",
        {
          check_project_id: gasMixerProjectId,
          check_device_id: gasMixerDeviceId,
          check_capability: capability,
        },
      );
      if (accessError || allowed !== true) {
        return jsonResponse(
          { error: "System-admin installation access is required" },
          403,
          origin,
        );
      }

      const { data: deviceStatus, error: deviceError } = await serviceClient
        .from("gas_mixer_device_status")
        .select("connected,last_heartbeat_at,local_session_available")
        .eq("project_id", gasMixerProjectId)
        .eq("device_id", gasMixerDeviceId)
        .maybeSingle();
      if (deviceError || !deviceIsReady(deviceStatus)) {
        return jsonResponse(
          { error: "The Gas Mixer agent is not online" },
          409,
          origin,
        );
      }

      if (payload.action === "refresh_frame") {
        const { data: refreshedFrameLink, error: refreshedFrameLinkError } =
          await serviceClient.storage.from(frameBucket).createSignedUrl(
            framePath,
            gasMixerSessionTtlSeconds,
          );
        if (refreshedFrameLinkError || !refreshedFrameLink?.signedUrl) {
          return jsonResponse(
            { error: "Unable to refresh the live mixer frame" },
            503,
            origin,
          );
        }

        return jsonResponse(
          { ok: true, frame_url: refreshedFrameLink.signedUrl },
          200,
          origin,
        );
      }

      const renewedExpiresAt = sessionExpiresAt();
      const { data: renewedSession, error: renewalError } = await serviceClient
        .from("gas_mixer_remote_sessions")
        .update({
          expires_at: renewedExpiresAt,
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", activeSession.id)
        .select("id,mode,issued_at,expires_at")
        .single();
      if (renewalError || !renewedSession) {
        return jsonResponse(
          { error: "Unable to renew the remote session" },
          503,
          origin,
        );
      }

      const { data: renewedFrameLink, error: renewedFrameLinkError } =
        await serviceClient.storage.from(frameBucket).createSignedUrl(
          framePath,
          gasMixerSessionTtlSeconds,
        );
      if (renewedFrameLinkError || !renewedFrameLink?.signedUrl) {
        return jsonResponse(
          { error: "Unable to renew the live mixer frame" },
          503,
          origin,
        );
      }

      return jsonResponse(
        {
          ok: true,
          session: renewedSession,
          frame_url: renewedFrameLink.signedUrl,
          session_token: payload.session_token,
        },
        200,
        origin,
      );
    }

    if (payload.action === "end_session") {
      const { error } = await serviceClient.from("gas_mixer_remote_sessions")
        .update({
          status: "ended",
          ended_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
        }).eq("id", activeSession.id);
      return error
        ? jsonResponse(
          { error: "Unable to end the remote session" },
          503,
          origin,
        )
        : jsonResponse({ ok: true }, 200, origin);
    }

    if (activeSession.mode !== "control") {
      return jsonResponse({ error: "This session is view-only" }, 403, origin);
    }
    if (
      payload.event_type !== "tap" ||
      typeof payload.normalized_x !== "number" ||
      typeof payload.normalized_y !== "number" ||
      payload.normalized_x < 0 || payload.normalized_x > 1 ||
      payload.normalized_y < 0 || payload.normalized_y > 1
    ) {
      return jsonResponse(
        { error: "Only normalized tap events are supported" },
        400,
        origin,
      );
    }

    const oneSecondAgo = new Date(Date.now() - 1_000).toISOString();
    const { count } = await serviceClient.from("gas_mixer_remote_commands")
      .select("id", { count: "exact", head: true })
      .eq("session_id", activeSession.id)
      .gte("created_at", oneSecondAgo);
    if ((count ?? 0) >= 8) {
      return jsonResponse({ error: "Input rate limit exceeded" }, 429, origin);
    }

    const { data: command, error: commandError } = await serviceClient
      .from("gas_mixer_remote_commands")
      .insert({
        project_id: gasMixerProjectId,
        device_id: gasMixerDeviceId,
        session_id: activeSession.id,
        requested_by: userData.user.id,
        event_type: "tap",
        normalized_x: payload.normalized_x,
        normalized_y: payload.normalized_y,
      })
      .select("id,created_at,expires_at")
      .single();
    if (commandError) {
      return jsonResponse(
        { error: "Unable to queue mixer input" },
        503,
        origin,
      );
    }
    await serviceClient.from("gas_mixer_remote_sessions").update({
      status: "connected",
      connected_at: activeSession.status === "issued"
        ? new Date().toISOString()
        : undefined,
      last_activity_at: new Date().toISOString(),
    }).eq("id", activeSession.id);
    return jsonResponse({ ok: true, command }, 201, origin);
  }

  if (payload.action !== "create_session") {
    return jsonResponse({ error: "Unsupported action" }, 400, origin);
  }

  let mode: "view" | "control";
  try {
    mode = normalizeSessionMode(payload.mode) as "view" | "control";
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Invalid session mode",
      },
      400,
      origin,
    );
  }

  const capability = capabilityForSessionMode(mode);
  const { data: allowed, error: accessError } = await userClient.rpc(
    "has_system_admin_installation_access",
    {
      check_project_id: gasMixerProjectId,
      check_device_id: gasMixerDeviceId,
      check_capability: capability,
    },
  );
  if (accessError || allowed !== true) {
    return jsonResponse(
      { error: "System-admin installation access is required" },
      403,
      origin,
    );
  }

  const { data: deviceStatus, error: deviceError } = await serviceClient
    .from("gas_mixer_device_status")
    .select("connected,last_heartbeat_at,local_session_available")
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .maybeSingle();
  if (deviceError || !deviceIsReady(deviceStatus)) {
    return jsonResponse(
      { error: "The Gas Mixer agent is not online" },
      409,
      origin,
    );
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const sessionToken = base64Url(tokenBytes);
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = sessionExpiresAt();

  const now = new Date().toISOString();
  await serviceClient.from("gas_mixer_remote_sessions").update({
    status: "expired",
    ended_at: now,
    last_activity_at: now,
  })
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .in("status", ["issued", "connected"])
    .lt("expires_at", now);

  if (mode === "control") {
    await serviceClient.from("gas_mixer_remote_sessions").update({
      status: "ended",
      ended_at: now,
      last_activity_at: now,
    })
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("user_id", userData.user.id)
      .eq("mode", "control")
      .in("status", ["issued", "connected"]);
  }

  const { data: session, error: sessionError } = await serviceClient
    .from("gas_mixer_remote_sessions")
    .insert({
      project_id: gasMixerProjectId,
      device_id: gasMixerDeviceId,
      user_id: userData.user.id,
      mode,
      token_hash: tokenHash,
      expires_at: expiresAt,
      metadata: {
        portal_origin: origin,
        single_controller: true,
      },
    })
    .select("id,mode,issued_at,expires_at")
    .single();

  if (sessionError) {
    const activeController = sessionError.code === "23505";
    return jsonResponse(
      {
        error: activeController
          ? "Another control session is already active"
          : "Unable to create a remote session",
      },
      activeController ? 409 : 503,
      origin,
    );
  }

  const { data: frameLink, error: frameLinkError } = await serviceClient.storage
    .from(frameBucket)
    .createSignedUrl(framePath, gasMixerSessionTtlSeconds);
  if (frameLinkError || !frameLink?.signedUrl) {
    await serviceClient.from("gas_mixer_remote_sessions").update({
      status: "failed",
      ended_at: new Date().toISOString(),
      metadata: { failure: "frame_link_unavailable" },
    }).eq("id", session.id);
    return jsonResponse(
      { error: "The live mixer frame is not available yet" },
      409,
      origin,
    );
  }

  return jsonResponse(
    {
      ok: true,
      session,
      frame_url: frameLink.signedUrl,
      session_token: sessionToken,
    },
    201,
    origin,
  );
});
