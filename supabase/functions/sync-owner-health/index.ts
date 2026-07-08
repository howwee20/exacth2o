import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const mattProjectId = "22222222-2222-4222-8222-222222222222";
const mattOrganizationId = "11111111-1111-4111-8111-111111111111";
const mattDeviceId = "3100e37ee3205651fe3dd86dafd4dc0c";
const ownerHealthBaseUrl = `https://${mattDeviceId}.balena-devices.com/owner-health`;
const ignoredDiagnosticPairingNames = new Set(["cwd-lowercaset", "720-1539"]);
const ignoredDiagnosticSensorKeys = new Set(["t", "d30gqn2d:t"]);
const ignoredDiagnosticValveKeys = new Set(["1539", "0x20:3", "d30gqn2d:0x20:3"]);
const ignoredDiagnosticSensorIds = new Set([720]);
const ignoredDiagnosticValveIds = new Set([1539]);

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

type FetchResult = {
  ok: boolean;
  status: number | null;
  elapsedMs: number | null;
  data: Record<string, unknown>;
  error: string | null;
};

type ValveEventInsert = {
  event_id: string;
  source_valve_id: number | null;
  pairing_name: string;
  valve_key: string;
  action: "open" | "close";
  duration_ms: number | null;
  device_recorded_at: string;
  server_received_at: string;
};

type ValveEventWriteRow = ValveEventInsert & {
  organization_id: string;
  project_id: string;
  device_id: string;
};

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : "https://exacth2o.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-owner-health-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanSecret(value: string | null) {
  return (value ?? "").trim();
}

