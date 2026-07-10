import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  commandAccessDecision,
  controlCommandIntakeEnabled,
} from "./command-policy.mjs";

type CommandType =
  | "update_pairing"
  | "bulk_update_pairings"
  | "create_pairing"
  | "create_group"
  | "remove_group"
  | "create_calibration"
  | "delete_calibration"
  | "apply_calibration"
  | "manual_water"
  | "update_board_config"
  | "initialize_sensors"
  | "update_system_state"
  | "export_data";

type ControlCommandPayload = {
  project_id?: string;
  device_id?: string;
  client_request_id?: string;
  command_type?: CommandType;
  payload?: unknown;
  confirm?: boolean;
  honey?: string;
};

type ValidatedCommand = {
  commandType: CommandType;
  payload: Record<string, unknown>;
  requiresConfirmation: boolean;
};

const allowedOrigins = new Set([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  "http://exacth2o.com",
  "http://www.exacth2o.com",
  "https://howwee20.github.io",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:8123",
  "http://localhost:8123",
]);

const commandTypes = new Set<CommandType>([
  "update_pairing",
  "bulk_update_pairings",
  "create_pairing",
  "create_group",
  "remove_group",
  "create_calibration",
  "delete_calibration",
  "apply_calibration",
  "manual_water",
  "update_board_config",
  "initialize_sensors",
  "update_system_state",
  "export_data",
]);

const destructiveCommands = new Set<CommandType>([
  "manual_water",
  "update_board_config",
  "initialize_sensors",
  "update_system_state",
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
    },
  });
}

