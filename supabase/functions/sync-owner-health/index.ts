import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  configRefreshDue,
  configRefreshOutcome,
} from "./config-refresh-policy.mjs";
import {
  collectLiveReadingRows,
  resolveEvidencePairing,
  semanticDedupeValveEvents,
} from "./rd-evidence-policy.mjs";
import { uptimeSecondsFromSources } from "./uptime-policy.mjs";

const mattProjectId = "22222222-2222-4222-8222-222222222222";
const mattOrganizationId = "11111111-1111-4111-8111-111111111111";
const mattDeviceId = "3100e37ee3205651fe3dd86dafd4dc0c";
const ownerHealthBaseUrl =
  `https://${mattDeviceId}.balena-devices.com/owner-health`;
const ignoredDiagnosticPairingNames = new Set(["cwd-lowercaset", "720-1539"]);
const ignoredDiagnosticSensorKeys = new Set(["t", "d30gqn2d:t"]);
const ignoredDiagnosticValveKeys = new Set([
  "1539",
  "0x20:3",
  "d30gqn2d:0x20:3",
]);
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

type SyncRequest = {
  source?: unknown;
  include_config?: unknown;
  include_history?: unknown;
};

type AdminClient = SupabaseClient<any, "public", any>;

type DeviceRuntimeStateWrite = {
  project_id: string;
  device_id: string;
  device_name: string;
  source: string;
  controller_state: string;
  controller_state_raw: string | null;
  controller_state_updated_at: string | null;
  state_observed_at: string;
  state_fresh_until: string;
  owner_checked_at: string | null;
  overall_status: string | null;
  api_status: string | null;
  pi_online: boolean | null;
  public_url_reachable: boolean | null;
  watering_enabled: boolean | null;
  watering_disabled: unknown[];
  watering_last_event: string | null;
  watering_last_event_at: string | null;
  watering_events_last_24h: number | null;
  scheduler_jobs_loaded: number | null;
  sensors_expected: number | null;
  sensors_current: number | null;
  sensors_stale: number | null;
  sensors_missing: number | null;
  last_sensor_reading_at: string | null;
  config_hash: string | null;
  raw_status: Record<string, unknown>;
  raw_health: Record<string, unknown>;
  raw_system: Record<string, unknown>;
  updated_at: string;
};

type DeviceConfigStateWrite = {
  project_id: string;
  device_id: string;
  device_name: string;
  source: string;
  observed_at: string;
  pairings: unknown[];
  calibrations: unknown[];
  board_config: unknown[];
  sensors: unknown[];
  valves: unknown[];
  groups: unknown[];
  pairing_count: number;
  calibration_count: number;
  board_count: number;
  sensor_count: number;
  valve_count: number;
  group_count: number;
  config_hash: string;
  endpoint_status: Record<string, unknown>;
  raw_config: Record<string, unknown>;
  updated_at: string;
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
  evidence_source:
    | "owner_health_direct"
    | "owner_health_scalar"
    | "owner_health_history"
    | "unknown";
  source_class: "automatic" | "manual" | "unknown";
  pairing_name_raw: string | null;
  pairing_resolved: boolean;
  quality_flags: string[];
};

type ValveEventWriteRow = ValveEventInsert & {
  organization_id: string;
  project_id: string;
  device_id: string;
};

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && allowedOrigins.has(origin)
    ? origin
    : "https://exacth2o.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-sync-owner-health-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  origin: string | null = null,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanSecret(value: string | null | undefined) {
  return (value ?? "").trim();
}

