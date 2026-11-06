import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  agentPollBudget,
  holdQuietly,
  isAttended,
  paceLightingIdle,
} from "../_shared/agent-polling.mjs";
import { agentWakeKey, openWakeListener } from "../_shared/agent-wake.mjs";
import { postgresWakeConnector } from "../_shared/agent-wake-postgres.ts";
import { splitExpiredCommands } from "../_shared/gas-mixer-native-policy.mjs";
import {
  nextLightingState,
  normalizeLightingControllerIntensity,
} from "../_shared/lighting-native-policy.mjs";

const projectId = "44444444-4444-4444-8444-444444444441";
const deviceId = "lighting:beagle";
const pendingStatuses = ["queued", "received", "validated"];
const wakeConnector = postgresWakeConnector(Deno.env.get("SUPABASE_DB_URL"));

// deno-lint-ignore no-explicit-any
type ServiceClient = SupabaseClient<any, "public", any>;

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

function parseTimestamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

serve(async (request) => {
  const startedAt = performance.now();
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const deviceToken = request.headers.get("x-device-token") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return response({ error: "Lighting agent is not configured" }, 503);
  if (deviceToken.length < 32) return response({ error: "Device authentication is required" }, 401);

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const tokenHash = await sha256Hex(deviceToken);
  const { data: credential, error: credentialError } = await serviceClient
    .from("lighting_agent_credentials")
    .select("enabled")
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
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

  const now = new Date().toISOString();
  if (payload.action === "sync") {
    // The LISTEN connection opens while the sync reads and writes; it is
    // awaited before the pending-command read that decides whether to hold.
    const listenerPromise = openWakeListener(wakeConnector, agentWakeKey("lighting", deviceId), {
      timeoutMs: agentPollBudget.wakeConnectTimeoutMs,
      log: (error: unknown) => console.warn("lighting wake listener unavailable", String(error)),
    });
    try {
      return await sync(serviceClient, payload, now, startedAt, request.signal, listenerPromise);
    } finally {
      await (await listenerPromise)?.close();
    }
  }

  if (payload.action === "result") {
    if (typeof payload.command_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.command_id)) {
      return response({ error: "A valid command id is required" }, 400);
    }
    let controllerIntensity: number;
    try {
      controllerIntensity = normalizeLightingControllerIntensity(payload.controller_intensity);
    } catch (error) {
      return response({
        error: error instanceof Error ? error.message : "Invalid controller state",
      }, 400);
    }

    const { data: command, error: commandError } = await serviceClient
      .from("lighting_commands")
      .select("id,intensity,status,expected_revision")
      .eq("id", payload.command_id)
      .eq("project_id", projectId)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (commandError || !command) return response({ error: "Command was not found" }, 404);
    if (["observed", "failed", "expired"].includes(command.status)) {
      return response({ ok: true, command });
    }

    const applied = payload.success === true && controllerIntensity === command.intensity;
    if (!applied) {
      const errorMessage = typeof payload.error_message === "string"
        ? payload.error_message.slice(0, 500)
        : "The controller did not retain the requested intensity";
      const { data: failed } = await serviceClient.from("lighting_commands").update({
        status: "failed",
        completed_at: now,
        controller_intensity: controllerIntensity,
        error_message: errorMessage,
      }).eq("id", command.id).in("status", ["received", "validated", "applied"])
        .select("id,status,error_message").maybeSingle();
      return response({ ok: true, command: failed ?? command });
    }

    await serviceClient.from("lighting_commands").update({
      status: "applied",
      applied_at: now,
      controller_intensity: controllerIntensity,
      metadata: {
        physical_verification: "unavailable",
        observation: "Control.getIntensity",
      },
    }).eq("id", command.id).in("status", ["received", "validated"]);

    const { data: current, error: currentError } = await serviceClient
      .from("lighting_device_state")
      .select("state_revision,last_nonzero_intensity")
      .eq("project_id", projectId)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (currentError || !current) return response({ error: "Lighting state is unavailable" }, 503);

    const { data: nextState, error: stateError } = await serviceClient
      .from("lighting_device_state")
      .update({
        requested_intensity: controllerIntensity,
        controller_intensity: controllerIntensity,
        last_nonzero_intensity: controllerIntensity === 0
          ? current.last_nonzero_intensity
          : controllerIntensity,
        last_source: "portal",
        state_revision: current.state_revision + 1,
        last_bridge_at: now,
        updated_at: now,
      })
      .eq("project_id", projectId)
      .eq("device_id", deviceId)
      .eq("state_revision", current.state_revision)
      .select("state_revision,controller_intensity,last_nonzero_intensity")
      .maybeSingle();
    if (stateError || !nextState) return response({ error: "Unable to record applied lighting state" }, 409);

    const { data: observed, error: observedError } = await serviceClient
      .from("lighting_commands")
      .update({
        status: "observed",
        observed_at: now,
        completed_at: now,
        controller_intensity: controllerIntensity,
      })
      .eq("id", command.id)
      .eq("status", "applied")
      .select("id,status,intensity,controller_intensity,completed_at")
      .maybeSingle();
    if (observedError || !observed) return response({ error: "Unable to finish command receipt" }, 409);

    return response({ ok: true, command: observed, state: nextState });
  }

  return response({ error: "Unsupported action" }, 400);
});

