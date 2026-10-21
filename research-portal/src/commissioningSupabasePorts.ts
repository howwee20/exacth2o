import { pairingsFromDeviceConfigState } from "./portalData";
// Must stay "./supabase": the offline Applications demo swaps exactly that module.
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { createTelemetryReader, type TelemetryRow } from "./commissioning/telemetry";
import type { CommandSnapshot, CommissioningPorts, IntakeProbe, ManualIntervention, PulseTicket } from "./commissioning/types";

// REAL HARDWARE adapter. This is the only commissioning file that talks to the
// backend, and it uses exactly the paths the portal already uses:
//  - valve pulses go through the authenticated `create-control-command` Edge
//    Function as a bounded `manual_water` command for ONE pairing, so every
//    server, executor, and controller gate stays in force;
//  - everything else is an RLS-guarded read.
// There is no direct controller URL, no service key, and no write to pairings.

const timeoutMs = 20_000;
const livePrefix = "live-device:%";
// PostgREST returns at most this many rows per request on this project.
export const telemetryPageSize = 1000;

async function functionError(error: unknown): Promise<{ status: number | null; message: string }> {
  let status: number | null = null;
  let message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  const context = error && typeof error === "object" && "context" in error ? (error as { context?: unknown }).context : null;
  if (typeof Response !== "undefined" && context instanceof Response) {
    status = context.status;
    try {
      const body = await context.clone().json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // Keep the generic message.
    }
  }
  return { status, message };
}

/** One page of live readings for the given sensors, in keyset order. */
async function fetchTelemetryPage(projectId: string, deviceId: string, request: Parameters<Parameters<typeof createTelemetryReader>[0]>[0]): Promise<TelemetryRow[]> {
  const column = request.order === "recorded" ? "device_recorded_at" : "server_received_at";
  let query = supabase
    .from("sensor_readings")
    .select("id,sensor_key,calibrated_value,device_recorded_at,server_received_at")
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .like("event_id", livePrefix)
    .in("sensor_key", request.sensorKeys)
    .gte(column, request.since)
    .order(column, { ascending: true })
    .order("id", { ascending: true })
    .limit(request.limit);
  if (request.after) {
    query = query.or(`${column}.gt.${request.after.at},and(${column}.eq.${request.after.at},id.gt.${request.after.id})`);
  }
  const result = await withSupabaseTimeout(query, timeoutMs, "Sensor readings");
  if (result.error) throw new Error(result.error.message);
  const rows: TelemetryRow[] = [];
  for (const row of (result.data ?? []) as Array<Record<string, unknown>>) {
    const id = Number(row.id);
    const vwc = Number(row.calibrated_value);
    if (typeof row.sensor_key !== "string" || !Number.isFinite(id) || typeof row.device_recorded_at !== "string") continue;
    rows.push({ id, sensorKey: row.sensor_key, recordedAt: row.device_recorded_at, receivedAt: String(row.server_received_at ?? row.device_recorded_at), vwc });
  }
  return rows;
}