function clean(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function numberInRange(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function stringList(value: unknown, label: string, maxItems = 200) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  if (value.length < 1 || value.length > maxItems) {
    throw new Error(`${label} must include 1-${maxItems} items`);
  }

  const cleaned = value
    .map((item) => clean(item, 120))
    .filter(Boolean);

  if (cleaned.length !== value.length) throw new Error(`${label} contains an invalid item`);
  return cleaned;
}

function validateTargetSettings(payload: Record<string, unknown>) {
  const validated: Record<string, unknown> = {};
  if ("target_vwc" in payload) {
    validated.target_vwc = numberInRange(payload.target_vwc, 0, 80, "Target VWC");
  }
  if ("disable_watering" in payload) {
    validated.disable_watering = payload.disable_watering === true;
  }
  if ("open_time_seconds" in payload) {
    validated.open_time_seconds = numberInRange(payload.open_time_seconds, 1, 120, "Open time");
  }
  if ("measurement_interval_seconds" in payload) {
    validated.measurement_interval_seconds = numberInRange(
      payload.measurement_interval_seconds,
      30,
      3600,
      "Measurement interval",
    );
  }

  if (Object.keys(validated).length === 0) {
    throw new Error("At least one target, open-time, or interval setting is required");
  }

  return validated;
}

function validateCommand(commandType: CommandType, rawPayload: unknown): ValidatedCommand {
  if (!isRecord(rawPayload)) {
    throw new Error("Command payload must be an object");
  }

  const jsonSize = JSON.stringify(rawPayload).length;
  if (jsonSize > 20_000) throw new Error("Command payload is too large");

  const payload: Record<string, unknown> = {};
  let requiresConfirmation = destructiveCommands.has(commandType);

  if (commandType === "update_pairing") {
    payload.pairing_name = clean(rawPayload.pairing_name, 120);
    if (!payload.pairing_name) throw new Error("Pairing name is required");
    Object.assign(payload, validateTargetSettings(rawPayload));
  }

  if (commandType === "bulk_update_pairings") {
    payload.pairing_names = stringList(rawPayload.pairing_names, "Pairings");
    Object.assign(payload, validateTargetSettings(rawPayload));
  }

  if (commandType === "create_pairing") {
    payload.name = clean(rawPayload.name, 120);
    payload.sensor_key = clean(rawPayload.sensor_key, 120);
    payload.valve_key = clean(rawPayload.valve_key, 120);
    payload.group_name = clean(rawPayload.group_name, 120);
    payload.target_vwc = numberInRange(rawPayload.target_vwc, 0, 80, "Target VWC");
    payload.open_time_seconds = numberInRange(rawPayload.open_time_seconds, 1, 120, "Open time");
    payload.measurement_interval_seconds = numberInRange(
      rawPayload.measurement_interval_seconds,
      30,
      3600,
      "Measurement interval",
    );
    if (!payload.name || !payload.sensor_key || !payload.valve_key) {
      throw new Error("Pairing name, sensor, and valve are required");
    }
  }

  if (commandType === "create_group" || commandType === "remove_group") {
    payload.group_name = clean(rawPayload.group_name, 120);
    if (!payload.group_name) throw new Error("Group name is required");
    if (commandType === "remove_group") requiresConfirmation = true;
  }

  if (commandType === "create_calibration") {
    payload.name = clean(rawPayload.name, 160);
    payload.mode = clean(rawPayload.mode, 40) || "manual";
    payload.function_text = clean(rawPayload.function_text, 400);
    if (!payload.name) throw new Error("Calibration name is required");
    if (!payload.function_text && !Array.isArray(rawPayload.points)) {
      throw new Error("Calibration function or calibration points are required");
    }
    if (Array.isArray(rawPayload.points)) {
      payload.points = rawPayload.points.slice(0, 20).map((point) => {
        if (!isRecord(point)) throw new Error("Calibration point is invalid");
        return {
          vwc: numberInRange(point.vwc, 0, 100, "Calibration VWC"),
          average_reading: numberInRange(point.average_reading, -1000, 1000, "Average reading"),
        };
      });
    }
  }

  if (commandType === "delete_calibration" || commandType === "apply_calibration") {
    payload.calibration_name = clean(rawPayload.calibration_name, 160);
    if (!payload.calibration_name) throw new Error("Calibration name is required");
    if (commandType === "apply_calibration") {
      payload.pairing_names = stringList(rawPayload.pairing_names, "Pairings");
    } else {
      requiresConfirmation = true;
    }
  }

  if (commandType === "manual_water") {
    const pairingNames = stringList(rawPayload.pairing_names, "Pairings", 20);
    const durationSeconds = numberInRange(rawPayload.duration_seconds, 1, 60, "Manual water duration");
    const valveSeconds = pairingNames.length * durationSeconds;
    if (valveSeconds > 120) {
      throw new Error("Manual watering is limited to 120 total valve-seconds per command");
    }
    payload.pairing_names = pairingNames;
    payload.duration_seconds = durationSeconds;
    payload.total_valve_seconds = valveSeconds;
  }

  if (commandType === "update_board_config") {
    if (!Array.isArray(rawPayload.boards) || rawPayload.boards.length < 1 || rawPayload.boards.length > 12) {
      throw new Error("Board configuration must include 1-12 boards");
    }
    payload.boards = rawPayload.boards.map((board) => {
      if (!isRecord(board)) throw new Error("Board configuration is invalid");
      const address = clean(board.address, 16);
      if (!/^0x[0-9a-f]{1,2}$/i.test(address)) throw new Error("Board address must be hex, like 0x20");
      return {
        address,
        reset_pin: Math.round(numberInRange(board.reset_pin, 0, 40, "Reset pin")),
      };
    });
  }

  if (commandType === "initialize_sensors") {
    payload.reason = clean(rawPayload.reason, 300);
  }

  if (commandType === "update_system_state") {
    const state = clean(rawPayload.state, 40);
    if (state !== "running" && state !== "stopped") {
      throw new Error("System state must be running or stopped");
    }
    payload.state = state;
    payload.reason = clean(rawPayload.reason, 300);
    if (state === "stopped") requiresConfirmation = true;
  }

  if (commandType === "export_data") {
    const dataType = clean(rawPayload.data_type, 60);
    const allowedTypes = new Set([
      "readings",
      "groups",
      "sensors",
      "valves",
      "pairings",
      "calibrations",
      "rules",
      "logs",
      "errors",
      "audit",
    ]);
    if (!allowedTypes.has(dataType)) throw new Error("Unsupported export type");
    payload.data_type = dataType;
  }

  return {
    commandType,
    payload,
    requiresConfirmation,
  };
}

serve(async (request) => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  if (origin && !allowedOrigins.has(origin)) {
    return jsonResponse({ error: "Origin not allowed" }, 403, origin);
  }

  if (!controlCommandIntakeEnabled(Deno.env.get("CONTROL_COMMAND_INTAKE_ENABLED"))) {
    return jsonResponse({
      error: "Controller changes are temporarily paused while the production safety release is verified.",
    }, 503, origin);
  }

  let body: ControlCommandPayload;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, origin);
  }

  if (body.honey) {
    return jsonResponse({ ok: true }, 200, origin);
  }

  const projectId = clean(body.project_id, 80);
  const deviceId = clean(body.device_id, 200);
  const clientRequestId = clean(body.client_request_id, 80);
  const commandType = body.command_type;

  if (!isUuid(projectId)) {
    return jsonResponse({ error: "Project ID is required" }, 400, origin);
  }

  if (!deviceId) {
    return jsonResponse({ error: "Device ID is required" }, 400, origin);
  }

  if (!isUuid(clientRequestId)) {
    return jsonResponse({ error: "Client request ID is required" }, 400, origin);
  }

  if (!commandType || !commandTypes.has(commandType)) {
    return jsonResponse({ error: "Unsupported command type" }, 400, origin);
  }

  let validated: ValidatedCommand;
  try {
    validated = validateCommand(commandType, body.payload);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, origin);
  }

  if (validated.requiresConfirmation && body.confirm !== true) {
    return jsonResponse({ error: "This action requires explicit confirmation" }, 400, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is missing Supabase configuration" }, 500, origin);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return jsonResponse({ error: "Sign in before sending control commands" }, 401, origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) {
    return jsonResponse({ error: "Invalid portal session" }, 401, origin);
  }

  const { data: access, error: accessError } = await admin
    .from("portal_access")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (accessError) {
    return jsonResponse({ error: "Could not verify portal access" }, 500, origin);
  }

  if (!access || !["admin", "researcher"].includes(String(access.role))) {
    return jsonResponse({ error: "Experiment settings access is required for portal controls" }, 403, origin);
  }

  const accessDecision = commandAccessDecision(access.role, validated.commandType);
  if (!accessDecision.allowed) {
    return jsonResponse({ error: accessDecision.error }, accessDecision.status, origin);
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: commandRows, error: insertError } = await admin.rpc(
    "enqueue_portal_control_command",
    {
      command_project_id: projectId,
      command_device_id: deviceId,
      command_type: validated.commandType,
      command_payload: validated.payload,
      command_requested_by: userData.user.id,
      command_expires_at: expiresAt,
      command_requires_confirmation: validated.requiresConfirmation,
      command_confirmed_at: validated.requiresConfirmation ? now : null,
      command_client_request_id: clientRequestId,
    },
  );
  const command = Array.isArray(commandRows) ? commandRows[0] : commandRows;

  if (insertError || !command) {
    if (insertError?.message?.includes("already active or cooling down")) {
      return jsonResponse({ error: "Manual watering is already active or cooling down" }, 409, origin);
    }
    if (insertError?.message?.includes("no enabled executor token")) {
      return jsonResponse({ error: "Device controls are unavailable until an enabled executor token is provisioned" }, 409, origin);
    }
    if (insertError?.message?.includes("disabled or quarantined")) {
      return jsonResponse({ error: "Device controls are quarantined pending state reconciliation" }, 409, origin);
    }
    return jsonResponse({ error: "Could not queue control command" }, 500, origin);
  }

  return jsonResponse({
    ok: true,
    command,
  }, 200, origin);
});

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "Invalid command";
}