type Listener = Awaited<ReturnType<typeof openWakeListener>>;

async function sync(
  serviceClient: ServiceClient,
  payload: Record<string, unknown>,
  now: string,
  startedAt: number,
  signal: AbortSignal,
  listenerPromise: Promise<Listener>,
) {
  let controllerIntensity: number;
  try {
    controllerIntensity = normalizeLightingControllerIntensity(payload.controller_intensity);
  } catch (error) {
    return response({
      error: error instanceof Error ? error.message : "Invalid controller state",
    }, 400);
  }

  const { data: current, error: currentError } = await serviceClient
    .from("lighting_device_state")
    .select("state_revision,requested_intensity,controller_intensity,last_nonzero_intensity,last_source,agent_attention_until")
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (currentError || !current) return response({ error: "Lighting state is unavailable" }, 503);

  // Listen before the pending read, so a command committed after it wakes us.
  const listener = await listenerPromise;
  // One read returns pending and expired commands; expiring them needs a
  // second call only when something actually expired.
  const { data: pendingRows } = await serviceClient.from("lighting_commands")
    .select("id,intensity,status,expected_revision,expires_at")
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .in("status", pendingStatuses)
    .order("created_at", { ascending: true })
    .limit(20);
  const { deliverable, expired } = splitExpiredCommands(pendingRows ?? [], Date.now());
  if (expired.length) {
    await serviceClient.from("lighting_commands").update({
      status: "expired",
      completed_at: now,
      error_message: "Command expired before the controller received it",
    }).eq("project_id", projectId)
      .eq("device_id", deviceId)
      .in("status", pendingStatuses)
      .in("id", expired.map((command) => command.id));
  }
  const pending = deliverable[0] ?? null;

  const localChanged = controllerIntensity !== current.controller_intensity;
  if (pending && localChanged) {
    await serviceClient.from("lighting_commands").update({
      status: "failed",
      completed_at: now,
      error_message: "The local controller changed before this command was applied",
    }).eq("id", pending.id).in("status", pendingStatuses);
  }

  const stateUpdate: Record<string, unknown> = {
    bridge_connected: true,
    bridge_ready: payload.bridge_ready === true,
    bridge_version: typeof payload.bridge_version === "string"
      ? payload.bridge_version.slice(0, 80)
      : null,
    last_bridge_at: now,
    controller_process_started_at: parseTimestamp(payload.controller_process_started_at),
    metadata: {
      commissioning_state: payload.bridge_ready === true ? "ready" : "bridge_pending",
      legacy_source_unchanged: true,
      hardware_owner: "PhenoSystemControl.control.io.Control",
      physical_readback_available: false,
      controller_process_id: Number.isInteger(payload.controller_process_id)
        ? payload.controller_process_id
        : null,
    },
    updated_at: now,
  };

  if (localChanged) {
    Object.assign(stateUpdate, nextLightingState(current, controllerIntensity, "local"));
  }

  const { data: synced, error: syncError } = await serviceClient
    .from("lighting_device_state")
    .update(stateUpdate)
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .eq("state_revision", current.state_revision)
    .select("state_revision,controller_intensity,last_nonzero_intensity")
    .maybeSingle();
  if (syncError || !synced) return response({ error: "Unable to synchronize lighting state" }, 409);

  if (!pending || localChanged || payload.bridge_ready !== true) {
    if (!pending && !localChanged && payload.bridge_ready === true) {
      // Idle: hold this sync until a command or viewer appears. A wake ends
      // the hold with no command, so the installed bridge re-syncs 1 s later
      // and the command is validated against fresh controller state, exactly
      // as before. Without a listener, keep the deployed 5 s pacing.
      if (listener) {
        const holdMs = isAttended(current.agent_attention_until)
          ? agentPollBudget.lightingAttendedHoldMs
          : agentPollBudget.javaResponseBudgetMs;
        await holdQuietly({ deadline: startedAt + holdMs, listener, signal });
      } else {
        await paceLightingIdle(startedAt);
      }
    }
    return response({ ok: true, server_time: now, state: synced, command: null });
  }

  if (pending.expected_revision !== synced.state_revision) {
    await serviceClient.from("lighting_commands").update({
      status: "failed",
      completed_at: now,
      error_message: "Controller state changed before command validation",
    }).eq("id", pending.id).in("status", pendingStatuses);
    return response({ ok: true, server_time: now, state: synced, command: null });
  }

  const { data: received, error: receivedError } = await serviceClient
    .from("lighting_commands")
    .update({ status: "received", received_at: now })
    .eq("id", pending.id)
    .eq("status", "queued")
    .select("id,intensity,expected_revision")
    .maybeSingle();
  const command = received ?? (pending.status === "queued" ? null : pending);
  if (receivedError || !command) {
    return response({ ok: true, server_time: now, state: synced, command: null });
  }

  const validatedAt = new Date().toISOString();
  const { data: validated, error: validatedError } = await serviceClient
    .from("lighting_commands")
    .update({ status: "validated", validated_at: validatedAt })
    .eq("id", command.id)
    .in("status", ["received", "validated"])
    .select("id,intensity,expected_revision")
    .maybeSingle();
  if (validatedError || !validated) {
    return response({ ok: true, server_time: now, state: synced, command: null });
  }

  return response({ ok: true, server_time: now, state: synced, command: validated });
}