export function createSupabasePorts(input: { projectId: string; deviceId: string }): CommissioningPorts {
  const { projectId, deviceId } = input;
  const telemetry = createTelemetryReader((request) => fetchTelemetryPage(projectId, deviceId, request), { pageSize: telemetryPageSize });

  const findByClientRequestId = async (clientRequestId: string) => {
    const lookup = await withSupabaseTimeout(
      supabase
        .from("project_control_commands")
        .select("id")
        .eq("project_id", projectId)
        .eq("client_request_id", clientRequestId)
        .maybeSingle(),
      timeoutMs,
      "Pulse command reconciliation",
    );
    return lookup.error ? null : (lookup.data?.id as string | undefined) ?? null;
  };

  return {
    now: () => Date.now(),

    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),

    readControllerStatus: async () => {
      const result = await withSupabaseTimeout(
        supabase
          .from("device_runtime_state")
          .select("controller_state,state_observed_at,state_fresh_until,watering_enabled")
          .eq("project_id", projectId)
          .eq("device_id", deviceId)
          .maybeSingle(),
        timeoutMs,
        "Controller status",
      );
      if (result.error) throw new Error(result.error.message);
      const row = result.data as Record<string, unknown> | null;
      const time = (value: unknown) => {
        const parsed = typeof value === "string" ? Date.parse(value) : NaN;
        return Number.isFinite(parsed) ? parsed : null;
      };
      return {
        observedAtMs: time(row?.state_observed_at),
        freshUntilMs: time(row?.state_fresh_until),
        controllerState: typeof row?.controller_state === "string" ? row.controller_state : null,
        wateringEnabled: typeof row?.watering_enabled === "boolean" ? row.watering_enabled : null,
      };
    },

    readReadings: (sensorKeys, sinceMs) => telemetry.read(sensorKeys, sinceMs),

    readManualInterventions: async (sinceMs): Promise<ManualIntervention[]> => {
      const since = new Date(sinceMs).toISOString();
      const result = await withSupabaseTimeout(
        supabase
          .from("manual_hold_sessions")
          .select("id,started_at,ended_at,status,destination_kind,pot_number,solenoid_number,relay_address,channel")
          .eq("project_id", projectId)
          .eq("device_id", deviceId)
          .or(`started_at.gte.${since},ended_at.is.null,ended_at.gte.${since}`)
          .order("started_at", { ascending: false })
          .limit(50),
        timeoutMs,
        "Manual watering records",
      );
      if (result.error) throw new Error(result.error.message);
      return ((result.data ?? []) as Array<Record<string, unknown>>)
        // A start the controller refused never opened a valve.
        .filter((row) => row.status !== "refused")
        .map((row) => {
          const relay = Number(row.relay_address);
          const output = Number.isInteger(relay) ? `0x${relay.toString(16)}:${row.channel}` : "an output";
          const label = row.destination_kind === "pot" && row.pot_number != null
            ? `pot ${row.pot_number}`
            : row.solenoid_number != null ? `solenoid ${row.solenoid_number}` : output;
          const ended = typeof row.ended_at === "string" ? Date.parse(row.ended_at) : NaN;
          return {
            id: String(row.id),
            startedAtMs: Date.parse(String(row.started_at)),
            // An "unconfirmed" stop is treated as still open until the record closes.
            endedAtMs: Number.isFinite(ended) && row.status !== "unconfirmed" ? ended : null,
            label,
          };
        })
        .filter((item) => Number.isFinite(item.startedAtMs));
    },

    countActiveWateringCommands: async () => {
      const result = await withSupabaseTimeout(
        supabase
          .from("project_control_commands")
          .select("id,status,expires_at")
          .eq("project_id", projectId)
          .eq("device_id", deviceId)
          .eq("command_type", "manual_water")
          .in("status", ["queued", "accepted", "running"]),
        timeoutMs,
        "Watering queue",
      );
      if (result.error) throw new Error(result.error.message);
      const now = Date.now();
      return ((result.data ?? []) as Array<Record<string, unknown>>).filter((row) =>
        row.status === "running" || (typeof row.expires_at === "string" && Date.parse(row.expires_at) > now)).length;
    },

    readAutoWateringPairings: async (pairingNames) => {
      const result = await withSupabaseTimeout(
        supabase
          .from("device_config_state")
          .select("pairings,groups")
          .eq("project_id", projectId)
          .eq("device_id", deviceId)
          .maybeSingle(),
        timeoutMs,
        "Controller configuration",
      );
      if (result.error) throw new Error(result.error.message);
      const row = result.data as { pairings?: unknown; groups?: unknown } | null;
      const current = pairingsFromDeviceConfigState(row?.pairings, row?.groups);
      const wanted = new Set(pairingNames);
      const found = current.filter((pairing) => wanted.has(pairing.name));
      if (found.length !== wanted.size) throw new Error("Some selected pairings are missing from the controller configuration copy.");
      // The controller treats a target outside 0–100 (or a non-positive pulse) as watering disabled.
      return found
        .filter((pairing) => pairing.wtc_percent_limit >= 0 && pairing.wtc_percent_limit <= 100 && pairing.valve_open_time_ms > 0)
        .map((pairing) => pairing.name);
    },

    // Asks the command service whether it would accept a watering command, using
    // a deliberately empty payload. The service checks its gates before it
    // validates, and an empty payload can never pass validation, so this cannot
    // queue anything: a closed gate answers 503, an open one answers 400.
    probePulseIntake: async (): Promise<IntakeProbe> => {
      const response = await withSupabaseTimeout(
        (signal) => supabase.functions.invoke("create-control-command", {
          body: {
            project_id: projectId,
            device_id: deviceId,
            client_request_id: crypto.randomUUID(),
            command_type: "manual_water",
            payload: {},
            operation_intent: "Autocalibrate preflight: gate probe (empty payload, cannot be queued).",
          },
          signal,
        }),
        timeoutMs,
        "Watering gate probe",
      );
      if (!response.error) return { open: false, detail: "Unexpected reply to the gate probe. Treating the gate as closed." };
      const { status, message } = await functionError(response.error);
      if (status === 400) return { open: true, detail: "The command service is accepting bounded watering commands." };
      return { open: false, detail: message };
    },

    requestPulse: async (request): Promise<PulseTicket> => {
      const clientRequestId = crypto.randomUUID();
      const response = await withSupabaseTimeout(
        (signal) => supabase.functions.invoke<{ operation_id?: string; command?: { id?: string } }>("create-control-command", {
          body: {
            project_id: projectId,
            device_id: deviceId,
            client_request_id: clientRequestId,
            command_type: "manual_water",
            // Exactly one pairing per command: one valve, one bounded pulse.
            payload: { pairing_names: [request.pairingName], duration_seconds: request.seconds },
            confirm: true,
            operation_intent: `Autocalibrate commissioning ${request.runId}: diagnostic pulse ${request.step}, ${request.seconds}s.`,
          },
          signal,
        }),
        timeoutMs,
        "Diagnostic pulse",
      ).catch((error: unknown) => ({ data: null, error }));

      if (!response.error && response.data?.command?.id) {
        return { commandId: response.data.command.id, operationId: response.data.operation_id ?? null };
      }
      // The reply may have been lost after the command was queued. Look it up by
      // its idempotency key; never send the request a second time.
      const existing = await findByClientRequestId(clientRequestId);
      if (existing) return { commandId: existing, operationId: null };
      throw new Error((await functionError(response.error)).message);
    },

    readCommand: async (commandId): Promise<CommandSnapshot | null> => {
      const result = await withSupabaseTimeout(
        supabase
          .from("project_control_commands")
          .select("id,status,error,result")
          .eq("project_id", projectId)
          .eq("id", commandId)
          .maybeSingle(),
        timeoutMs,
        "Pulse command status",
      );
      if (result.error) throw new Error(result.error.message);
      const row = result.data as Record<string, unknown> | null;
      if (!row) return null;
      return {
        id: String(row.id),
        status: row.status as CommandSnapshot["status"],
        error: typeof row.error === "string" ? row.error : null,
        result: row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : null,
      };
    },
  };
}
