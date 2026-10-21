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
import {
  nativeAckPreviousStatuses,
  nativeCommandForBridge,
  normalizeNativeMachineState,
  splitExpiredCommands,
} from "../_shared/gas-mixer-native-policy.mjs";

const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
const gasMixerDeviceId = "gas-mixer:b827eb548a44";
const commandColumns = "id,command_type,payload,expected_revision,created_at,expires_at";
const maximumAcknowledgements = 20;
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

serve(async (request) => {
  const startedAt = performance.now();
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

  // The LISTEN connection opens while this request authenticates and reads.
  const holds = payload.action === "heartbeat" || payload.action === "state" ||
    payload.action === "poll" || payload.action === "sync";
  const listenerPromise = holds
    ? openWakeListener(wakeConnector, agentWakeKey("native", gasMixerDeviceId), {
      timeoutMs: agentPollBudget.wakeConnectTimeoutMs,
      log: (error: unknown) => console.warn("native wake listener unavailable", String(error)),
    })
    : Promise.resolve(null);
  try {
    return await handle(serviceClient, payload, request.signal, startedAt, listenerPromise);
  } finally {
    await (await listenerPromise)?.close();
  }
});

type Listener = Awaited<ReturnType<typeof openWakeListener>>;

async function handle(
  serviceClient: ServiceClient,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  startedAt: number,
  listenerPromise: Promise<Listener>,
) {
  const now = new Date().toISOString();
  const legacyDeadline = startedAt + agentPollBudget.pythonResponseBudgetMs;

  if (payload.action === "heartbeat") {
    // Listen before the update reports attention, so a command committed
    // after it still wakes this request.
    const listener = await listenerPromise;
    const { data, error } = await serviceClient.from("gas_mixer_native_device_state").update({
      bridge_connected: true,
      bridge_ready: payload.bridge_ready === true,
      bridge_version: typeof payload.bridge_version === "string" ? payload.bridge_version.slice(0, 80) : null,
      last_bridge_at: now,
      metadata: {
        commissioning_state: payload.bridge_ready === true ? "ready" : "bridge_pending",
        existing_screen_bridge_preserved: true,
      },
      updated_at: now,
    }).eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId)
      .select("agent_attention_until").maybeSingle();
    if (error) return response({ error: "Unable to record bridge heartbeat" }, 503);
    // Nobody is waiting: keep the installed bridge's next call (state, acks,
    // poll) parked here until a command or viewer appears.
    if (!isAttended(data?.agent_attention_until)) {
      await holdQuietly({ deadline: legacyDeadline, listener, signal });
    }
    return response({ ok: true, server_time: now });
  }

  if (payload.action === "state") {
    const listener = await listenerPromise;
    const recorded = await recordState(serviceClient, payload, now);
    if (recorded.response) return recorded.response;
    if (!isAttended(recorded.attentionUntil)) {
      await holdQuietly({ deadline: legacyDeadline, listener, signal });
    }
    return response({ ok: true });
  }

  if (payload.action === "poll") {
    const { data, error } = await holdForCommands(serviceClient, legacyDeadline, listenerPromise, signal, startedAt);
    return error
      ? response({ error: "Unable to poll native mixer commands" }, 503)
      : response({ ok: true, commands: (data ?? []).map(nativeCommandForBridge) });
  }

  if (payload.action === "ack") {
    const result = await recordAcknowledgement(serviceClient, payload, now);
    if (result === "invalid") return response({ error: "A valid command acknowledgement is required" }, 400);
    return result === "error"
      ? response({ error: "Unable to acknowledge native mixer command" }, 503)
      : response({ ok: true });
  }

  // Protocol 2: one call carries the heartbeat, the newest state, pending
  // acknowledgements and a held command poll. Acknowledgements are recorded
  // before reading commands, so an applied command is never handed out again.
  if (payload.action === "sync" && payload.protocol === 2) {
    const acknowledgements = Array.isArray(payload.acks) ? payload.acks.slice(0, maximumAcknowledgements) : [];
    const ackResults = [];
    for (const ack of acknowledgements) {
      const result = ack && typeof ack === "object"
        ? await recordAcknowledgement(serviceClient, ack as Record<string, unknown>, now)
        : "invalid";
      ackResults.push({
        command_id: typeof (ack as Record<string, unknown>)?.command_id === "string"
          ? (ack as Record<string, unknown>).command_id
          : null,
        recorded: result === "recorded",
        retry: result === "error",
      });
    }

    let stateResult: { recorded: boolean; stale: boolean } | null = null;
    let attentionUntil: unknown = null;
    if (payload.state && typeof payload.state === "object") {
      const recorded = await recordState(serviceClient, payload.state as Record<string, unknown>, now, {
        bridgeVersion: payload.bridge_version,
      });
      if (recorded.response && !recorded.stale) return recorded.response;
      stateResult = { recorded: !recorded.response, stale: recorded.stale === true };
      attentionUntil = recorded.attentionUntil;
    }
    if (!stateResult?.recorded) {
      const { data, error } = await serviceClient.from("gas_mixer_native_device_state").update({
        bridge_connected: true,
        bridge_ready: payload.bridge_ready === true,
        bridge_version: typeof payload.bridge_version === "string" ? payload.bridge_version.slice(0, 80) : null,
        last_bridge_at: now,
        updated_at: now,
      }).eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId)
        .select("agent_attention_until").maybeSingle();
      if (error) return response({ error: "Unable to record bridge heartbeat" }, 503);
      attentionUntil = data?.agent_attention_until;
    }

    const holdMs = ackResults.some((result) => result.retry)
      ? 0
      : syncHoldMs(payload.hold_ms, payload.client_timeout_ms);
    const { data, error } = await holdForCommands(serviceClient, startedAt + holdMs, listenerPromise, signal, null);
    if (error) return response({ error: "Unable to poll native mixer commands" }, 503);
    const attended = isAttended(attentionUntil);
    return response({
      ok: true,
      protocol: 2,
      server_time: now,
      commands: (data ?? []).map(nativeCommandForBridge),
      acks: ackResults,
      state: stateResult,
      attended,
      // The server sets the cadence so it can be tuned without a bridge release.
      next: {
        hold_ms: agentPollBudget.syncHoldMaxMs,
        state_interval_ms: attended ? 2000 : 20000,
      },
    });
  }

  return response({ error: "Unsupported action" }, 400);
}

