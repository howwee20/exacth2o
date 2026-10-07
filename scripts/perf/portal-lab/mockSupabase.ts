// Portal lab data layer: the production App runs against these fixtures with
// every request counted. Fictional data; nothing reaches Supabase.
type Row = Record<string, unknown>;
type Call = { at: number; kind: string; name: string };
declare global {
  interface Window { __labCalls: Call[]; __labNow: () => number }
}
window.__labCalls = [];
const record = (kind: string, name: string) => window.__labCalls.push({ at: Date.now(), kind, name });

const projectId = "lab-project";
const deviceId = "lab-device";
const now = Date.now();
const pots = Array.from({ length: 24 }, (_, index) => index + 1);
const cadenceMs = 2 * 60_000;
const pairingName = (pot: number) => `Zone${Math.ceil(pot / 6)}-Pot${pot}`;
const configPairings = pots.map((pot) => ({
  name: pairingName(pot), sensorId: pot, valveId: 100 + pot,
  Sensor: { boardSerialId: "LAB", address: String(pot) },
  Valve: { relayAddress: "0x20", address: String(pot) },
  WTCPercentLimit: pot % 2 ? 32 : 22, ValveOpenTime: 3000, MeasurementInterval: cadenceMs, groupId: pot % 2 ? 1 : 2,
}));
const readings: Row[] = [];
for (const pot of pots) {
  let level = 30 + (pot % 5);
  for (let t = now - 72 * 3600_000, n = 0; t <= now; t += cadenceMs, n += 1) {
    level -= 0.02 + (pot % 3) * 0.01;
    if (level < (pot % 2 ? 32 : 22)) level += 4;
    const at = new Date(t).toISOString();
    readings.push({ id: pot * 1_000_000 + n, event_id: `live-device:lab:${pot}:${n}`, pairing_name: pairingName(pot), sensor_key: `LAB:${pot}`, raw_value: level, calibrated_value: Number(level.toFixed(2)), temperature: null, electrical_conductivity: null, device_recorded_at: at, server_received_at: at, device_id: deviceId });
  }
}
readings.sort((a, b) => String(b.device_recorded_at).localeCompare(String(a.device_recorded_at)));
const stamp = new Date(now).toISOString();
const tables: Record<string, Row[] | Row> = {
  portal_access: [{ project_id: projectId, role: "admin", email: "lab@example.invalid", created_at: stamp, access_scope: "project" }],
  device_config_state: { project_id: projectId, device_id: deviceId, device_name: "Lab controller", pairings: configPairings, groups: [{ id: 1, name: "Control" }, { id: 2, name: "Drought" }], config_hash: "lab", updated_at: stamp, observed_at: stamp },
  latest_device_state: { device_id: deviceId, last_seen_at: stamp, health_status: "ok", latest_payload: {}, updated_at: stamp },
  device_runtime_state: { project_id: projectId, device_id: deviceId, controller_state: "running", state_observed_at: stamp, state_fresh_until: new Date(now + 3600_000).toISOString(), watering_enabled: true, updated_at: stamp },
  device_health_snapshots: [],
  valve_events: [],
  quote_requests: [], support_threads: [], support_messages: [],
  project_control_commands: [],
  portal_experiment_catalog: [{
    id: "lab-experiment", slug: "lab-experiment", name: "Lab experiment", description: "Synthetic 24-pot study", mode: "controlled", status: "active", watering_state: "controller_managed",
    started_at: new Date(now - 4 * 86400_000).toISOString(), ended_at: null, pairing_names: pots.map(pairingName),
    assignments: pots.map((pot) => ({ pairing_name: pairingName(pot), zone: Math.ceil(pot / 6), pot_number: pot, crop: pot % 4 < 2 ? "maize" : "sorghum", treatment: pot % 2 ? "control" : "drought", target_vwc_percent: pot % 2 ? 32 : 22 })),
  }],
};

function query(table: string) {
  const filters: Array<[string, string, unknown]> = [];
  let limit = Infinity;
  let single = false;
  let paged = false;
  const builder: Record<string, unknown> = {};
  const chain = (name: string) => (...args: unknown[]) => {
    if (["eq", "gte", "lt", "like"].includes(name)) filters.push([name, String(args[0]), args[1]]);
    if (name === "limit") limit = Number(args[0]);
    if (name === "or") paged = true;
    if (name === "maybeSingle" || name === "single") single = true;
    return builder;
  };
  for (const name of ["select", "eq", "like", "gte", "lt", "order", "limit", "or", "in", "abortSignal", "maybeSingle", "single", "neq", "is", "not"]) builder[name] = chain(name);
  builder.then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
    record("from", table);
    try {
      const source = tables[table];
      let rows: Row[] = Array.isArray(source) ? source : source ? [source] : [];
      if (table === "sensor_readings") {
        rows = paged ? [] : readings;
        for (const [op, column, value] of filters) {
          if (op === "gte" && column === "server_received_at") rows = rows.filter((row) => String(row[column]) >= String(value));
          if (op === "gte" && column === "device_recorded_at") rows = rows.filter((row) => String(row[column]) >= String(value));
        }
        rows = rows.slice(0, limit === Infinity ? rows.length : limit);
      }
      resolve({ data: single ? rows[0] ?? null : rows, error: null });
    } catch (error) {
      reject(error);
    }
  };
  return builder;
}

const session = { access_token: "lab", refresh_token: "lab", expires_at: Math.floor(now / 1000) + 86_400, user: { id: "lab-user" } };
export const supabase = {
  from: query,
  rpc(name: string) {
    record("rpc", name);
    if (name === "walker_live_observation_status") {
      return Promise.resolve({ data: { project_id: projectId, device_id: deviceId, device_name: "Walker", observation_only: true, portal_control_available: false, expected_sensor_count: 100, evidenced_sensor_count: 96, current_sensor_count: 0, stale_sensor_count: 96, missing_numeric_positions: [], window_hours: 72, freshness: "stale", overall_status: "stale", latest_live_reading_at: "2026-09-16T19:23:00Z", publisher: { status: "degraded", cursor: null, source_latest_known: null, accepted_after: null, last_success_at: null, last_attempt_at: null, last_error: null } }, error: null });
    }
    if (name === "has_gas_mixer_native_access") return Promise.resolve({ data: false, error: null });
    return Promise.resolve({ data: null, error: { code: "42501", message: "observation access required" } });
  },
  functions: {
    invoke(name: string) {
      record("function", name);
      if (name === "website-analytics") return Promise.resolve({ data: { status: "ready", visitors: 12, demoClicks: 1, quoteClicks: 2, inquiries: 1, days: [] }, error: null });
      return Promise.resolve({ data: null, error: { message: "Unavailable in the lab" } });
    },
  },
  auth: {
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    getUser: () => Promise.resolve({ data: { user: session.user }, error: null }),
    refreshSession: () => Promise.resolve({ data: { session }, error: null }),
    signOut: () => Promise.resolve({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  channel(name: string) {
    record("channel", name.replace(/-[0-9a-f-]{20,}$/, ""));
    const channel = {
      on: () => channel,
      subscribe: (callback?: (status: string) => void) => {
        if (callback) setTimeout(() => callback("SUBSCRIBED"), 0);
        return channel;
      },
    };
    return channel;
  },
  removeChannel: () => Promise.resolve("ok"),
};
