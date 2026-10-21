// LOCAL PREVIEW AND BROWSER TESTS ONLY. Never part of the portal build.
//
// An in-page stand-in for the parts of Supabase and the controller that Settings →
// Autocalibrate and manual watering use: the session table and its RPCs, the command
// queue (timed pulses and reviewed settings batches), the controller's configuration
// and runtime mirrors, sensor readings, pot records, and the manual-hold endpoint. It
// is backed by the seeded 100-pot simulator, so a whole run can be exercised end to
// end with no network and no hardware. Every request that is not served here fails.

import { buildWorld, SimulatedBench, type SimWorld } from "../src/autocal/simulator";
import type { SettingsPlan } from "../src/settingsSpec";
import { pairingsFromDeviceConfigState } from "../src/portalData";
import type { PairingRow } from "../src/types";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null; count?: number | null };

export type FakePreset = "clean" | "issues";

type ConfigPairing = {
  id: number; name: string; sensorId: number; valveId: number; groupId: number;
  WTCPercentLimit: number; ValveOpenTime: number; MeasurementInterval: number;
  Sensor: { boardSerialId: string; address: string }; Valve: { relayAddress: string; address: string };
  Calibration: { name: string };
};

const project = "harness-project";
const device = "harness-device";
const uuid = () => crypto.randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();

export const harnessIds = { project, device };

function valveKeyOf(index: number) {
  return { relayAddress: String(32 + Math.floor(index / 48)), address: String((index % 48) + 1) };
}

/** Hidden truth for the preview: a cross-zone swap, a swap and a 3-cycle inside zones, one disconnected hose. */
export function previewLayout(count = 100) {
  const targets = Array.from({ length: count }, (_, index) => index);
  const swap = (a: number, b: number) => { [targets[a], targets[b]] = [targets[b], targets[a]]; };
  swap(2, 96);
  swap(30, 31);
  [targets[54], targets[55], targets[56]] = [targets[55], targets[56], targets[54]];
  return targets;
}

function compare(a: unknown, b: unknown) {
  const na = Number(a), nb = Number(b);
  if (typeof a === "number" || (typeof a === "string" && /^-?\d+(\.\d+)?$/.test(a) && Number.isFinite(nb))) return na - nb;
  const da = Date.parse(String(a)), db = Date.parse(String(b));
  if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
  return String(a).localeCompare(String(b));
}