// Read first so an already-queued command is not delayed by the LISTEN
// connection; only an empty read waits for the listener and re-reads once to
// cover commands committed before it was active. A legacy poll (startedAt
// given) holds a shorter time while someone is waiting, so the installed
// bridge's next heartbeat and state reach that viewer sooner.
async function holdForCommands(
  serviceClient: ServiceClient,
  deadline: number,
  listenerPromise: Promise<Listener>,
  signal: AbortSignal,
  startedAt: number | null,
) {
  const first = await readQueuedCommands(serviceClient);
  if (first.error || first.data?.length || deadline - performance.now() < agentPollBudget.minimumHoldMs) {
    return first;
  }
  const listener = await listenerPromise;
  if (startedAt !== null) {
    const { data: state } = await serviceClient.from("gas_mixer_native_device_state")
      .select("agent_attention_until")
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .maybeSingle();
    if (isAttended(state?.agent_attention_until)) {
      deadline = Math.min(deadline, startedAt + agentPollBudget.nativeAttendedPollHoldMs);
    }
  }
  return holdUntilWork(() => readQueuedCommands(serviceClient), { deadline, listener, signal });
}

async function readQueuedCommands(serviceClient: ServiceClient) {
  // One read finds both deliverable and expired commands; expiring needs a
  // second call only when something actually expired.
  const { data, error } = await serviceClient.from("gas_mixer_native_commands")
    .select(commandColumns)
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) return { data: null, error };
  const { deliverable, expired } = splitExpiredCommands(data ?? [], Date.now());
  if (expired.length) {
    await serviceClient.from("gas_mixer_native_commands").update({
      status: "expired",
      completed_at: new Date().toISOString(),
      error_message: "Command expired before the bridge accepted it",
    })
      .eq("project_id", gasMixerProjectId)
      .eq("device_id", gasMixerDeviceId)
      .eq("status", "queued")
      .in("id", expired.map((command) => command.id));
  }
  return { data: deliverable, error: null };
}

async function recordState(
  serviceClient: ServiceClient,
  state: Record<string, unknown>,
  now: string,
  { bridgeVersion }: { bridgeVersion?: unknown } = {},
): Promise<{ response?: Response; stale?: boolean; attentionUntil?: unknown }> {
  let appliedState: Record<string, unknown>;
  let observedState: Record<string, unknown>;
  try {
    appliedState = normalizeNativeMachineState(state.applied_state);
    observedState = normalizeNativeMachineState(state.observed_state);
  } catch (error) {
    return { response: response({ error: error instanceof Error ? error.message : "Invalid mixer state" }, 400) };
  }
  if (!Number.isInteger(state.state_revision) || (state.state_revision as number) < 0) {
    return { response: response({ error: "A valid state revision is required" }, 400) };
  }
  const stateUpdate: Record<string, unknown> = {
    bridge_connected: true,
    bridge_ready: true,
    last_bridge_at: now,
    state_revision: state.state_revision,
    applied_state: appliedState,
    observed_state: observedState,
    updated_at: now,
  };
  if (typeof bridgeVersion === "string") stateUpdate.bridge_version = bridgeVersion.slice(0, 80);
  if (state.sync_requested === true) stateUpdate.requested_state = appliedState;
  const { data, error } = await serviceClient.from("gas_mixer_native_device_state").update(stateUpdate)
    .eq("project_id", gasMixerProjectId).eq("device_id", gasMixerDeviceId)
    .lte("state_revision", state.state_revision as number)
    .select("state_revision,agent_attention_until")
    .maybeSingle();
  if (error) return { response: response({ error: "Unable to record mixer state" }, 503) };
  if (!data) return { response: response({ error: "Stale mixer state was ignored" }, 409), stale: true };
  return { attentionUntil: data.agent_attention_until };
}

async function recordAcknowledgement(
  serviceClient: ServiceClient,
  ack: Record<string, unknown>,
  now: string,
): Promise<"recorded" | "invalid" | "error"> {
  const commandId = typeof ack.command_id === "string" ? ack.command_id : "";
  const status = typeof ack.status === "string" ? ack.status : "";
  const allowedStatuses = new Set(["accepted", "applied", "verified", "rejected", "failed"]);
  if (!/^[0-9a-f-]{36}$/i.test(commandId) || !allowedStatuses.has(status)) return "invalid";
  const timestamps: Record<string, string> = {};
  if (status === "accepted") timestamps.accepted_at = now;
  if (status === "applied" || status === "verified") timestamps.applied_at = now;
  if (status === "verified" || status === "rejected" || status === "failed") timestamps.completed_at = now;
  const { error } = await serviceClient.from("gas_mixer_native_commands").update({
    status,
    ...timestamps,
    error_message: (status === "rejected" || status === "failed") && typeof ack.error === "string"
      ? ack.error.slice(0, 240)
      : null,
  })
    .eq("id", commandId)
    .eq("project_id", gasMixerProjectId)
    .eq("device_id", gasMixerDeviceId)
    .in("status", nativeAckPreviousStatuses(status));
  return error ? "error" : "recorded";
}