function bearerToken(request: Request) {
  return (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    .trim();
}

function hasSyncSecret(request: Request) {
  const acceptedSecrets = [
    cleanSecret(Deno.env.get("SYNC_OWNER_HEALTH_SECRET")),
    cleanSecret(Deno.env.get("SYNC_OWNER_HEALTH_CRON_SECRET")),
    cleanSecret(Deno.env.get("EXACTH2O_CONTROL_EXECUTOR_SYNC_SECRET")),
  ].filter(Boolean);
  if (acceptedSecrets.length === 0) return false;
  const suppliedSecrets = [
    cleanSecret(request.headers.get("x-sync-owner-health-secret")),
    bearerToken(request),
  ].filter(Boolean);
  return acceptedSecrets.some((acceptedSecret) =>
    suppliedSecrets.includes(acceptedSecret)
  );
}

function basicAuthHeader(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

async function fetchJson(
  url: string,
  authHeader: string,
  timeoutMs = 25_000,
): Promise<FetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        data = {};
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

function skippedFetchResult(reason: string): FetchResult {
  return {
    ok: false,
    status: null,
    elapsedMs: null,
    data: {},
    error: reason,
  };
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" && value.trim() && Number.isFinite(Number(value))
  ) return Number(value);
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
  if (
    typeof value === "string" && value.trim() && Number.isFinite(Number(value))
  ) {
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
    "d30gqn2d:t",
  ].some((needle) => text.includes(needle));
}

function isIgnoredDiagnosticSensorItem(value: unknown) {
  const record = asRecord(value);
  return (
    isIgnoredDiagnosticSensorKey(value) ||
    isIgnoredDiagnosticPairingName(value) ||
    isIgnoredDiagnosticSensorKey(
      firstString(record, [
        "sensor",
        "sensor_key",
        "sensorKey",
        "address",
        "id",
        "name",
      ]),
    ) ||
    isIgnoredDiagnosticPairingName(
      firstString(record, ["pairing", "pairing_name", "pairingName", "name"]),
    ) ||
    isIgnoredDiagnosticNumber(
      record.source_sensor_id,
      ignoredDiagnosticSensorIds,
    ) ||
    isIgnoredDiagnosticNumber(
      record.sourceSensorId,
      ignoredDiagnosticSensorIds,
    ) ||
    isIgnoredDiagnosticNumber(record.sensor_id, ignoredDiagnosticSensorIds) ||
    isIgnoredDiagnosticNumber(record.sensorId, ignoredDiagnosticSensorIds)
  );
}

function filterIgnoredDiagnosticItems(values: unknown[]) {
  return values.filter((value) =>
    !isIgnoredDiagnosticSensorItem(value) && !isIgnoredDiagnosticIssue(value)
  );
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
  const text = firstString(record, ["action", "event", "state", "operation"])
    ?.toLowerCase() ?? "";
  return text.includes("close") || text.includes("closed") ? "close" : "open";
}

function normalizeValveEvent(
  value: unknown,
  nowIso: string,
  evidenceSource: ValveEventInsert["evidence_source"] = "unknown",
): ValveEventInsert | null {
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

  const pairingName = firstString(record, [
    "pairing",
    "pairing_name",
    "pairingName",
    "name",
  ]);
  const valveKey = firstString(record, [
    "valve",
    "valve_key",
    "valveKey",
    "valve_id",
    "valveId",
  ]);
  const sourceValveId = firstInteger(record, [
    "source_valve_id",
    "sourceValveId",
    "sourceValveID",
  ]);
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
    evidence_source: evidenceSource,
    source_class: "unknown",
    pairing_name_raw: pairingName ?? valveKey,
    pairing_resolved: false,
    quality_flags: [],
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

  const pairingName = firstString(record, [
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
  const duration = firstInteger(record, [
    "watering_last_duration_ms",
    "wateringLastDurationMs",
  ]) ??
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
    evidence_source: "owner_health_scalar",
    source_class: "unknown",
    pairing_name_raw: pairingName,
    pairing_resolved: false,
    quality_flags: [
      "ambiguous_source",
      ...(duration == null ? ["null_duration"] : []),
    ],
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
      ...value.flatMap((item) =>
        collectNestedScalarWateringEvents(item, nowIso)
      ),
    ];
  }

  const record = asRecord(value);
  if (!Object.keys(record).length) return directEvent ? [directEvent] : [];

  return [
    ...(directEvent ? [directEvent] : []),
    ...Object.values(record).flatMap((child) =>
      collectNestedScalarWateringEvents(child, nowIso)
    ),
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
        .map((event) =>
          normalizeValveEvent(event, nowIso, "owner_health_history")
        )
        .filter((event): event is ValveEventInsert => event != null)
      : [];
    const nestedEvents = value.flatMap((item, index) =>
      collectNestedValveEventCandidates(item, nowIso, [...path, String(index)])
    );
    return [...directEvents, ...nestedEvents];
  }

  const record = asRecord(value);
  if (!Object.keys(record).length) return [];
  const directEvent = pathHintsValveEvents(path)
    ? normalizeValveEvent(value, nowIso)
    : null;
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
    .map((event) => normalizeValveEvent(event, nowIso, "owner_health_direct"))
    .filter((event): event is ValveEventInsert => event != null);
  const scalarEvents = collectNestedScalarWateringEvents({
    status,
    health,
    history,
  }, nowIso);
  const nestedEvents = collectNestedValveEventCandidates(history, nowIso, [
    "history",
  ]);
  const events = [...directEvents, ...scalarEvents, ...nestedEvents].map(
    (event) => {
      const resolution = resolveEvidencePairing(event.pairing_name, health);
      const automatic = event.evidence_source === "owner_health_direct" &&
        resolution.resolved;
      const qualityFlags = new Set(event.quality_flags);
      if (!resolution.resolved) qualityFlags.add("unmapped_pairing");
      if (event.duration_ms == null) qualityFlags.add("null_duration");
      if (event.action === "open") qualityFlags.add("open_only");
      if (!automatic) qualityFlags.add("ambiguous_source");
      return {
        ...event,
        pairing_name: resolution.pairingName,
        pairing_name_raw: resolution.raw || event.pairing_name_raw,
        pairing_resolved: resolution.resolved,
        source_class: automatic ? "automatic" as const : "unknown" as const,
        quality_flags: [...qualityFlags],
      };
    },
  );

  const deduped = new Map<string, ValveEventInsert>();
  for (const event of events) {
    if (isIgnoredDiagnosticValveEvent(event)) continue;
    if (!deduped.has(event.event_id)) {
      deduped.set(event.event_id, event);
    }
  }
  return semanticDedupeValveEvents([...deduped.values()]);
}

function isIgnoredDiagnosticValveEvent(event: ValveEventInsert) {
  if (isIgnoredDiagnosticPairingName(event.pairing_name)) return true;
  const hasPairingIdentity = typeof event.pairing_name === "string" &&
    event.pairing_name.trim() !== "" && event.pairing_name !== "unknown";
  return (
    !hasPairingIdentity && (
      isIgnoredDiagnosticValveKey(event.valve_key) ||
      isIgnoredDiagnosticNumber(event.source_valve_id, ignoredDiagnosticValveIds)
    )
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
    evidence_source: row.evidence_source,
    source_class: row.source_class,
    pairing_resolved: row.pairing_resolved,
    quality_flags: row.quality_flags,
  };
}

async function insertValveEventRows(
  admin: AdminClient,
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
  admin: AdminClient,
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
  admin: AdminClient,
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

  const missingEvents = events.filter((event) =>
    !existingResult.existingIds.has(event.event_id)
  );

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

async function mirrorLiveReadings(
  admin: AdminClient,
  health: Record<string, unknown>,
  nowIso: string,
) {
  const enabled = Deno.env.get("RD_LIVE_READING_MIRROR_ENABLED") !== "false";
  const rows = collectLiveReadingRows(health, {
    organizationId: mattOrganizationId,
    projectId: mattProjectId,
    deviceId: mattDeviceId,
    serverReceivedAt: nowIso,
  });
  if (!enabled) {
    return {
      enabled,
      found: rows.length,
      inserted: 0,
      error: null as string | null,
    };
  }
  if (!rows.length) {
    return { enabled, found: 0, inserted: 0, error: null as string | null };
  }

  const { data, error } = await admin.rpc("mirror_live_sensor_readings", {
    reading_rows: rows,
  });
  return {
    enabled,
    found: rows.length,
    inserted: error ? 0 : asInteger(data) ?? 0,
    error: error?.message ?? null,
  };
}

function hasUsableValue(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function valueAtPath(source: unknown, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return current;
}

function firstValueAtPaths(sources: unknown[], paths: string[][]) {
  for (const source of sources) {
    for (const path of paths) {
      const value = valueAtPath(source, path);
      if (hasUsableValue(value)) return value;
    }
  }
  return null;
}

function firstNestedValue(
  value: unknown,
  keys: string[],
  maxDepth = 5,
): unknown {
  if (maxDepth < 0) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = firstNestedValue(item, keys, maxDepth - 1);
      if (hasUsableValue(nested)) return nested;
    }
    return null;
  }

  const record = asRecord(value);
  if (!Object.keys(record).length) return null;

  for (const key of keys) {
    const valueForKey = record[key];
    if (hasUsableValue(valueForKey)) return valueForKey;
  }

  for (const child of Object.values(record)) {
    const nested = firstNestedValue(child, keys, maxDepth - 1);
    if (hasUsableValue(nested)) return nested;
  }

  return null;
}

function firstNestedFromSources(sources: unknown[], keys: string[]) {
  for (const source of sources) {
    const value = firstNestedValue(source, keys);
    if (hasUsableValue(value)) return value;
  }
  return null;
}

function normalizeControllerState(value: unknown) {
  const text = asString(value);
  if (!text) return "UNKNOWN";
  const normalized = text.toLowerCase();
  if (normalized.includes("running") || normalized === "run") return "RUNNING";
  if (
    normalized.includes("stopped") ||
    normalized.includes("disabled") ||
    normalized.includes("paused") ||
    normalized === "stop"
  ) {
    return "STOPPED";
  }
  if (
    normalized.includes("startup") ||
    normalized.includes("starting") ||
    normalized.includes("boot") ||
    normalized.includes("initializing")
  ) {
    return "STARTUP";
  }
  return text.toUpperCase();
}

function controllerStateFromSources(sources: unknown[]) {
  const systemSource = sources[2] ?? {};
  const raw = firstValueAtPaths(sources, [
    ["controller_state"],
    ["system_state"],
    ["systemState"],
    ["current_state"],
    ["currentState"],
    ["api", "system", "state"],
    ["api", "system", "data", "state"],
    ["api", "controller", "state"],
    ["system", "state"],
    ["controller", "state"],
    ["runtime", "state"],
  ]) ?? firstValueAtPaths([systemSource], [
    ["state"],
    ["status"],
  ]) ?? firstNestedFromSources(sources, [
    "controller_state",
    "system_state",
    "systemState",
    "current_state",
    "currentState",
  ]);

  return {
    raw: asString(raw),
    normalized: normalizeControllerState(raw),
  };
}

function stateUpdatedAtFromSources(sources: unknown[], fallback: string) {
  const value = firstValueAtPaths(sources, [
    ["controller_state_updated_at"],
    ["state_updated_at"],
    ["stateUpdatedAt"],
    ["updated_at"],
    ["updatedAt"],
    ["api", "system", "updated_at"],
    ["system", "updated_at"],
    ["controller", "updated_at"],
  ]) ?? firstNestedFromSources(sources, [
    "controller_state_updated_at",
    "state_updated_at",
    "stateUpdatedAt",
  ]);

  return asTimestamp(value) ?? fallback;
}

function firstBooleanFromSources(
  sources: unknown[],
  paths: string[][],
  nestedKeys: string[],
) {
  const pathValue = firstValueAtPaths(sources, paths);
  const pathBoolean = asBoolean(pathValue);
  if (pathBoolean != null) return pathBoolean;

  const nestedValue = firstNestedFromSources(sources, nestedKeys);
  return asBoolean(nestedValue);
}

function wateringDisabledFromSources(sources: unknown[]) {
  const value = firstValueAtPaths(sources, [
    ["watering_disabled"],
    ["wateringDisabled"],
    ["watering", "disabled"],
    ["watering", "disabled_pairings"],
    ["watering", "disabledPairings"],
    ["api", "watering", "disabled"],
  ]) ?? firstNestedFromSources(sources, [
    "watering_disabled",
    "wateringDisabled",
    "disabled_pairings",
    "disabledPairings",
  ]);

  return filterIgnoredDiagnosticItems(asArray(value));
}

type ConfigSectionMatch = {
  found: boolean;
  value: unknown;
};

function configSectionCandidates(
  value: unknown,
  keys: string[],
  maxDepth = 5,
): unknown[] {
  if (maxDepth < 0) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      configSectionCandidates(item, keys, maxDepth - 1)
    );
  }

  const record = asRecord(value);
  if (!Object.keys(record).length) return [];
  const matches = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    .map((key) => record[key]);
  return [
    ...matches,
    ...Object.values(record).flatMap((child) =>
      configSectionCandidates(child, keys, maxDepth - 1)
    ),
  ];
}

