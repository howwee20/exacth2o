import { createClient } from "npm:@supabase/supabase-js@2";

type AdminClient = ReturnType<typeof createClient<any>>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Automation failed.";
}

function safeEqual(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function currentPairingNames(config: Record<string, unknown>) {
  return new Set(
    (Array.isArray(config.pairings) ? config.pairings : [])
      .map((item) => text(record(item).name, 120))
      .filter(Boolean),
  );
}

function validateTargetPayload(payload: Record<string, unknown>) {
  const allowed = new Set([
    "pairing_name",
    "pairing_names",
    "target_vwc",
    "disable_watering",
    "open_time_seconds",
    "measurement_interval_seconds",
  ]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new Error("The scheduled pairing change contains an unsupported setting.");
  }
  if ("target_vwc" in payload) {
    const value = numberValue(payload.target_vwc);
    if (value === null || value < 0 || value > 80) throw new Error("Target VWC is invalid.");
  }
  if ("open_time_seconds" in payload) {
    const value = numberValue(payload.open_time_seconds);
    if (value === null || value < 1 || value > 120) throw new Error("Valve time is invalid.");
  }
  if ("measurement_interval_seconds" in payload) {
    const value = numberValue(payload.measurement_interval_seconds);
    if (value === null || value < 30 || value > 3600) {
      throw new Error("Measurement interval is invalid.");
    }
  }
  if (
    !("target_vwc" in payload) &&
    !("disable_watering" in payload) &&
    !("open_time_seconds" in payload) &&
    !("measurement_interval_seconds" in payload)
  ) {
    throw new Error("The scheduled setting has no supported change.");
  }
}

function validatedScheduledCommands(
  approvedPlan: unknown,
  config: Record<string, unknown>,
) {
  const plan = record(approvedPlan);
  const settingsPlan = record(plan.settings_plan);
  const rawCommands = Array.isArray(settingsPlan.commands)
    ? settingsPlan.commands
    : [];
  if (!rawCommands.length || rawCommands.length > 20) {
    throw new Error("The approved schedule has no executable settings.");
  }
  const availablePairings = currentPairingNames(config);
  return rawCommands.map((item) => {
    const command = record(item);
    const commandType = text(command.command_type, 60);
    const payload = record(command.payload);
    if (!["update_pairing", "bulk_update_pairings", "update_system_state"].includes(commandType)) {
      throw new Error("The schedule contains an unsupported action.");
    }
    if (commandType === "update_system_state") {
      const state = text(payload.state, 20).toLowerCase();
      if (!["running", "stopped"].includes(state)) {
        throw new Error("The scheduled controller state is invalid.");
      }
      return {
        command_type: commandType,
        payload: { state, reason: text(payload.reason, 300) || "Approved ExactH2O schedule" },
      };
    }
    const pairingNames = commandType === "update_pairing"
      ? [text(payload.pairing_name, 120)]
      : Array.isArray(payload.pairing_names)
      ? payload.pairing_names.map((name) => text(name, 120))
      : [];
    if (
      !pairingNames.length ||
      pairingNames.some((name) => !name || !availablePairings.has(name))
    ) {
      throw new Error("A scheduled pairing is no longer in the current inventory.");
    }
    validateTargetPayload(payload);
    return {
      command_type: commandType,
      payload: commandType === "update_pairing"
        ? { ...payload, pairing_name: pairingNames[0] }
        : { ...payload, pairing_names: [...new Set(pairingNames)] },
    };
  });
}

async function runSchedule(
  admin: AdminClient,
  schedule: Record<string, unknown>,
) {
  const scheduleId = text(schedule.id, 80);
  const projectId = text(schedule.project_id, 80);
  const userId = text(schedule.created_by, 80);
  if (!isUuid(scheduleId) || !isUuid(projectId) || !isUuid(userId)) {
    throw new Error("Schedule identity is invalid.");
  }
  const [{ data: config, error: configError }, { data: runtime, error: runtimeError }] =
    await Promise.all([
      admin
        .from("device_config_state")
        .select("device_id,pairings,groups,updated_at,config_hash")
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("device_runtime_state")
        .select("device_id,controller_state,state_fresh_until,updated_at")
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
  if (configError || !config) throw new Error("Current controller inventory is unavailable.");
  if (runtimeError || !runtime) throw new Error("Current controller state is unavailable.");
  const freshUntil = Date.parse(text(runtime.state_fresh_until, 80));
  if (!Number.isFinite(freshUntil) || freshUntil <= Date.now()) {
    throw new Error("Controller state is stale; the schedule was not executed.");
  }
  const controllerState = text(runtime.controller_state, 20).toLowerCase();
  if (!["running", "stopped"].includes(controllerState)) {
    throw new Error("Controller state is not safe for a scheduled change.");
  }
  const deviceId = text(config.device_id ?? runtime.device_id, 200);
  const configHash = text(config.config_hash, 128);
  if (!deviceId || !configHash) throw new Error("Synchronized controller identity is incomplete.");
  if (text(schedule.approved_config_hash, 128) !== configHash) {
    throw new Error("Controller configuration changed after review; review this schedule again.");
  }
  const commands = validatedScheduledCommands(schedule.approved_plan, config);
  const batchId = crypto.randomUUID();

  if (commands.length === 1 && commands[0].command_type === "update_system_state") {
    const command = commands[0];
    const { data, error } = await admin.rpc("enqueue_portal_control_command", {
      command_project_id: projectId,
      command_device_id: deviceId,
      command_type: command.command_type,
      command_payload: command.payload,
      command_requested_by: userId,
      command_expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      command_requires_confirmation: true,
      command_confirmed_at: new Date().toISOString(),
      command_client_request_id: crypto.randomUUID(),
    });
    if (error || !Array.isArray(data) || !data.length) {
      throw new Error(error?.message || "The scheduled controller state was not queued.");
    }
    return { batchId: null, commandCount: 1 };
  }
  if (commands.some((command) => command.command_type === "update_system_state")) {
    throw new Error("Controller-state schedules must be reviewed separately.");
  }

  const batchCommands = [
    {
      client_request_id: crypto.randomUUID(),
      command_type: "update_system_state",
      payload: {
        state: "stopped",
        reason: `Apply approved schedule: ${text(schedule.name, 120)}`,
      },
      requires_confirmation: true,
    },
    ...commands.map((command) => ({
      client_request_id: crypto.randomUUID(),
      command_type: command.command_type,
      payload: command.payload,
      requires_confirmation: false,
    })),
    {
      client_request_id: crypto.randomUUID(),
      command_type: "update_system_state",
      payload: {
        state: controllerState,
        reason: `Restore reviewed state after schedule: ${text(schedule.name, 120)}`,
      },
      requires_confirmation: true,
    },
  ];
  const { data, error } = await admin.rpc("enqueue_portal_control_command_batch", {
    command_project_id: projectId,
    command_device_id: deviceId,
    command_requested_by: userId,
    command_batch_id: batchId,
    command_expires_at: new Date(Date.now() + 20 * 60 * 1_000).toISOString(),
    expected_config_hash: configHash,
    expected_controller_state: controllerState,
    batch_commands: batchCommands,
  });
  if (error || !Array.isArray(data) || data.length !== batchCommands.length) {
    throw new Error(error?.message || "The complete scheduled settings batch was not queued.");
  }
  return { batchId, commandCount: data.length };
}

function latestByPairing(rows: unknown[]) {
  const output = new Map<string, { value: number; observedAt: string }>();
  for (const item of rows) {
    const row = record(item);
    const pairing = text(row.pairing_name, 120);
    const value = numberValue(row.calibrated_value);
    const observedAt = text(row.device_recorded_at ?? row.server_received_at, 80);
    if (!pairing || value === null || !Number.isFinite(Date.parse(observedAt))) continue;
    const current = output.get(pairing);
    if (!current || Date.parse(observedAt) > Date.parse(current.observedAt)) {
      output.set(pairing, { value, observedAt });
    }
  }
  return output;
}

async function evaluateMonitor(
  admin: AdminClient,
  monitor: Record<string, unknown>,
) {
  const projectId = text(monitor.project_id, 80);
  const metric = text(monitor.metric, 40);
  const comparator = text(monitor.comparator, 40);
  const threshold = numberValue(monitor.threshold);
  const windowMinutes = Math.max(5, numberValue(monitor.window_minutes) ?? 60);
  const pairings = Array.isArray(monitor.pairing_names)
    ? monitor.pairing_names.map((item) => text(item, 120)).filter(Boolean)
    : [];
  const since = new Date(Date.now() - windowMinutes * 60 * 1_000).toISOString();

  if (metric === "controller_health") {
    const { data, error } = await admin
      .from("device_runtime_state")
      .select("pi_online,api_status,overall_status,state_fresh_until,state_observed_at")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return {
        state: "unknown",
        summary: "Controller health evidence is unavailable.",
        evidence: {},
      };
    }
    const unhealthy = data.pi_online === false ||
      ["offline", "down", "error", "unhealthy"].includes(
        text(data.api_status ?? data.overall_status, 40).toLowerCase(),
      ) ||
      Date.parse(text(data.state_fresh_until, 80)) <= Date.now();
    return {
      state: unhealthy ? "triggered" : "clear",
      summary: unhealthy
        ? "Controller health requires attention."
        : "Controller health returned to the expected state.",
      evidence: data,
    };
  }

  if (!pairings.length) {
    return {
      state: "unknown",
      summary: "The monitor has no current pot assignments.",
      evidence: {},
    };
  }

  const query = admin
    .from("sensor_readings")
    .select("pairing_name,calibrated_value,device_recorded_at,server_received_at")
    .eq("project_id", projectId)
    .in("pairing_name", pairings)
    .gte("device_recorded_at", since)
    .order("device_recorded_at", { ascending: true })
    .limit(5_000);
  const { data, error } = await query;
  if (error) {
    return {
      state: "unknown",
      summary: "Sensor evidence is unavailable.",
      evidence: { error_code: error.code },
    };
  }
  const rows = data ?? [];
  const latest = latestByPairing(rows);
  if (!rows.length && metric !== "sensor_stale") {
    return {
      state: "unknown",
      summary: `No monitored readings were available in the last ${windowMinutes} minutes.`,
      evidence: { window_minutes: windowMinutes, pairing_count: pairings.length },
    };
  }

  if (metric === "sensor_stale") {
    const stale = pairings.filter((pairing) => {
      const point = latest.get(pairing);
      return !point || Date.parse(point.observedAt) < Date.parse(since);
    });
    return {
      state: stale.length ? "triggered" : "clear",
      summary: stale.length
        ? `${stale.length} monitored pot${stale.length === 1 ? "" : "s"} did not report within ${windowMinutes} minutes.`
        : "All monitored pots resumed reporting.",
      evidence: { stale_pairings: stale, window_minutes: windowMinutes },
    };
  }

  const triggered: Array<Record<string, unknown>> = [];
  if (metric === "current_vwc" && threshold !== null) {
    for (const [pairing, point] of latest) {
      if (
        (comparator === "above" && point.value > threshold) ||
        (comparator === "below" && point.value < threshold)
      ) {
        triggered.push({ pairing_name: pairing, value: point.value, observed_at: point.observedAt });
      }
    }
  } else if (metric === "change_vwc" && threshold !== null) {
    const byPairing = new Map<string, Array<{ value: number; observedAt: string }>>();
    for (const item of rows) {
      const row = record(item);
      const pairing = text(row.pairing_name, 120);
      const value = numberValue(row.calibrated_value);
      const observedAt = text(row.device_recorded_at ?? row.server_received_at, 80);
      if (!pairing || value === null || !Number.isFinite(Date.parse(observedAt))) continue;
      const points = byPairing.get(pairing) ?? [];
      points.push({ value, observedAt });
      byPairing.set(pairing, points);
    }
    for (const [pairing, points] of byPairing) {
      if (points.length < 2) continue;
      const change = points.at(-1)!.value - points[0].value;
      if (
        (comparator === "increase_by" && change >= threshold) ||
        (comparator === "decrease_by" && change <= -threshold)
      ) {
        triggered.push({ pairing_name: pairing, change });
      }
    }
  }

  return {
    state: triggered.length ? "triggered" : "clear",
    summary: triggered.length
      ? `${triggered.length} monitored pot${triggered.length === 1 ? "" : "s"} met the alert condition.`
      : "The monitored condition is no longer present.",
    evidence: {
      metric,
      comparator,
      threshold,
      window_minutes: windowMinutes,
      triggered,
      pots_reporting: latest.size,
    },
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const suppliedSecret = text(request.headers.get("x-assistant-automation-secret"), 500);
  const allowedSecrets = [
    text(Deno.env.get("SYNC_OWNER_HEALTH_CRON_SECRET"), 500),
    text(Deno.env.get("SYNC_OWNER_HEALTH_SECRET"), 500),
  ].filter(Boolean);
  if (!allowedSecrets.some((secret) => safeEqual(secret, suppliedSecret))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Automation is not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const result = {
    schedules_claimed: 0,
    schedules_queued: 0,
    schedules_failed: 0,
    monitors_evaluated: 0,
    monitor_events: 0,
  };

  const { data: schedules, error: claimError } = await admin.rpc(
    "claim_due_assistant_schedules",
    { claim_limit: 10 },
  );
  if (claimError) {
    return new Response(JSON.stringify({ error: claimError.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  result.schedules_claimed = Array.isArray(schedules) ? schedules.length : 0;
  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    const scheduleRow = record(schedule);
    try {
      const queued = await runSchedule(admin, scheduleRow);
      const { error } = await admin.rpc("finish_assistant_schedule_run", {
        requested_schedule_id: scheduleRow.id,
        run_status: "queued",
        run_batch_id: queued.batchId,
        run_details: { command_count: queued.commandCount },
      });
      if (error) throw error;
      result.schedules_queued += 1;
    } catch (error) {
      await admin.rpc("finish_assistant_schedule_run", {
        requested_schedule_id: scheduleRow.id,
        run_status: "failed",
        run_batch_id: null,
        run_details: { error: errorMessage(error) },
      });
      result.schedules_failed += 1;
    }
  }

  const { data: monitors, error: monitorError } = await admin
    .from("assistant_monitors")
    .select("*")
    .eq("status", "active")
    .order("last_evaluated_at", { ascending: true, nullsFirst: true })
    .limit(100);
  if (!monitorError) {
    for (const rawMonitor of monitors ?? []) {
      const monitor = record(rawMonitor);
      const lastEvaluated = Date.parse(text(monitor.last_evaluated_at, 80));
      const intervalMs = Math.max(
        5,
        numberValue(monitor.check_every_minutes) ?? 10,
      ) * 60 * 1_000;
      if (Number.isFinite(lastEvaluated) && Date.now() - lastEvaluated < intervalMs) {
        continue;
      }
      const evaluation = await evaluateMonitor(admin, monitor);
      const previousState = text(monitor.last_state, 20) || "unknown";
      const nextState = evaluation.state === "clear" ? "clear" : evaluation.state;
      const observedAt = new Date().toISOString();
      if (nextState !== previousState) {
        const eventState = nextState === "clear" ? "resolved" : nextState;
        const { error } = await admin.from("assistant_monitor_events").insert({
          monitor_id: monitor.id,
          project_id: monitor.project_id,
          state: eventState,
          summary: evaluation.summary,
          evidence: evaluation.evidence,
          observed_at: observedAt,
        });
        if (!error) result.monitor_events += 1;
      }
      await admin
        .from("assistant_monitors")
        .update({
          last_state: nextState,
          last_evaluated_at: observedAt,
          last_triggered_at: nextState === "triggered"
            ? observedAt
            : monitor.last_triggered_at,
          updated_at: observedAt,
        })
        .eq("id", monitor.id);
      result.monitors_evaluated += 1;
    }
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});