function bearerToken(request: Request) {
  return (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function hasSyncSecret(request: Request) {
  const syncSecret = cleanSecret(Deno.env.get("SYNC_OWNER_HEALTH_SECRET"));
  if (!syncSecret) return false;
  return request.headers.get("x-sync-owner-health-secret") === syncSecret || bearerToken(request) === syncSecret;
}

async function portalAdminUserId(
  admin: ReturnType<typeof createClient>,
  request: Request,
) {
  const jwt = bearerToken(request);
  if (!jwt) return null;

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) return null;

  const { data: access, error: accessError } = await admin
    .from("portal_access")
    .select("role")
    .eq("project_id", mattProjectId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (accessError || access?.role !== "admin") return null;
  return userData.user.id;
}

function basicAuthHeader(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

async function fetchJson(url: string, authHeader: string): Promise<FetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Authorization": authHeader,
      },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      elapsedMs,
      data,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - started,
      data: {},
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asInteger(value: unknown) {
  const numberValue = asNumber(value);
  return numberValue == null ? null : Math.trunc(numberValue);
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asTimestamp(value: unknown) {
  const text = asString(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedDiagnosticText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isIgnoredDiagnosticPairingName(value: unknown) {
  return ignoredDiagnosticPairingNames.has(normalizedDiagnosticText(value));
}

function isIgnoredDiagnosticSensorKey(value: unknown) {
  return ignoredDiagnosticSensorKeys.has(normalizedDiagnosticText(value));
}

function isIgnoredDiagnosticValveKey(value: unknown) {
  return ignoredDiagnosticValveKeys.has(normalizedDiagnosticText(value));
}

function isIgnoredDiagnosticNumber(value: unknown, ignored: Set<number>) {
  if (typeof value === "number") return ignored.has(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return ignored.has(Number(value));
  }
  return false;
}

function diagnosticIssueText(value: unknown) {
  if (typeof value === "string") return value.toLowerCase();
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return "";
  }
}

function isIgnoredDiagnosticIssue(value: unknown) {
  const text = diagnosticIssueText(value);
  return [
    "cwd-lowercaset",
    "720-1539",
    "sensor data: 720-1539",
    "d30gqn2d",
    "0x20:3",
  ].some((needle) => text.includes(needle));
}

function isIgnoredDiagnosticSensorItem(value: unknown) {
  const record = asRecord(value);
  return (
    isIgnoredDiagnosticSensorKey(value) ||
    isIgnoredDiagnosticPairingName(value) ||
    isIgnoredDiagnosticSensorKey(firstString(record, ["sensor", "sensor_key", "sensorKey", "address", "id", "name"])) ||
    isIgnoredDiagnosticPairingName(firstString(record, ["pairing", "pairing_name", "pairingName", "name"])) ||
    isIgnoredDiagnosticNumber(record.source_sensor_id, ignoredDiagnosticSensorIds) ||
    isIgnoredDiagnosticNumber(record.sourceSensorId, ignoredDiagnosticSensorIds) ||
    isIgnoredDiagnosticNumber(record.sensor_id, ignoredDiagnosticSensorIds) ||
    isIgnoredDiagnosticNumber(record.sensorId, ignoredDiagnosticSensorIds)
  );
}

function filterIgnoredDiagnosticItems(values: unknown[]) {
  return values.filter((value) => !isIgnoredDiagnosticSensorItem(value) && !isIgnoredDiagnosticIssue(value));
}

function adjustedHealthCount(value: number | null, removedCount: number) {
  return value == null ? null : Math.max(0, value - removedCount);
}

function nestedRecord(value: unknown, key: string) {
  return asRecord(asRecord(value)[key]);
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstInteger(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = asInteger(record[key]);
    if (value != null) return value;
  }
  return null;
}

function eventAction(record: Record<string, unknown>): "open" | "close" {
  const text = firstString(record, ["action", "event", "state", "operation"])?.toLowerCase() ?? "";
  return text.includes("close") || text.includes("closed") ? "close" : "open";
}

function normalizeValveEvent(value: unknown, nowIso: string): ValveEventInsert | null {
  const record = asRecord(value);
  const deviceRecordedAt = asTimestamp(firstString(record, [
    "t",
    "time",
    "timestamp",
    "eventTime",
    "event_time",
    "device_recorded_at",
    "server_received_at",
    "created_at",
  ]));
  if (!deviceRecordedAt) return null;

  const pairingName = firstString(record, ["pairing", "pairing_name", "pairingName", "name"]);
  const valveKey = firstString(record, ["valve", "valve_key", "valveKey", "valve_id", "valveId"]);
  const sourceValveId = firstInteger(record, ["source_valve_id", "sourceValveId", "sourceValveID"]);
  const action = eventAction(record);
  const duration = asInteger(record.valveOpenTimeMs) ??
    asInteger(record.valve_open_time_ms) ??
    asInteger(record.duration_ms) ??
    asInteger(record.durationMs);
  const eventId = firstString(record, ["event_id", "eventId", "id"]) ??
    [
      "owner-health",
      deviceRecordedAt,
      pairingName ?? "unknown-pairing",
      valveKey ?? "unknown-valve",
      action,
      duration ?? "unknown-duration",
    ].join(":");

  return {
    event_id: eventId,
    source_valve_id: sourceValveId,
    pairing_name: pairingName ?? valveKey ?? "unknown",
    valve_key: valveKey ?? pairingName ?? "unknown",
    action,
    duration_ms: duration,
    device_recorded_at: deviceRecordedAt,
    server_received_at: nowIso,
  };
}

function nestedFirstString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return asString(current);
}

function nestedFirstInteger(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return asInteger(current);
}

function scalarWateringEvent(
  value: unknown,
  nowIso: string,
): ValveEventInsert | null {
  const record = asRecord(value);
  const deviceRecordedAt = asTimestamp(
    firstString(record, [
      "watering_last_event_at",
      "wateringLastEventAt",
      "watering_last_at",
      "wateringLastAt",
      "last_watering_event_at",
      "lastWateringEventAt",
      "last_event_at",
      "lastEventAt",
    ]) ??
      nestedFirstString(record, ["watering", "last_event_at"]) ??
      nestedFirstString(record, ["watering", "lastEventAt"]) ??
      nestedFirstString(record, ["watering", "lastAt"]) ??
      nestedFirstString(record, ["lastEvent", "t"]),
  );
  if (!deviceRecordedAt) return null;

  const pairingName =
    firstString(record, [
      "watering_last_event",
      "wateringLastEvent",
      "last_watering_event",
      "lastWateringEvent",
      "wateringLastPairing",
      "watering_last_pairing",
    ]) ??
    nestedFirstString(record, ["watering", "last_event"]) ??
    nestedFirstString(record, ["watering", "lastEvent"]) ??
    nestedFirstString(record, ["lastEvent", "pairing"]) ??
    nestedFirstString(record, ["lastEvent", "pairId"]) ??
    "unknown";
  const duration =
    firstInteger(record, ["watering_last_duration_ms", "wateringLastDurationMs"]) ??
    nestedFirstInteger(record, ["watering", "last_duration_ms"]) ??
    nestedFirstInteger(record, ["watering", "lastDurationMs"]);
  return {
    event_id: [
      "owner-health-scalar",
      deviceRecordedAt,
      pairingName,
    ].join(":"),
    source_valve_id: null,
    pairing_name: pairingName,
    valve_key: pairingName,
    action: "open",
    duration_ms: duration,
    device_recorded_at: deviceRecordedAt,
    server_received_at: nowIso,
  };
}

function collectNestedScalarWateringEvents(
  value: unknown,
  nowIso: string,
): ValveEventInsert[] {
  const directEvent = scalarWateringEvent(value, nowIso);

  if (Array.isArray(value)) {
    return [
      ...(directEvent ? [directEvent] : []),
      ...value.flatMap((item) => collectNestedScalarWateringEvents(item, nowIso)),
    ];
  }

  const record = asRecord(value);
  if (!Object.keys(record).length) return directEvent ? [directEvent] : [];

  return [
    ...(directEvent ? [directEvent] : []),
    ...Object.values(record).flatMap((child) => collectNestedScalarWateringEvents(child, nowIso)),
  ];
}

function pathHintsValveEvents(path: string[]) {
  const text = path.join(".").toLowerCase();
  return (
    text.includes("watering") ||
    text.includes("valve") ||
    text.includes("irrigation")
  ) && text.includes("event");
}

function collectNestedValveEventCandidates(
  value: unknown,
  nowIso: string,
  path: string[] = [],
): ValveEventInsert[] {
  if (Array.isArray(value)) {
    const directEvents = pathHintsValveEvents(path)
      ? value
          .map((event) => normalizeValveEvent(event, nowIso))
          .filter((event): event is ValveEventInsert => event != null)
      : [];
    const nestedEvents = value.flatMap((item, index) =>
      collectNestedValveEventCandidates(item, nowIso, [...path, String(index)])
    );
    return [...directEvents, ...nestedEvents];
  }

  const record = asRecord(value);
  if (!Object.keys(record).length) return [];
  const directEvent = pathHintsValveEvents(path) ? normalizeValveEvent(value, nowIso) : null;
  return Object.entries(record).flatMap(([key, child]) =>
    collectNestedValveEventCandidates(child, nowIso, [...path, key])
  ).concat(directEvent ? [directEvent] : []);
}

function collectValveEvents(
  status: Record<string, unknown>,
  health: Record<string, unknown>,
  history: Record<string, unknown>,
  nowIso: string,
) {
  const sources = [
    nestedRecord(nestedRecord(health, "api"), "watering").events,
    nestedRecord(health, "watering").events,
    nestedRecord(status, "watering").events,
    nestedRecord(nestedRecord(health, "api"), "valves").events,
  ];
  const directEvents = sources
    .flatMap((source) => Array.isArray(source) ? source : [])
    .map((event) => normalizeValveEvent(event, nowIso))
    .filter((event): event is ValveEventInsert => event != null);
  const scalarEvents = collectNestedScalarWateringEvents({ status, health, history }, nowIso);
  const nestedEvents = collectNestedValveEventCandidates(history, nowIso, ["history"]);
  const events = [...directEvents, ...scalarEvents, ...nestedEvents];

  const deduped = new Map<string, ValveEventInsert>();
  for (const event of events) {
    if (isIgnoredDiagnosticValveEvent(event)) continue;
    if (!deduped.has(event.event_id)) {
      deduped.set(event.event_id, event);
    }
  }
  return [...deduped.values()];
}

function isIgnoredDiagnosticValveEvent(event: ValveEventInsert) {
  return (
    isIgnoredDiagnosticPairingName(event.pairing_name) ||
    isIgnoredDiagnosticValveKey(event.valve_key) ||
    isIgnoredDiagnosticNumber(event.source_valve_id, ignoredDiagnosticValveIds)
  );
}

function valveEventWriteRow(event: ValveEventInsert): ValveEventWriteRow {
  return {
    ...event,
    organization_id: mattOrganizationId,
    project_id: mattProjectId,
    device_id: mattDeviceId,
  };
}

function compactError(error: unknown) {
  try {
    return JSON.stringify(error, (_key, value) => {
      if (typeof value === "string" && value.length > 500) {
        return `${value.slice(0, 500)}...`;
      }
      return value;
    });
  } catch {
    return null;
  }
}

function compactValveEvent(row: ValveEventWriteRow) {
  return {
    event_id: row.event_id,
    source_valve_id: row.source_valve_id,
    pairing_name: row.pairing_name,
    valve_key: row.valve_key,
    action: row.action,
    duration_ms: row.duration_ms,
    device_recorded_at: row.device_recorded_at,
  };
}

async function insertValveEventRows(
  admin: ReturnType<typeof createClient>,
  rows: ValveEventWriteRow[],
) {
  let inserted = 0;
  let fallbackRows = 0;
  const batchSize = 50;

  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const { error: batchError } = await admin
      .from("valve_events")
      .insert(batch);

    if (!batchError) {
      inserted += batch.length;
      continue;
    }

    for (const row of batch) {
      const { error: rowError } = await admin
        .from("valve_events")
        .upsert(row, { onConflict: "event_id", ignoreDuplicates: true });

      if (rowError) {
        return {
          inserted,
          fallbackRows,
          error: rowError.message,
          code: rowError.code ?? null,
          details: rowError.details ?? null,
          hint: rowError.hint ?? null,
          raw: compactError(rowError),
          rejected: compactValveEvent(row),
        };
      }

      inserted += 1;
      fallbackRows += 1;
    }
  }

  return {
    inserted,
    fallbackRows,
    error: null as string | null,
    code: null as string | null,
    details: null as string | null,
    hint: null as string | null,
    raw: null as string | null,
    rejected: null as ReturnType<typeof compactValveEvent> | null,
  };
}

async function selectExistingValveEventIds(
  admin: ReturnType<typeof createClient>,
  eventIds: string[],
) {
  const existingIds = new Set<string>();
  const batchSize = 50;

  for (let index = 0; index < eventIds.length; index += batchSize) {
    const batch = eventIds.slice(index, index + batchSize);
    const { data: existing, error } = await admin
      .from("valve_events")
      .select("event_id")
      .in("event_id", batch);

    if (error) {
      return {
        existingIds,
        error,
      };
    }

    for (const row of existing ?? []) {
      const eventId = asString((row as { event_id?: unknown }).event_id);
      if (eventId) existingIds.add(eventId);
    }
  }

  return {
    existingIds,
    error: null,
  };
}

async function insertMissingValveEvents(
  admin: ReturnType<typeof createClient>,
  events: ValveEventInsert[],
) {
  if (!events.length) {
    return {
      inserted: 0,
      error: null as string | null,
      code: null as string | null,
      details: null as string | null,
      hint: null as string | null,
      raw: null as string | null,
      rejected: null as ReturnType<typeof compactValveEvent> | null,
      fallbackRows: 0,
    };
  }

  const eventIds = events.map((event) => event.event_id);
  const existingResult = await selectExistingValveEventIds(admin, eventIds);
  const selectError = existingResult.error;

  if (selectError) {
    return {
      inserted: 0,
      error: selectError.message,
      code: selectError.code ?? null,
      details: selectError.details ?? null,
      hint: selectError.hint ?? null,
      raw: compactError(selectError),
      rejected: null,
      fallbackRows: 0,
    };
  }

  const missingEvents = events.filter((event) => !existingResult.existingIds.has(event.event_id));

  if (!missingEvents.length) {
    return {
      inserted: 0,
      error: null,
      code: null,
      details: null,
      hint: null,
      raw: null,
      rejected: null,
      fallbackRows: 0,
    };
  }

  return insertValveEventRows(admin, missingEvents.map(valveEventWriteRow));
}

serve(async (request) => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = cleanSecret(Deno.env.get("SUPABASE_URL"));
  const serviceRoleKey = cleanSecret(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const ownerUser = cleanSecret(Deno.env.get("MATT_OWNER_HEALTH_USER"));
  const ownerPassword = cleanSecret(Deno.env.get("MATT_OWNER_HEALTH_PASSWORD"));

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is missing Supabase configuration" }, 500, origin);
  }

  if (!ownerUser || !ownerPassword) {
    return jsonResponse({ error: "Server is missing owner-health credentials" }, 500, origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const syncSecretAuthorized = hasSyncSecret(request);
  const requestedBy = syncSecretAuthorized
    ? null
    : await portalAdminUserId(admin, request);

  if (!syncSecretAuthorized && !requestedBy) {
    return jsonResponse({ error: "Admin access is required for owner-health sync" }, 403, origin);
  }

  const authHeader = basicAuthHeader(ownerUser, ownerPassword);
  const [statusResponse, healthResponse, historyResponse] = await Promise.all([
    fetchJson(`${ownerHealthBaseUrl}/api/status`, authHeader),
    fetchJson(`${ownerHealthBaseUrl}/api/health`, authHeader),
    fetchJson(`${ownerHealthBaseUrl}/api/history?days=2`, authHeader),
  ]);
  const status = statusResponse.ok ? statusResponse.data : {};
  const history = historyResponse.ok ? historyResponse.data : {};
  const historyRecords = Array.isArray(history.records) ? history.records : [];
  const rawMissingSensors = asArray(status.missing_sensors);
  const rawStaleSensors = asArray(status.stale_sensors);
  const missingSensors = filterIgnoredDiagnosticItems(rawMissingSensors);
  const staleSensors = filterIgnoredDiagnosticItems(rawStaleSensors);
  const ignoredMissingCount = rawMissingSensors.length - missingSensors.length;
  const ignoredStaleCount = rawStaleSensors.length - staleSensors.length;
  const ignoredSensorCount = new Set([
    ...rawMissingSensors.filter(isIgnoredDiagnosticSensorItem).map(diagnosticIssueText),
    ...rawStaleSensors.filter(isIgnoredDiagnosticSensorItem).map(diagnosticIssueText),
  ]).size;
  const nowIso = new Date().toISOString();
  const valveEvents = collectValveEvents(
    status,
    healthResponse.ok ? healthResponse.data : {},
    history,
    nowIso,
  );

  const snapshot = {
    project_id: mattProjectId,
    device_id: mattDeviceId,
    device_name: "plain-feather",
    source: "owner-health",
    captured_at: asTimestamp(status.last_checked_at) ?? nowIso,
    owner_checked_at: asTimestamp(status.last_checked_at),
    status_endpoint_ok: statusResponse.ok,
    history_endpoint_ok: historyResponse.ok,
    status_http_status: statusResponse.status,
    status_elapsed_ms: statusResponse.elapsedMs,
    history_samples: historyRecords.length,
    overall_status: asString(status.overall_status),
    api_status: asString(status.api_status),
    pi_online: asBoolean(status.pi_online),
    public_url_reachable: asBoolean(status.public_url_reachable),
    ethernet_link: asBoolean(status.ethernet_link),
    ethernet_ip: asString(status.ethernet_ip),
    gateway_ping_ms: asNumber(status.gateway_ping_ms),
    undervoltage: asBoolean(status.undervoltage),
    cpu_temp_c: asNumber(status.cpu_temp_c),
    uptime_seconds: asNumber(status.uptime_seconds),
    sensors_expected: adjustedHealthCount(asInteger(status.sensors_expected), ignoredSensorCount),
    sensors_current: asInteger(status.sensors_current),
    sensors_stale: adjustedHealthCount(asInteger(status.sensors_stale), ignoredStaleCount),
    sensors_missing: adjustedHealthCount(asInteger(status.sensors_missing), ignoredMissingCount),
    missing_sensors: missingSensors,
    stale_sensors: staleSensors,
    last_sensor_reading_at: asTimestamp(status.last_sensor_reading_at),
    watering_last_event: asString(status.watering_last_event),
    watering_last_event_at: asTimestamp(status.watering_last_event_at),
    watering_events_last_24h: asInteger(status.watering_events_last_24h),
    scheduler_jobs_loaded: asInteger(status.scheduler_jobs_loaded),
    active_alerts: asArray(status.active_alerts).filter((issue) => !isIgnoredDiagnosticIssue(issue)),
    known_issues: asArray(status.known_issues).filter((issue) => !isIgnoredDiagnosticIssue(issue)),
    raw_status: statusResponse.data,
    raw_health: healthResponse.data,
    raw_history: historyResponse.data,
  };

  const { data, error } = await admin
    .from("device_health_snapshots")
    .insert(snapshot)
    .select("id, captured_at, overall_status, sensors_current, sensors_stale, sensors_missing")
    .single();

  if (error) {
    return jsonResponse({ error: "Could not write health snapshot" }, 500, origin);
  }

  const valveEventWrite = await insertMissingValveEvents(admin, valveEvents);
  if (valveEventWrite.error) {
    console.error("Could not write valve events", valveEventWrite.error);
  }

  return jsonResponse({
    ok: true,
    snapshot: data,
    valveEvents: {
      found: valveEvents.length,
      inserted: valveEventWrite.inserted,
      error: valveEventWrite.error,
      code: valveEventWrite.code,
      details: valveEventWrite.details,
      hint: valveEventWrite.hint,
      fallbackRows: valveEventWrite.fallbackRows,
      rejected: valveEventWrite.rejected,
      raw: valveEventWrite.raw,
    },
    source: {
      statusEndpointOk: statusResponse.ok,
      healthEndpointOk: healthResponse.ok,
      historyEndpointOk: historyResponse.ok,
      historySamples: historyRecords.length,
    },
  }, 200, origin);
});
