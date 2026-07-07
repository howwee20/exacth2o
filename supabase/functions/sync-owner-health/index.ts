import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const mattProjectId = "22222222-2222-4222-8222-222222222222";
const mattDeviceId = "3100e37ee3205651fe3dd86dafd4dc0c";
const ownerHealthBaseUrl = `https://${mattDeviceId}.balena-devices.com/owner-health`;

type FetchResult = {
  ok: boolean;
  status: number | null;
  elapsedMs: number | null;
  data: Record<string, unknown>;
  error: string | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
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

function authorized(request: Request) {
  const syncSecret = cleanSecret(Deno.env.get("SYNC_OWNER_HEALTH_SECRET"));
  if (!syncSecret) return false;
  return request.headers.get("x-sync-owner-health-secret") === syncSecret || bearerToken(request) === syncSecret;
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

serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!authorized(request)) {
    return jsonResponse({ error: "Sync secret is required" }, 401);
  }

  const supabaseUrl = cleanSecret(Deno.env.get("SUPABASE_URL"));
  const serviceRoleKey = cleanSecret(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const ownerUser = cleanSecret(Deno.env.get("MATT_OWNER_HEALTH_USER"));
  const ownerPassword = cleanSecret(Deno.env.get("MATT_OWNER_HEALTH_PASSWORD"));

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is missing Supabase configuration" }, 500);
  }

  if (!ownerUser || !ownerPassword) {
    return jsonResponse({ error: "Server is missing owner-health credentials" }, 500);
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
  const nowIso = new Date().toISOString();

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

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
    sensors_expected: asInteger(status.sensors_expected),
    sensors_current: asInteger(status.sensors_current),
    sensors_stale: asInteger(status.sensors_stale),
    sensors_missing: asInteger(status.sensors_missing),
    missing_sensors: asArray(status.missing_sensors),
    stale_sensors: asArray(status.stale_sensors),
    last_sensor_reading_at: asTimestamp(status.last_sensor_reading_at),
    watering_last_event: asString(status.watering_last_event),
    watering_last_event_at: asTimestamp(status.watering_last_event_at),
    watering_events_last_24h: asInteger(status.watering_events_last_24h),
    scheduler_jobs_loaded: asInteger(status.scheduler_jobs_loaded),
    active_alerts: asArray(status.active_alerts),
    known_issues: asArray(status.known_issues),
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
    return jsonResponse({ error: "Could not write health snapshot" }, 500);
  }

  return jsonResponse({
    ok: true,
    snapshot: data,
    source: {
      statusEndpointOk: statusResponse.ok,
      healthEndpointOk: healthResponse.ok,
      historyEndpointOk: historyResponse.ok,
      historySamples: historyRecords.length,
    },
  });
});