function extractConfigSection(
  sources: unknown[],
  keys: string[],
): ConfigSectionMatch {
  let explicitEmpty: unknown = null;
  let emptyFound = false;

  for (const source of sources) {
    for (const candidate of configSectionCandidates(source, keys)) {
      if (hasUsableValue(candidate)) return { found: true, value: candidate };
      if (
        Array.isArray(candidate) ||
        (candidate !== null && typeof candidate === "object")
      ) {
        if (!emptyFound) explicitEmpty = candidate;
        emptyFound = true;
      }
    }
  }

  return emptyFound
    ? { found: true, value: explicitEmpty }
    : { found: false, value: null };
}

function normalizeConfigSection(
  value: unknown,
  kind:
    | "pairings"
    | "calibrations"
    | "board_config"
    | "sensors"
    | "valves"
    | "groups",
) {
  if (!hasUsableValue(value)) return [];

  let items: unknown[] = [];
  if (Array.isArray(value)) {
    items = value;
  } else {
    const record = asRecord(value);
    const nestedArray = asArray(record.items).length
      ? asArray(record.items)
      : asArray(record.records).length
      ? asArray(record.records)
      : asArray(record.data);
    if (nestedArray.length) {
      items = nestedArray;
    } else {
      const values = Object.values(record);
      items = values.length && values.every((item) =>
          typeof item === "object" && item !== null
        )
        ? values
        : [record];
    }
  }

  // Dedicated controller config endpoints are authoritative. Historical
  // diagnostic filters belong only to aggregate health/event ingestion; using
  // them here can drop legitimate boards, sensor addresses, or pairings.
  return items;
}