/** PostgREST `or` filters, as the portal writes them. */
function parseOr(expression: string): (row: Row) => boolean {
  const split = (text: string) => {
    const parts: string[] = [];
    let depth = 0, start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      if (text[index] === ")") depth -= 1;
      if (text[index] === "," && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
    }
    parts.push(text.slice(start));
    return parts;
  };
  const term = (text: string): ((row: Row) => boolean) => {
    if (text.startsWith("and(")) {
      const inner = split(text.slice(4, -1)).map(term);
      return (row) => inner.every((test) => test(row));
    }
    const first = text.indexOf(".");
    const second = text.indexOf(".", first + 1);
    const column = text.slice(0, first), op = text.slice(first + 1, second), value = text.slice(second + 1);
    return (row) => {
      const cell = row[column];
      if (op === "is") return value === "null" ? cell == null : String(cell) === value;
      if (cell == null) return false;
      const c = compare(cell, value);
      return op === "eq" ? c === 0 : op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : op === "lte" ? c <= 0 : false;
    };
  };
  const terms = split(expression).map(term);
  return (row) => terms.some((test) => test(row));
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" = "select";
  private columns = "*";
  private countMode: string | null = null;
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private payload: unknown = null;
  private lower: { column: string; value: string } | null = null;

  constructor(private readonly backend: FakeBackend, private readonly table: string) {}

  select(columns = "*", options?: { count?: string }) { this.columns = columns; this.countMode = options?.count ?? null; return this; }
  insert(rows: unknown) { this.op = "insert"; this.payload = rows; return this; }
  update(patch: unknown) { this.op = "update"; this.payload = patch; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
  in(column: string, values: unknown[]) { const set = new Set(values); this.filters.push((row) => set.has(row[column])); return this; }
  like(column: string, pattern: string) { const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`); this.filters.push((row) => regex.test(String(row[column] ?? ""))); return this; }
  gte(column: string, value: unknown) { this.lower = { column, value: String(value) }; this.filters.push((row) => row[column] != null && compare(row[column], value) >= 0); return this; }
  gt(column: string, value: unknown) { this.filters.push((row) => row[column] != null && compare(row[column], value) > 0); return this; }
  is(column: string, value: null) { this.filters.push((row) => (value === null ? row[column] == null : row[column] === value)); return this; }
  or(expression: string) { this.filters.push(parseOr(expression)); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.orders.push({ column, ascending: options?.ascending !== false }); return this; }
  limit(count: number) { this.limitCount = count; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  abortSignal() { return this; }

  then<A = Result, B = never>(resolve?: ((value: Result) => A | PromiseLike<A>) | null, reject?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(resolve, reject);
  }

  private project(rows: Row[]) {
    if (this.columns === "*" || !this.columns) return rows.map((row) => ({ ...row }));
    const names = this.columns.split(",").map((name) => name.trim()).filter(Boolean);
    return rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name] ?? null])));
  }

  private shape(rows: Row[]): Result {
    const projected = this.project(rows);
    if (this.mode === "single") return projected.length === 1 ? { data: projected[0], error: null } : { data: null, error: { message: `JSON object requested, ${projected.length} rows returned` } };
    if (this.mode === "maybe") return projected.length > 1 ? { data: null, error: { message: "multiple rows returned" } } : { data: projected[0] ?? null, error: null };
    return { data: projected, error: null };
  }

  private run(): Result {
    this.backend.advance();
    if (this.table === "sensor_readings") return this.shape(this.backend.readingsQuery(this.filters, this.orders, this.limitCount, this.lower));
    if (this.op === "insert") {
      const inserted = this.backend.insert(this.table, this.payload as Row);
      return "error" in inserted ? { data: null, error: { message: inserted.error } } : this.shape([inserted.row]);
    }
    let rows = this.backend.rows(this.table).filter((row) => this.filters.every((test) => test(row)));
    if (this.op === "update") {
      const updated = this.backend.update(this.table, rows, this.payload as Row);
      if ("error" in updated) return { data: null, error: { message: updated.error } };
      rows = updated.rows;
    }
    for (const order of [...this.orders].reverse()) rows = rows.slice().sort((a, b) => (order.ascending ? 1 : -1) * compare(a[order.column], b[order.column]));
    const count = rows.length;
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    const result = this.shape(rows);
    return this.countMode ? { ...result, count } : result;
  }
}

type Command = Row & { id: string; status: string; command_type: string; payload: Row; executeAtMs: number; batch_id: string | null; depends_on: string | null };

export class FakeBackend {
  readonly world: SimWorld;
  readonly bench: SimulatedBench;
  private readonly tables = new Map<string, Row[]>();
  private config: ConfigPairing[] = [];
  private configHash = uuid();
  private controllerState = "RUNNING";
  private benchStartMs = 0;
  private readonly lastEmit = new Map<number, number>();
  private readonly readings: Row[] = [];
  private readingId = 0;
  private readonly listeners = new Set<() => void>();
  private hold: { sessionId: string; ownerId: string; valveIndex: number; openedAtMs: number; untilMs: number; label: string } | null = null;
  readonly log: string[] = [];
  lastQueueError: string | null = null;

  constructor(readonly options: { preset?: FakePreset; seed?: number; count?: number; hoseTargets?: number[]; silentSensors?: number[] } = {}) {
    const count = options.count ?? 100;
    this.world = buildWorld({ presetId: "clean-100", seed: options.seed ?? 11, potCount: count, hoseTargets: options.hoseTargets ?? previewLayout(count) });
    if (options.preset !== "issues") this.world.valves[79].fault = "disconnected_hose";
    this.bench = new SimulatedBench(this.world);
    for (const index of options.silentSensors ?? (options.preset === "issues" ? [46] : [])) this.world.sensors[index].fault = "dead";
    this.config = this.world.pots.map((_, index) => {
      const zone = Math.floor(index / 25) + 1;
      const valve = valveKeyOf(index);
      return {
        id: index + 1, name: `Zone${zone}-Pot${index + 1}`, sensorId: 1000 + index, valveId: 2000 + index, groupId: 1 + (index % 3),
        WTCPercentLimit: 22 + (index % 4), ValveOpenTime: 3000 + 500 * (index % 3), MeasurementInterval: 600_000,
        Sensor: { boardSerialId: `SDI${String(Math.floor(index / 10)).padStart(2, "0")}`, address: String(index % 10) },
        Valve: valve, Calibration: { name: "Teros 12" },
      };
    });
    if (options.preset === "issues") {
      // Two pairings configured on the same valve: neither can be attributed.
      this.config[98].Valve = { ...this.config[97].Valve };
    }
    this.tables.set("commissioning_sessions", []);
    this.tables.set("project_control_commands", []);
    this.tables.set("manual_hold_sessions", []);
    this.tables.set("portal_bench_layout_versions", []);
    this.tables.set("research_pots", this.world.pots.map((_, index) => ({ id: `pot-${index + 1}`, project_id: project, pot_number: index + 1, label: `Pot ${index + 1}`, position_id: null, active: true })));
    this.tables.set("physical_positions", []);
    this.tables.set("hardware_bindings", this.config.map((pairing, index) => ({
      id: uuid(), project_id: project, device_id: device, pot_id: `pot-${index + 1}`, pairing_id: pairing.id, pairing_name: pairing.name,
      sensor_key: `${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}`, valve_key: `${pairing.Valve.relayAddress}:${pairing.Valve.address}`,
      physical_status: "software_only", effective_at: iso(Date.now() - 30 * 86_400_000), retired_at: null, metadata: {},
    })));
    // Three hours of history before the page opened.
    this.benchStartMs = Date.now() - 3 * 3600_000;
    this.advance();
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.listeners.forEach((listener) => listener()); }

  get hash() { return this.configHash; }
  get state() { return this.controllerState; }

  portalPairings(): PairingRow[] {
    return pairingsFromDeviceConfigState(this.config, [{ id: 1, name: "Group A" }, { id: 2, name: "Group B" }, { id: 3, name: "Group C" }]);
  }

  /** A table's rows as stored (no time advance; callers advance first). */
  rows(table: string): Row[] {
    if (table === "device_runtime_state") {
      const now = Date.now();
      return [{ project_id: project, device_id: device, controller_state: this.controllerState, state_observed_at: iso(now - 10_000), state_fresh_until: iso(now + 5 * 60_000), watering_enabled: true, updated_at: iso(now) }];
    }
    if (table === "device_config_state") {
      return [{ project_id: project, device_id: device, pairings: JSON.parse(JSON.stringify(this.config)), groups: [{ id: 1, name: "Group A" }, { id: 2, name: "Group B" }, { id: 3, name: "Group C" }], config_hash: this.configHash, observed_at: iso(Date.now()), updated_at: iso(Date.now()) }];
    }
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`The preview backend does not serve ${table}.`);
    return rows;
  }

  // ------------------------------------------------------------------ time and sensors

  private benchNowMs() { return this.benchStartMs + this.bench.elapsedSeconds * 1000; }

  /** Brings the simulated bench up to the page's clock: readings, queued commands, hold lease. */
  advance() {
    const target = Date.now();
    let moved = false;
    while (this.benchNowMs() + 5000 <= target) {
      const values = this.bench.sample(5);
      const at = this.benchNowMs();
      // A stopped controller does not measure.
      if (this.controllerState === "RUNNING") {
        values.forEach((value, index) => {
          if (value == null) return;
          const pairing = this.config.find((item) => item.sensorId === 1000 + index);
          const interval = pairing?.MeasurementInterval ?? 600_000;
          const last = this.lastEmit.get(index) ?? -Infinity;
          if (at - last < interval) return;
          this.lastEmit.set(index, at);
          if (!pairing) return;
          this.readings.push({
            id: ++this.readingId, project_id: project, device_id: device, event_id: `live-device:${this.readingId}`,
            sensor_key: `${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}`, calibrated_value: value,
            device_recorded_at: iso(at), server_received_at: iso(at),
          });
        });
      }
      this.runCommands(at);
      if (this.hold && at > this.hold.untilMs) this.closeHold("expired", at);
      moved = true;
    }
    if (moved) this.changed();
  }

  readingsQuery(filters: Array<(row: Row) => boolean>, orders: Array<{ column: string; ascending: boolean }>, limit: number | null, lower: { column: string; value: string } | null) {
    // Rows are kept in recording order (received at the same instant); start at the lower
    // time bound by binary search, filter in that order and stop at the limit.
    const ordered = orders[0]?.column === "server_received_at" || orders[0]?.column === "device_recorded_at";
    let start = 0;
    if (lower && (lower.column === "device_recorded_at" || lower.column === "server_received_at")) {
      const bound = Date.parse(lower.value);
      let high = this.readings.length;
      while (start < high) {
        const middle = (start + high) >> 1;
        if (Date.parse(String(this.readings[middle][lower.column])) < bound) start = middle + 1; else high = middle;
      }
    }
    const out: Row[] = [];
    for (let index = start; index < this.readings.length; index += 1) {
      const row = this.readings[index];
      if (!filters.every((test) => test(row))) continue;
      out.push(row);
      if (ordered && limit != null && out.length >= limit) break;
    }
    return out;
  }

  // ------------------------------------------------------------------ tables

  insert(table: string, row: Row): { row: Row } | { error: string } {
    const rows = this.rows(table);
    if (table === "commissioning_sessions") {
      if (rows.some((other) => other.active && other.project_id === row.project_id && other.device_id === row.device_id)) {
        return { error: 'duplicate key value violates unique constraint "commissioning_sessions_one_active"' };
      }
      const now = iso(Date.now());
      const full = { id: uuid(), created_by: "harness-user", active: true, status: "preparing", heartbeat_at: null, run_token: null, stop_requested_at: null, stop_requested_by: null, run_result: null, record: {}, started_at: now, updated_at: now, ended_at: null, ...row };
      rows.push(full);
      this.log.push(`session ${String(row.run_id)} opened`);
      return { row: full };
    }
    rows.push(row);
    return { row };
  }

  update(table: string, targets: Row[], patch: Row): { rows: Row[] } | { error: string } {
    const now = iso(Date.now());
    for (const row of targets) {
      if (table === "commissioning_sessions") {
        if (!row.active && patch.active === true) return { error: "A finished commissioning session cannot become active again" };
        const next = { ...patch };
        if ("heartbeat_at" in next && next.heartbeat_at != null) next.heartbeat_at = now;
        if ("stop_requested_at" in next) {
          next.stop_requested_by = next.stop_requested_at == null ? null : "harness-user";
          if (next.stop_requested_at != null) next.stop_requested_at = now;
        }
        Object.assign(row, next, { updated_at: now });
        if (!row.active && row.ended_at == null) row.ended_at = now;
      } else Object.assign(row, patch);
    }
    this.changed();
    return { rows: targets };
  }

  rpc(name: string, args: Row): Result {
    this.advance();
    const sessions = this.rows("commissioning_sessions");
    const find = (runId: unknown) => sessions.find((row) => row.run_id === runId && row.project_id === project);
    if (name === "claim_commissioning_run") {
      const row = find(args.claim_run_id);
      if (!row) return { data: null, error: { message: "Autocalibration session not found" } };
      if (!row.active) return { data: null, error: { message: "This autocalibration session has ended" } };
      const fresh = row.heartbeat_at && Date.now() - Date.parse(String(row.heartbeat_at)) < 180_000;
      if (row.status === "running" && row.run_token !== args.claim_token && fresh) return { data: null, error: { message: "Another screen is running this autocalibration session" } };
      Object.assign(row, { status: "running", run_token: args.claim_token, heartbeat_at: iso(Date.now()), stop_requested_at: null, stop_requested_by: null, updated_at: iso(Date.now()) });
      this.changed();
      return { data: { ...row }, error: null };
    }
    if (name === "renew_commissioning_run") {
      const row = find(args.renew_run_id);
      if (!row || row.run_token !== args.renew_token || !row.active || row.status !== "running") return { data: null, error: { message: "This screen no longer holds the autocalibration run" } };
      row.heartbeat_at = iso(Date.now());
      return { data: { stop_requested_at: row.stop_requested_at, stop_requested_by: row.stop_requested_by, heartbeat_at: row.heartbeat_at }, error: null };
    }
    if (name === "reconcile_autocalibration_bindings") {
      const bindings = this.rows("hardware_bindings");
      let reconciled = 0;
      for (const change of (args.changes as Row[]) ?? []) {
        const binding = bindings.find((item) => item.pairing_name === change.pairing_name && item.retired_at == null);
        if (!binding || binding.valve_key === change.valve_key) continue;
        binding.retired_at = iso(Date.now());
        bindings.push({ ...binding, id: uuid(), valve_key: change.valve_key, physical_status: "software_only", effective_at: iso(Date.now()), retired_at: null, metadata: { run_id: args.reconcile_run_id } });
        reconciled += 1;
      }
      return { data: { reconciled, skipped: [], config_hash: this.configHash }, error: null };
    }
    if (name === "confirm_autocalibration_delivery") {
      const bindings = this.rows("hardware_bindings");
      let confirmed = 0;
      for (const pairing of (args.pairing_names as string[]) ?? []) {
        const binding = bindings.find((item) => item.pairing_name === pairing && item.retired_at == null);
        if (!binding || binding.physical_status !== "software_only") continue;
        binding.retired_at = iso(Date.now());
        bindings.push({ ...binding, id: uuid(), physical_status: "researcher_confirmed", effective_at: iso(Date.now()), retired_at: null });
        confirmed += 1;
      }
      return { data: { confirmed, skipped: [] }, error: null };
    }
    return { data: null, error: { message: `The preview backend does not serve rpc ${name}` } };
  }

  // ------------------------------------------------------------------ commands

  /** create-control-command: one bounded timed pulse for one pairing, or the empty-payload probe. */
  invokeCommand(body: Row): { data: unknown; error: unknown } {
    this.advance();
    if (body.command_type !== "manual_water") return { data: null, error: new Error("The preview serves only timed pulses here") };
    const payload = (body.payload ?? {}) as Row;
    const names = payload.pairing_names as string[] | undefined;
    if (!names?.length) {
      const error = Object.assign(new Error("Invalid manual_water payload"), { context: new Response(JSON.stringify({ error: "Invalid manual_water payload" }), { status: 400 }) });
      return { data: null, error };
    }
    const id = uuid();
    const command: Command = {
      id, project_id: project, device_id: device, client_request_id: body.client_request_id, command_type: "manual_water", payload, status: "queued",
      error: null, result: null, requested_at: iso(Date.now()), expires_at: iso(Date.now() + 10 * 60_000), completed_at: null, executeAtMs: Date.now() + 5000, batch_id: null, depends_on: null,
    };
    this.rows("project_control_commands").push(command);
    return { data: { operation_id: uuid(), command: { id } }, error: null };
  }

  /** The reviewed settings path: stop, change(s), restore the state; config hash precondition. */
  queueSettingsPlan(plan: SettingsPlan, configHash: string) {
    this.advance();
    if (configHash !== this.configHash) {
      this.lastQueueError = "Controller configuration changed before the settings batch was queued";
      return null;
    }
    const batchId = uuid();
    const restoreTo = this.controllerState === "STOPPED" ? "stopped" : "running";
    const steps = [
      { command_type: "update_system_state", payload: { state: "stopped" } },
      ...plan.commands.map((command) => ({ command_type: command.command_type, payload: command.payload as Row })),
      { command_type: "update_system_state", payload: { state: restoreTo } },
    ];
    let previous: string | null = null;
    const ids: string[] = [];
    steps.forEach((step, index) => {
      const id = uuid();
      this.rows("project_control_commands").push({
        id, project_id: project, device_id: device, client_request_id: uuid(), command_type: step.command_type, payload: step.payload, status: "queued", error: null, result: null,
        requested_at: iso(Date.now()), expires_at: iso(Date.now() + 10 * 60_000), completed_at: null, executeAtMs: Date.now() + 3000 * (index + 1), batch_id: batchId, depends_on: previous,
      } satisfies Command);
      previous = id;
      ids.push(id);
    });
    this.log.push(`batch ${plan.summary}`);
    return { batchId, commandIds: ids };
  }

  private runCommands(atMs: number) {
    const commands = this.rows("project_control_commands") as Command[];
    for (const command of commands) {
      if (command.status !== "queued" || atMs < command.executeAtMs) continue;
      if (command.depends_on) {
        const before = commands.find((item) => item.id === command.depends_on);
        if (before && before.status !== "succeeded") {
          if (["failed", "canceled", "expired"].includes(before.status)) Object.assign(command, { status: "canceled", error: "An earlier step of the batch did not succeed", completed_at: iso(atMs) });
          continue;
        }
      }
      try {
        command.result = this.execute(command);
        command.status = "succeeded";
      } catch (error) {
        command.status = "failed";
        command.error = error instanceof Error ? error.message : String(error);
      }
      command.completed_at = iso(atMs);
    }
  }

  private execute(command: Command): Row {
    const payload = command.payload;
    const byName = new Map(this.config.map((pairing) => [pairing.name, pairing]));
    const changed = () => { this.configHash = uuid(); };
    switch (command.command_type) {
      case "manual_water": {
        if (this.hold) throw new Error("timed pulse refused: manual troubleshooting in progress");
        const pairing = byName.get((payload.pairing_names as string[])[0]);
        if (!pairing) throw new Error("Unknown pairing");
        const valveIndex = (Number(pairing.Valve.relayAddress) - 32) * 48 + Number(pairing.Valve.address) - 1;
        this.bench.pulse(valveIndex, Number(payload.duration_seconds));
        return { action: "manual_water", failSafe: "controller_timed_pulse", durationSeconds: payload.duration_seconds };
      }
      case "update_system_state":
        this.controllerState = payload.state === "stopped" ? "STOPPED" : "RUNNING";
        return { state: this.controllerState };
      case "bulk_update_pairings": {
        for (const name of payload.pairing_names as string[]) {
          const pairing = byName.get(name);
          if (!pairing) throw new Error(`Unknown pairing ${name}`);
          if (payload.disable_watering) pairing.WTCPercentLimit = -999999;
          if (payload.measurement_interval_seconds) pairing.MeasurementInterval = Number(payload.measurement_interval_seconds) * 1000;
        }
        changed();
        return { updated: (payload.pairing_names as string[]).length };
      }
      case "remap_pairing_valves": {
        const changes = payload.changes as Array<Row>;
        // One transaction: every change is checked before any is applied.
        for (const change of changes) {
          const pairing = byName.get(String(change.pairing_name));
          if (!pairing || `${pairing.Valve.relayAddress}:${pairing.Valve.address}` !== change.from_valve_key) throw new Error(`${String(change.pairing_name)} is not on ${String(change.from_valve_key)}`);
        }
        for (const change of changes) {
          const [relayAddress, address] = String(change.to_valve_key).split(":");
          byName.get(String(change.pairing_name))!.Valve = { relayAddress, address };
        }
        changed();
        return { remapped: changes.length };
      }
      case "restore_pairing_settings": {
        for (const entry of payload.pairings as Array<Row>) {
          const pairing = byName.get(String(entry.pairing_name));
          if (!pairing) throw new Error(`Unknown pairing ${String(entry.pairing_name)}`);
          pairing.WTCPercentLimit = entry.target_vwc == null ? -999999 : Number(entry.target_vwc);
          pairing.ValveOpenTime = Number(entry.valve_open_time_ms);
          pairing.MeasurementInterval = Number(entry.measurement_interval_ms);
        }
        changed();
        return { restored: (payload.pairings as Row[]).length };
      }
      default:
        throw new Error(`The preview does not apply ${command.command_type}`);
    }
  }

  // ------------------------------------------------------------------ manual hold

  private closeHold(endReason: string, atMs: number) {
    if (!this.hold) return;
    const hold = this.hold;
    this.hold = null;
    // The water a hold delivered, for the simulator.
    this.bench.pulse(hold.valveIndex, Math.min(60, Math.max(0, (atMs - hold.openedAtMs) / 1000)));
    const row = this.rows("manual_hold_sessions").find((item) => item.id === hold.sessionId);
    if (row) Object.assign(row, { status: "closed", end_reason: endReason, ended_at: iso(atMs), updated_at: iso(atMs) });
  }

  manualHold(body: Row): { status: number; body: Row } {
    this.advance();
    const outputs = this.world.valves.map((_, index) => {
      const key = valveKeyOf(index);
      const pairing = this.config.find((item) => item.Valve.relayAddress === key.relayAddress && item.Valve.address === key.address) ?? null;
      const potNumber = pairing ? Number(/Pot(\d+)/.exec(pairing.name)?.[1]) : null;
      return {
        key: `${key.relayAddress}:${key.address}`, relayAddress: Number(key.relayAddress), channel: Number(key.address), solenoidNumber: index + 1,
        labelStatus: "needs_confirmation", labelSource: "printed", pots: potNumber ? [potNumber] : [], candidatePots: [],
        pairing: pairing ? { name: pairing.name, sensorKey: `${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}`, namedPot: potNumber } : null,
      };
    });
    const action = String(body.action);
    if (action === "inventory" || action === "routes") {
      const pots = outputs.filter((output) => output.pots.length).map((output) => ({
        pot: output.pots[0], status: "ready", relayAddress: output.relayAddress, channel: output.channel, pairing: output.pairing, source: "field_record_2026-06-15",
      }));
      return { status: 200, body: { pots, outputs, boards: [32, 33, 34], canConfirm: true, canTakeover: true, leaseMs: 2500, renewMs: 500 } };
    }
    const destination = body.destination as Row | undefined;
    const output = destination?.kind === "solenoid"
      ? outputs.find((item) => item.relayAddress === destination.relayAddress && item.channel === destination.channel)
      : outputs.find((item) => item.pots.includes(Number(destination?.potNumber ?? body.potNumber)));
    const now = Date.now();
    const openedFor = this.hold ? now - this.hold.openedAtMs : 0;
    if (action === "status") return { status: 200, body: { status: this.hold ? "open" : "closed", available: true, ready: true, busy: Boolean(this.hold && this.hold.sessionId !== body.sessionId), activeOwnerLabel: this.hold ? "you (another tab or device)" : null, maxContinuousMilliseconds: null } };
    if (action === "stop") {
      if (this.hold && this.hold.sessionId === body.sessionId) this.closeHold("released", now);
      return { status: 200, body: { status: "closed", endReason: "released" } };
    }
    if (!output) return { status: 409, body: { error: "That destination has no configured output" } };
    if (action === "start" || action === "takeover") {
      if (this.hold && this.hold.sessionId !== body.sessionId) {
        if (action !== "takeover") return { status: 200, body: { status: "closed", busy: true, activeOwnerLabel: "another operator" } };
        this.closeHold("preempted", now);
      }
      const index = this.world.valves.findIndex((_, valve) => { const key = valveKeyOf(valve); return Number(key.relayAddress) === output.relayAddress && Number(key.address) === output.channel; });
      this.hold = { sessionId: String(body.sessionId), ownerId: "harness-user", valveIndex: index, openedAtMs: now, untilMs: now + 2500, label: `Solenoid ${output.solenoidNumber}` };
      this.rows("manual_hold_sessions").push({ id: String(body.sessionId), project_id: project, device_id: device, owner_id: "harness-user", destination_kind: destination?.kind ?? "pot", pot_number: output.pots[0] ?? null, solenoid_number: output.solenoidNumber, relay_address: output.relayAddress, channel: output.channel, status: "open", started_at: iso(now), ended_at: null });
      this.changed();
      return { status: 200, body: { status: "open", openedForMs: 0, automaticSuspended: true, maxContinuousMilliseconds: null } };
    }
    if (action === "renew") {
      if (!this.hold || this.hold.sessionId !== body.sessionId) return { status: 200, body: { status: "closed", endReason: "expired" } };
      this.hold.untilMs = now + 2500;
      return { status: 200, body: { status: "open", openedForMs: openedFor } };
    }
    return { status: 400, body: { error: "Invalid request" } };
  }

  // ------------------------------------------------------------------ wiring

  /** Replaces the Supabase client's methods and the page's fetch; nothing reaches a network. */
  install(supabase: object) {
    const client = supabase as Record<string, unknown> & { auth: Record<string, unknown> };
    client.from = (table: string) => new Query(this, table);
    client.rpc = (name: string, args: Row) => Promise.resolve(this.rpc(name, args));
    Object.defineProperty(client, "functions", {
      configurable: true,
      value: { invoke: async (name: string, options: { body: Row }) => name === "create-control-command" ? this.invokeCommand(options.body) : { data: null, error: new Error(`The preview does not serve ${name}`) } },
    });
    client.auth.getSession = async () => ({ data: { session: { access_token: "preview-token", user: { id: "harness-user" } } }, error: null });
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/functions/v1/manual-hold")) {
        const { status, body } = this.manualHold(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ ...body, serverTime: Date.now() }), { status, headers: { "Content-Type": "application/json" } });
      }
      if (/supabase\.co|\/rest\/v1|\/functions\/v1/.test(url)) throw new TypeError(`Blocked in the preview: ${url}`);
      return realFetch(input, init);
    };
  }
}