function resolvedConfigSection(
  current: ConfigSectionMatch,
  previous: unknown,
  kind:
    | "pairings"
    | "calibrations"
    | "board_config"
    | "sensors"
    | "valves"
    | "groups",
) {
  return normalizeConfigSection(current.found ? current.value : previous, kind);
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortedJsonValue(record[key]);
      return sorted;
    }, {});
}

function stableJson(value: unknown) {
  return JSON.stringify(sortedJsonValue(value));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function upsertDeviceRuntimeState(
  admin: AdminClient,
  row: DeviceRuntimeStateWrite,
) {
  const { data, error } = await admin
    .from("device_runtime_state")
    .upsert(row, { onConflict: "project_id,device_id" })
    .select("controller_state, state_observed_at, updated_at")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: error.message,
      code: error.code ?? null,
      details: error.details ?? null,
    };
  }

  return {
    ok: true,
    row: data ?? null,
    error: null,
    code: null,
    details: null,
  };
}

async function upsertDeviceConfigState(
  admin: AdminClient,
  row: DeviceConfigStateWrite,
) {
  const { data, error } = await admin
    .from("device_config_state")
    .upsert(row, { onConflict: "project_id,device_id" })
    .select("config_hash, observed_at, updated_at")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: error.message,
      code: error.code ?? null,
      details: error.details ?? null,
    };
  }

  return {
    ok: true,
    row: data ?? null,
    error: null,
    code: null,
    details: null,
  };
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
    return jsonResponse(
      { error: "Server is missing Supabase configuration" },
      500,
      origin,
    );
  }

  if (!ownerUser || !ownerPassword) {
    return jsonResponse(
      { error: "Server is missing owner-health credentials" },
      500,
      origin,
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const syncSecretAuthorized = hasSyncSecret(request);
  if (!syncSecretAuthorized) {
    return jsonResponse(
      { error: "Server ingestion authorization is required" },
      401,
      origin,
    );
  }

  let syncRequest: SyncRequest = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      syncRequest = parsed as SyncRequest;
    }
  } catch {
    // Scheduled watchdog calls intentionally use an empty request body.
  }

  const requestedSource = (asString(syncRequest.source) ?? "scheduled_watchdog")
    .slice(0, 80);
  const trustedSyncSources = new Set([
    "scheduled_watchdog",
    "github_actions_watchdog",
    "supabase_cron_watchdog",
    "control_executor",
    "control_executor_watchdog",
    "manual_admin_sync",
  ]);
  const source = trustedSyncSources.has(requestedSource)
    ? requestedSource
    : "scheduled_watchdog";
  let includeHistory = syncRequest.include_history === true;
  const leaseHolder = crypto.randomUUID();
  const { data: leaseAcquired, error: leaseError } = await admin.rpc(
    "acquire_device_ingest_lease",
    {
      lease_project_id: mattProjectId,
      lease_device_id: mattDeviceId,
      lease_holder: leaseHolder,
      lease_seconds: 300,
    },
  );

  if (leaseError) {
    console.error("Could not acquire health ingest lease", leaseError);
    return jsonResponse(
      { error: "Could not acquire health ingest lease" },
      500,
      origin,
    );
  }

  if (leaseAcquired !== true) {
    return jsonResponse({ ok: true, deduplicated: true, source }, 202, origin);
  }

  const releaseLease = async () => {
    const { error } = await admin.rpc("release_device_ingest_lease", {
      lease_project_id: mattProjectId,
      lease_device_id: mattDeviceId,
      lease_holder: leaseHolder,
    });
    if (error) console.error("Could not release health ingest lease", error);
  };

  try {
    if (source.endsWith("_watchdog")) {
      const { error: retentionError } = await admin.rpc(
        "run_device_health_retention",
        {
          retention_days: 30,
          minimum_interval_hours: 23,
        },
      );
      if (retentionError) {
        console.error("Could not run health retention", retentionError);
      }

      const { data: historyMaintenance, error: historyMaintenanceError } =
        await admin
          .from("device_maintenance_state")
          .select("last_completed_at")
          .eq("task_name", "owner_health_history_recovery")
          .maybeSingle();
      if (historyMaintenanceError) {
        console.error(
          "Could not read history recovery checkpoint",
          historyMaintenanceError,
        );
      }
      const lastHistoryRecoveryAt = Date.parse(
        String(historyMaintenance?.last_completed_at ?? ""),
      );
      const historyRecoveryDue = historyMaintenanceError !== null ||
        !Number.isFinite(lastHistoryRecoveryAt) ||
        Date.now() - lastHistoryRecoveryAt >= 30 * 60 * 1000;
      includeHistory = includeHistory || historyRecoveryDue;

      const isExternalWatchdog = source === "scheduled_watchdog" ||
        source === "github_actions_watchdog" ||
        source === "supabase_cron_watchdog";
      if (isExternalWatchdog) {
        const [latestSnapshotResult, latestRuntimeResult] = await Promise.all([
          admin
            .from("device_health_snapshots")
            .select(
              "created_at, captured_at, status_endpoint_ok, ingest_complete",
            )
            .eq("project_id", mattProjectId)
            .eq("device_id", mattDeviceId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          admin
            .from("device_runtime_state")
            .select("updated_at, state_observed_at, state_fresh_until")
            .eq("project_id", mattProjectId)
            .eq("device_id", mattDeviceId)
            .maybeSingle(),
        ]);
        const latestSnapshot = latestSnapshotResult.data;
        const latestRuntime = latestRuntimeResult.data;
        const latestCreatedAt = Date.parse(
          String(latestSnapshot?.created_at ?? ""),
        );
        const latestRuntimeAt = Date.parse(
          String(latestRuntime?.updated_at ?? ""),
        );
        const latestCapturedAt = Date.parse(
          String(latestSnapshot?.captured_at ?? ""),
        );
        const latestStateObservedAt = Date.parse(
          String(latestRuntime?.state_observed_at ?? ""),
        );
        const latestStateFreshUntil = Date.parse(
          String(latestRuntime?.state_fresh_until ?? ""),
        );
        if (
          !includeHistory &&
          latestSnapshot?.status_endpoint_ok === true &&
          latestSnapshot?.ingest_complete === true &&
          Number.isFinite(latestCreatedAt) &&
          Number.isFinite(latestRuntimeAt) &&
          Number.isFinite(latestCapturedAt) &&
          Number.isFinite(latestStateObservedAt) &&
          Number.isFinite(latestStateFreshUntil) &&
          Date.now() - latestCreatedAt < 3 * 60 * 1000 &&
          Date.now() - latestRuntimeAt < 3 * 60 * 1000 &&
          Date.now() - latestCapturedAt < 10 * 60 * 1000 &&
          Date.now() - latestStateObservedAt < 10 * 60 * 1000 &&
          latestStateFreshUntil > Date.now()
        ) {
          return jsonResponse(
            {
              ok: true,
              deduplicated: true,
              source,
              reason: "primary_authority_fresh",
            },
            202,
            origin,
          );
        }
      }
    }

    const [lastConfigStateResult, configAttemptResult] = await Promise.all([
      admin
        .from("device_config_state")
        .select(
          "updated_at, config_hash, pairings, calibrations, board_config, sensors, valves, groups",
        )
        .eq("project_id", mattProjectId)
        .eq("device_id", mattDeviceId)
        .maybeSingle(),
      admin
        .from("device_maintenance_state")
        .select("last_completed_at")
        .eq("task_name", "owner_health_config_refresh_attempt")
        .maybeSingle(),
    ]);
    if (lastConfigStateResult.error) {
      console.error(
        "Could not read previous config state",
        lastConfigStateResult.error,
      );
    }
    if (configAttemptResult.error) {
      console.error(
        "Could not read config refresh checkpoint",
        configAttemptResult.error,
      );
    }
    const lastConfigState = lastConfigStateResult.data;
    const lastConfigAt = Date.parse(String(lastConfigState?.updated_at ?? ""));
    const lastConfigAttemptAt = Date.parse(
      String(configAttemptResult.data?.last_completed_at ?? ""),
    );
    const configIsStale = configRefreshDue({
      lastConfigUpdatedAtMs: lastConfigAt,
      lastAttemptCompletedAtMs: lastConfigAttemptAt,
      nowMs: Date.now(),
    });
    const configRefreshRequired = syncRequest.include_config === true ||
      source === "control_executor";
    const includeConfig = configRefreshRequired || configIsStale;

    const authHeader = basicAuthHeader(ownerUser, ownerPassword);
    const optionalEndpointTimeoutMs = 6_000;
    const [
      statusResponse,
      healthResponse,
      historyResponse,
      systemResponse,
      systemConfigResponse,
      configResponse,
      pairingsResponse,
    ] = await Promise.all([
      fetchJson(`${ownerHealthBaseUrl}/api/status`, authHeader),
      fetchJson(`${ownerHealthBaseUrl}/api/health`, authHeader),
      includeHistory
        ? fetchJson(`${ownerHealthBaseUrl}/api/history?days=2`, authHeader)
        : Promise.resolve(skippedFetchResult("history_not_requested")),
      includeConfig
        ? fetchJson(
          `${ownerHealthBaseUrl}/api/system`,
          authHeader,
          optionalEndpointTimeoutMs,
        )
        : Promise.resolve(skippedFetchResult("config_not_due")),
      includeConfig
        ? fetchJson(
          `${ownerHealthBaseUrl}/api/system-config`,
          authHeader,
          optionalEndpointTimeoutMs,
        )
        : Promise.resolve(skippedFetchResult("config_not_due")),
      includeConfig
        ? fetchJson(
          `${ownerHealthBaseUrl}/api/config`,
          authHeader,
          optionalEndpointTimeoutMs,
        )
        : Promise.resolve(skippedFetchResult("config_not_due")),
      includeConfig
        ? fetchJson(
          `${ownerHealthBaseUrl}/api/pairings`,
          authHeader,
          optionalEndpointTimeoutMs,
        )
        : Promise.resolve(skippedFetchResult("config_not_due")),
    ]);
    if (!statusResponse.ok) {
      return jsonResponse(
        { error: "Owner-health status endpoint is unavailable" },
        502,
        origin,
      );
    }
    const status = statusResponse.ok ? statusResponse.data : {};
    const health = healthResponse.ok ? healthResponse.data : {};
    const history = historyResponse.ok ? historyResponse.data : {};
    const system = systemResponse.ok ? systemResponse.data : {};
    const systemConfig = systemConfigResponse.ok
      ? systemConfigResponse.data
      : {};
    const config = configResponse.ok ? configResponse.data : {};
    const pairingsConfig = pairingsResponse.ok ? pairingsResponse.data : {};
    const historyRecords = Array.isArray(history.records)
      ? history.records
      : [];
    const rawMissingSensors = asArray(status.missing_sensors);
    const rawStaleSensors = asArray(status.stale_sensors);
    const missingSensors = filterIgnoredDiagnosticItems(rawMissingSensors);
    const staleSensors = filterIgnoredDiagnosticItems(rawStaleSensors);
    const ignoredMissingCount = rawMissingSensors.length -
      missingSensors.length;
    const ignoredStaleCount = rawStaleSensors.length - staleSensors.length;
    const ignoredSensorCount = new Set([
      ...rawMissingSensors.filter(isIgnoredDiagnosticSensorItem).map(
        diagnosticIssueText,
      ),
      ...rawStaleSensors.filter(isIgnoredDiagnosticSensorItem).map(
        diagnosticIssueText,
      ),
    ]).size;
    const nowIso = new Date().toISOString();
    const valveEvents = collectValveEvents(
      status,
      health,
      history,
      nowIso,
    );
    const runtimeSources = [status, health, system];
    // When config was not requested, aggregate health objects may contain fields
    // named like configuration sections (for example a compact pairing count).
    // They are diagnostics, not controller config; use the last verified mirror.
    const configSources = includeConfig
      ? [systemConfig, config, pairingsConfig, system, health, status]
      : [];
    const controllerState = controllerStateFromSources(runtimeSources);
    const wateringDisabled = wateringDisabledFromSources(runtimeSources);
    let wateringEnabled = firstBooleanFromSources(runtimeSources, [
      ["watering_enabled"],
      ["wateringEnabled"],
      ["watering", "enabled"],
      ["api", "watering", "enabled"],
    ], ["watering_enabled", "wateringEnabled"]) ??
      (wateringDisabled.length ? false : null);
    const currentPairings = extractConfigSection(configSources, [
      "pairings",
      "Pairings",
      "watering_pairings",
      "wateringPairings",
    ]);
    const currentCalibrations = extractConfigSection(configSources, [
      "calibrations",
      "Calibrations",
      "calibration",
      "Calibration",
    ]);
    const currentBoardConfig = extractConfigSection(configSources, [
      "board_config",
      "boardConfig",
      "board_configurations",
      "boardConfigurations",
      "board_configs",
      "boardConfigs",
      "boards",
    ]);
    const currentSensors = extractConfigSection(configSources, [
      "sensors",
      "Sensors",
    ]);
    const currentValves = extractConfigSection(configSources, [
      "valves",
      "Valves",
    ]);
    const currentGroups = extractConfigSection(configSources, [
      "groups",
      "Groups",
    ]);
    const pairings = resolvedConfigSection(
      currentPairings,
      lastConfigState?.pairings,
      "pairings",
    );
    const calibrations = resolvedConfigSection(
      currentCalibrations,
      lastConfigState?.calibrations,
      "calibrations",
    );
    const boardConfig = resolvedConfigSection(
      currentBoardConfig,
      lastConfigState?.board_config,
      "board_config",
    );
    const sensors = resolvedConfigSection(
      currentSensors,
      lastConfigState?.sensors,
      "sensors",
    );
    const valves = resolvedConfigSection(
      currentValves,
      lastConfigState?.valves,
      "valves",
    );
    const groups = resolvedConfigSection(
      currentGroups,
      lastConfigState?.groups,
      "groups",
    );
    if (wateringEnabled == null) {
      const hasEnabledPairing = pairings.some((pairing) => {
        const record = asRecord(pairing);
        const target = asNumber(
          record.WTCPercentLimit ?? record.wtc_percent_limit ??
            record.target_vwc,
        );
        return target != null && target > -999_000;
      });
      if (controllerState.normalized === "RUNNING") {
        wateringEnabled = hasEnabledPairing;
      }
      if (controllerState.normalized === "STOPPED") wateringEnabled = false;
    }
    const configSectionObserved = [
      currentPairings,
      currentCalibrations,
      currentBoardConfig,
      currentSensors,
      currentValves,
      currentGroups,
    ].some((section) => section.found);
    const configFetchSucceeded = includeConfig && (
      configResponse.ok || (systemConfigResponse.ok && pairingsResponse.ok)
    ) && configSectionObserved;
    const configIsComplete = pairings.length > 0 &&
      boardConfig.length > 0 &&
      sensors.length > 0 &&
      valves.length > 0;
    const shouldWriteConfig = configFetchSucceeded && configIsComplete;
    const configPayload = {
      pairings,
      calibrations,
      board_config: boardConfig,
      sensors,
      valves,
      groups,
    };
    const nextConfigHash = shouldWriteConfig
      ? await sha256Hex(stableJson(configPayload))
      : null;
    const configHash = nextConfigHash ?? asString(lastConfigState?.config_hash);
    const reportedCapturedValue = status.last_checked_at;
    const reportedCapturedPresent = reportedCapturedValue !== null &&
      reportedCapturedValue !== undefined &&
      String(reportedCapturedValue).trim() !== "";
    const reportedCapturedAt = asTimestamp(reportedCapturedValue);
    const reportedCapturedAtMs = Date.parse(String(reportedCapturedAt ?? ""));
    const observationTimestampValid = reportedCapturedPresent && (
      reportedCapturedAt !== null &&
      Number.isFinite(reportedCapturedAtMs) &&
      reportedCapturedAtMs <= Date.now() + 60 * 1000
    );
    const capturedAt = observationTimestampValid && reportedCapturedAt
      ? reportedCapturedAt
      : nowIso;
    const capturedAtMs = Date.parse(capturedAt);
    const statusObservationFresh = observationTimestampValid &&
      Number.isFinite(capturedAtMs) &&
      Date.now() - capturedAtMs <= 10 * 60 * 1000;
    const stateFreshUntil = statusObservationFresh
      ? new Date(capturedAtMs + 10 * 60 * 1000).toISOString()
      : new Date(Date.now() - 1).toISOString();

    const snapshot = {
      project_id: mattProjectId,
      device_id: mattDeviceId,
      device_name: "plain-feather",
      source,
      captured_at: capturedAt,
      observation_key: capturedAt,
      ingest_complete: false,
      owner_checked_at: asTimestamp(status.last_checked_at),
      status_endpoint_ok: statusResponse.ok,
      history_endpoint_ok: includeHistory ? historyResponse.ok : null,
      status_http_status: statusResponse.status,
      status_elapsed_ms: statusResponse.elapsedMs,
      history_samples: includeHistory ? historyRecords.length : null,
      overall_status: asString(status.overall_status),
      api_status: asString(status.api_status),
      pi_online: asBoolean(status.pi_online),
      public_url_reachable: asBoolean(status.public_url_reachable),
      ethernet_link: asBoolean(status.ethernet_link),
      ethernet_ip: asString(status.ethernet_ip),
      gateway_ping_ms: asNumber(status.gateway_ping_ms),
      undervoltage: asBoolean(status.undervoltage),
      cpu_temp_c: asNumber(status.cpu_temp_c),
      uptime_seconds: uptimeSecondsFromSources(status, health),
      sensors_expected: adjustedHealthCount(
        asInteger(status.sensors_expected),
        ignoredSensorCount,
      ),
      sensors_current: asInteger(status.sensors_current),
      sensors_stale: adjustedHealthCount(
        asInteger(status.sensors_stale),
        ignoredStaleCount,
      ),
      sensors_missing: adjustedHealthCount(
        asInteger(status.sensors_missing),
        ignoredMissingCount,
      ),
      missing_sensors: missingSensors,
      stale_sensors: staleSensors,
      last_sensor_reading_at: asTimestamp(status.last_sensor_reading_at),
      watering_last_event: asString(status.watering_last_event),
      watering_last_event_at: asTimestamp(status.watering_last_event_at),
      watering_events_last_24h: asInteger(status.watering_events_last_24h),
      scheduler_jobs_loaded: asInteger(status.scheduler_jobs_loaded),
      active_alerts: asArray(status.active_alerts).filter((issue) =>
        !isIgnoredDiagnosticIssue(issue)
      ),
      known_issues: asArray(status.known_issues).filter((issue) =>
        !isIgnoredDiagnosticIssue(issue)
      ),
      raw_status: {},
      raw_health: {},
      raw_history: {},
    };

    const insertResult = await admin
      .from("device_health_snapshots")
      .insert(snapshot)
      .select(
        "id, captured_at, overall_status, sensors_current, sensors_stale, sensors_missing",
      )
      .single();
    let data = insertResult.data;
    let error = insertResult.error;
    let snapshotInserted = !insertResult.error;

    if (insertResult.error?.code === "23505") {
      const existingResult = await admin
        .from("device_health_snapshots")
        .select("id")
        .eq("project_id", mattProjectId)
        .eq("device_id", mattDeviceId)
        .eq("observation_key", snapshot.observation_key)
        .single();
      if (existingResult.error || !existingResult.data?.id) {
        data = null;
        error = existingResult.error ?? insertResult.error;
      } else {
        const retryUpdate = await admin
          .from("device_health_snapshots")
          .update(snapshot)
          .eq("id", existingResult.data.id)
          .select(
            "id, captured_at, overall_status, sensors_current, sensors_stale, sensors_missing",
          )
          .single();
        data = retryUpdate.data;
        error = retryUpdate.error;
        snapshotInserted = false;
      }
    }

    if (error) {
      return jsonResponse(
        { error: "Could not write health snapshot" },
        500,
        origin,
      );
    }

    const valveEventWrite = await insertMissingValveEvents(admin, valveEvents);
    if (valveEventWrite.error) {
      console.error("Could not write valve events", valveEventWrite.error);
    }
    const liveReadingMirror = await mirrorLiveReadings(admin, health, nowIso);
    if (liveReadingMirror.error) {
      console.error(
        "Could not mirror live sensor readings",
        liveReadingMirror.error,
      );
    }

    const runtimeRow: DeviceRuntimeStateWrite = {
      project_id: mattProjectId,
      device_id: mattDeviceId,
      device_name: "plain-feather",
      source,
      controller_state: controllerState.normalized,
      controller_state_raw: controllerState.raw,
      controller_state_updated_at: stateUpdatedAtFromSources(
        runtimeSources,
        snapshot.captured_at,
      ),
      state_observed_at: snapshot.captured_at,
      state_fresh_until: stateFreshUntil,
      owner_checked_at: snapshot.owner_checked_at,
      overall_status: snapshot.overall_status,
      api_status: snapshot.api_status,
      pi_online: snapshot.pi_online,
      public_url_reachable: snapshot.public_url_reachable,
      watering_enabled: wateringEnabled,
      watering_disabled: wateringDisabled,
      watering_last_event: snapshot.watering_last_event,
      watering_last_event_at: snapshot.watering_last_event_at,
      watering_events_last_24h: snapshot.watering_events_last_24h,
      scheduler_jobs_loaded: snapshot.scheduler_jobs_loaded,
      sensors_expected: snapshot.sensors_expected,
      sensors_current: snapshot.sensors_current,
      sensors_stale: snapshot.sensors_stale,
      sensors_missing: snapshot.sensors_missing,
      last_sensor_reading_at: snapshot.last_sensor_reading_at,
      config_hash: configHash,
      raw_status: statusResponse.data,
      raw_health: healthResponse.data,
      raw_system: system,
      updated_at: nowIso,
    };
    const runtimeWrite = await upsertDeviceRuntimeState(admin, runtimeRow);
    if (!runtimeWrite.ok) {
      console.error("Could not write runtime state", runtimeWrite.error);
    }

    const endpointStatus = {
      system: {
        ok: systemResponse.ok,
        status: systemResponse.status,
        elapsedMs: systemResponse.elapsedMs,
        error: systemResponse.error,
      },
      systemConfig: {
        ok: systemConfigResponse.ok,
        status: systemConfigResponse.status,
        elapsedMs: systemConfigResponse.elapsedMs,
        error: systemConfigResponse.error,
      },
      config: {
        ok: configResponse.ok,
        status: configResponse.status,
        elapsedMs: configResponse.elapsedMs,
        error: configResponse.error,
      },
      pairings: {
        ok: pairingsResponse.ok,
        status: pairingsResponse.status,
        elapsedMs: pairingsResponse.elapsedMs,
        error: pairingsResponse.error,
      },
    };

    const configWrite = shouldWriteConfig && nextConfigHash
      ? await upsertDeviceConfigState(admin, {
        project_id: mattProjectId,
        device_id: mattDeviceId,
        device_name: "plain-feather",
        source,
        observed_at: nowIso,
        pairings,
        calibrations,
        board_config: boardConfig,
        sensors,
        valves,
        groups,
        pairing_count: pairings.length,
        calibration_count: calibrations.length,
        board_count: boardConfig.length,
        sensor_count: sensors.length,
        valve_count: valves.length,
        group_count: groups.length,
        config_hash: nextConfigHash,
        endpoint_status: endpointStatus,
        raw_config: {
          system,
          systemConfig,
          config,
          pairings: pairingsConfig,
        },
        updated_at: nowIso,
      })
      : {
        ok: false,
        error: includeConfig
          ? "Config endpoints did not return a complete mirror; previous config was preserved"
          : "Config refresh was not due",
        code: null,
        details: null,
        row: null,
      };
    if (!configWrite.ok && includeConfig) {
      console.error("Could not write config state", configWrite.error);
    }

    const previousConfigUsable =
      normalizeConfigSection(lastConfigState?.pairings, "pairings").length >
        0 &&
      normalizeConfigSection(lastConfigState?.board_config, "board_config")
          .length > 0 &&
      normalizeConfigSection(lastConfigState?.sensors, "sensors").length > 0 &&
      normalizeConfigSection(lastConfigState?.valves, "valves").length > 0;

    let configCheckpointError: string | null = null;
    if (includeConfig) {
      const { error: checkpointError } = await admin
        .from("device_maintenance_state")
        .upsert({
          task_name: "owner_health_config_refresh_attempt",
          last_started_at: nowIso,
          last_completed_at: nowIso,
          details: {
            source,
            required: configRefreshRequired,
            config_write_ok: configWrite.ok,
            previous_config_preserved: !configWrite.ok && previousConfigUsable,
            endpoints: endpointStatus,
          },
        }, { onConflict: "task_name" });
      if (checkpointError) {
        configCheckpointError = checkpointError.message;
        console.error(
          "Could not record config refresh checkpoint",
          checkpointError,
        );
      }
    }

    const configOutcome = configRefreshOutcome({
      includeConfig,
      required: configRefreshRequired,
      writeAttempted: shouldWriteConfig,
      writeOk: configWrite.ok,
      previousConfigUsable,
    });

    const ingestionErrors = [
      !statusObservationFresh ? "stale_status_observation" : null,
      !healthResponse.ok ? "health_endpoint" : null,
      includeHistory && !historyResponse.ok ? "history_endpoint" : null,
      valveEventWrite.error ? "valve_events" : null,
      !runtimeWrite.ok ? "runtime_state" : null,
      configOutcome.error,
    ].filter((value): value is string => value != null);
    const ingestionWarnings = [
      configOutcome.warning,
      configCheckpointError ? "config_refresh_checkpoint" : null,
      liveReadingMirror.error ? "live_reading_mirror" : null,
    ].filter((value): value is string => value != null);

    let historyCheckpointRecorded = false;
    if (includeHistory && historyResponse.ok && !valveEventWrite.error) {
      const { error: historyCheckpointError } = await admin
        .from("device_maintenance_state")
        .upsert({
          task_name: "owner_health_history_recovery",
          last_started_at: nowIso,
          last_completed_at: nowIso,
          details: {
            source,
            history_samples: historyRecords.length,
            valve_events_found: valveEvents.length,
            valve_events_inserted: valveEventWrite.inserted,
          },
        }, { onConflict: "task_name" });
      if (historyCheckpointError) {
        console.error(
          "Could not record history recovery checkpoint",
          historyCheckpointError,
        );
      } else {
        historyCheckpointRecorded = true;
      }
    }

    if (ingestionErrors.length === 0 && data?.id) {
      const { error: completionError } = await admin
        .from("device_health_snapshots")
        .update({ ingest_complete: true })
        .eq("id", data.id);
      if (completionError) {
        console.error(
          "Could not mark health ingestion complete",
          completionError,
        );
        ingestionErrors.push("snapshot_completion");
      }
    }
    const ingestionComplete = ingestionErrors.length === 0;

    return jsonResponse(
      {
        ok: ingestionComplete,
        snapshot: data,
        runtimeState: {
          ok: runtimeWrite.ok,
          controllerState: runtimeRow.controller_state,
          observedAt: runtimeRow.state_observed_at,
          error: runtimeWrite.error,
        },
        configState: {
          ok: configWrite.ok,
          attempted: includeConfig,
          required: configRefreshRequired,
          preserved: includeConfig && !configWrite.ok && previousConfigUsable,
          configHash,
          counts: {
            pairings: pairings.length,
            calibrations: calibrations.length,
            boards: boardConfig.length,
            sensors: sensors.length,
            valves: valves.length,
            groups: groups.length,
          },
          error: configWrite.error,
        },
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
        liveReadings: liveReadingMirror,
        source: {
          authority: source,
          statusEndpointOk: statusResponse.ok,
          statusObservationFresh,
          healthEndpointOk: healthResponse.ok,
          historyEndpointOk: includeHistory ? historyResponse.ok : null,
          systemEndpointOk: systemResponse.ok,
          systemConfigEndpointOk: systemConfigResponse.ok,
          configEndpointOk: configResponse.ok,
          pairingsEndpointOk: pairingsResponse.ok,
          historySamples: includeHistory ? historyRecords.length : null,
          includeConfig,
          includeHistory,
          historyCheckpointRecorded,
          compactSnapshot: true,
          snapshotInserted,
          ingestionComplete,
          ingestionErrors,
          ingestionWarnings,
        },
      },
      ingestionComplete ? 200 : 503,
      origin,
    );
  } finally {
    await releaseLease();
  }
});
