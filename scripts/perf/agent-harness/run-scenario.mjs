#!/usr/bin/env node
// Local benchmark for the chamber agents: runs the installed native bridge,
// screen agent and Java lighting bridge against a LOCAL Supabase stack through
// the metering proxy, then drives phases a real deployment sees:
//   idle -> researcher commands -> visible portal panel -> screen session with
//   taps -> failure injection (dropped LISTEN, expired command, locked row).
// Commands are inserted the way the control functions insert them; no
// production project, device or credential is ever used.
//
//   node run-scenario.mjs --label new --out ../../../docs/performance/agent-benchmark-new.json \
//     --db postgresql://postgres:postgres@127.0.0.1:57322/postgres --api http://127.0.0.1:57321 \
//     --env <file with NATIVE_TOKEN, LIGHTING_TOKEN, HARNESS_PASSWORD, ANON_KEY>
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const db = args.db ?? "postgresql://postgres:postgres@127.0.0.1:57322/postgres";
const api = args.api ?? "http://127.0.0.1:57321";
for (const target of [db, api]) {
  const host = new URL(target.replace(/^postgresql:/, "http:")).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("The harness only runs against a local stack");
}
const label = args.label ?? "run";
const work = args.work ?? join(here, ".runs", label);
const proxyPort = Number(args["proxy-port"] ?? 57400);
const minutes = (name, fallback) => Number(args[name] ?? fallback) * 60_000;
const phases = {
  idle: minutes("idle-minutes", 10),
  commands: minutes("command-minutes", 12),
  viewer: minutes("viewer-minutes", 5),
  session: minutes("session-minutes", 3),
  faults: minutes("fault-minutes", 4),
};
const environment = Object.fromEntries(readFileSync(args.env, "utf8").split("\n")
  .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.split("=")[0], line.slice(line.indexOf("=") + 1)]));
const project = "44444444-4444-4444-8444-444444444441";
const mixer = "gas-mixer:b827eb548a44";
const light = "lighting:beagle";

mkdirSync(work, { recursive: true });
const proxyLog = join(work, "proxy.jsonl");
writeFileSync(proxyLog, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (low, high) => low + Math.random() * (high - low);
const sql = (statement) => execFileSync("psql", [db, "-qAtX", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" }).trim();
const marks = [];
const mark = (name) => marks.push({ name, at: Date.now() });

// The DB clock (Docker VM) and this host clock are compared once.
function clockOffsetMs() {
  const before = Date.now();
  const dbNow = Number(sql("select (extract(epoch from clock_timestamp()) * 1000)::bigint"));
  const after = Date.now();
  return dbNow - (before + after) / 2;
}

async function userToken() {
  const response = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: environment.ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "harness-researcher@example.invalid", password: environment.HARNESS_PASSWORD }),
  });
  const body = await response.json();
  if (!body.access_token) throw new Error("Local harness user sign-in failed");
  return body.access_token;
}

function start(command, commandArgs, name, extraEnv = {}) {
  const child = spawn(command, commandArgs, {
    env: { ...process.env, ...environment, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  child.on("exit", () => writeFileSync(join(work, `${name}.out`), Buffer.concat(output)));
  return child;
}

function insertNativeCommand(expiresSql = "now() + interval '15 seconds'") {
  return sql(`insert into public.gas_mixer_native_commands(project_id, device_id, requested_by, command_type,
      payload, expected_revision, idempotency_key, expires_at)
    select project_id, device_id, (select id from auth.users where email = 'harness-researcher@example.invalid'),
      'set_field', jsonb_build_object('field', 'total_slpm', 'value', round((2 + random() * 2)::numeric, 3)),
      state_revision, gen_random_uuid(), ${expiresSql}
    from public.gas_mixer_native_device_state where device_id = '${mixer}'
    returning id || '|' || (extract(epoch from created_at) * 1000)::bigint`).split("|");
}

function insertLightingCommand() {
  return sql(`insert into public.lighting_commands(project_id, device_id, requested_by, intensity, expected_revision, idempotency_key)
    select project_id, device_id, (select id from auth.users where email = 'harness-researcher@example.invalid'),
      (array[0, 50, 120, 200])[1 + floor(random() * 4)::int], state_revision, gen_random_uuid()
    from public.lighting_device_state where device_id = '${light}'
    returning id || '|' || (extract(epoch from created_at) * 1000)::bigint`).split("|");
}

function insertTap(sessionId) {
  return sql(`insert into public.gas_mixer_remote_commands(project_id, device_id, session_id, requested_by, event_type, normalized_x, normalized_y)
    select '${project}', '${mixer}', '${sessionId}', (select id from auth.users where email = 'harness-researcher@example.invalid'),
      'tap', 0.5, 0.5
    returning id || '|' || (extract(epoch from created_at) * 1000)::bigint`).split("|");
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}

function summarize(values) {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: values.length ? Math.round(Math.max(...values)) : null };
}

const statementsSql = `select coalesce(sum(calls), 0)::bigint || '|' || coalesce(round(sum(total_exec_time)::numeric, 1), 0)
  from extensions.pg_stat_statements s join pg_roles r on r.oid = s.userid
  where r.rolname in ('service_role', 'authenticated', 'anon')`;

async function main() {
  sql(`update public.gas_mixer_native_commands set status = 'expired', completed_at = now() where status = 'queued';
       update public.lighting_commands set status = 'expired', completed_at = now() where status in ('queued', 'received', 'validated');
       update public.gas_mixer_remote_commands set status = 'expired', completed_at = now() where status = 'queued';
       update public.gas_mixer_remote_sessions set status = 'ended', ended_at = now() where status in ('issued', 'connected');
       update public.gas_mixer_native_device_state set agent_attention_until = null;
       update public.lighting_device_state set agent_attention_until = null;
       update public.gas_mixer_device_status set agent_attention_until = null;`);
  const offset = clockOffsetMs();
  const lightingProperties = join(work, "lighting.properties");
  writeFileSync(lightingProperties, [
    `endpoint=http://host.docker.internal:${proxyPort}/functions/v1/lighting-native-agent`,
    `device_token=${environment.LIGHTING_TOKEN}`,
    "bridge_ready=true",
    "log_path=/work/lighting-agent.log",
  ].join("\n") + "\n", { mode: 0o600 });

  const total = Object.values(phases).reduce((sum, value) => sum + value, 0) + 30_000;
  const seconds = String(Math.ceil(total / 1000));
  const proxy = start("node", [join(here, "metering-proxy.mjs"), "--listen", String(proxyPort), "--upstream", api, "--log", proxyLog, "--bind", "0.0.0.0"], "proxy");
  await sleep(800);
  const base = `http://127.0.0.1:${proxyPort}/functions/v1`;
  const clients = [
    start("python3", [join(here, "run_native_bridge.py"), "--endpoint", `${base}/gas-mixer-native-agent`, "--token-env", "NATIVE_TOKEN", "--out", join(work, "native-receipts.jsonl"), "--seconds", seconds,
      ...(args["native-bridge"] ? ["--bridge", args["native-bridge"]] : [])], "native"),
    start("python3", [join(here, "run_screen_agent.py"), "--endpoint", `${base}/gas-mixer-agent`, "--token-env", "NATIVE_TOKEN", "--out", join(work, "screen-taps.jsonl"), "--lock", join(work, "agent.lock"), "--seconds", seconds,
      ...(args["screen-agent"] ? ["--agent", args["screen-agent"]] : [])], "screen"),
    start(join(here, "run_lighting_bridge.sh"), [lightingProperties, seconds, work], "lighting"),
  ];
  const statsBefore = sql(statementsSql);
  const commandLog = [];
  const viewerAges = [];
  try {
    // Let every client finish connecting before measuring.
    await sleep(15_000);
    mark("idle");
    await sleep(phases.idle);

    mark("commands");
    const commandsEnd = Date.now() + phases.commands;
    while (Date.now() < commandsEnd) {
      await sleep(randomBetween(8_000, 22_000));
      const [nativeId, nativeCreated] = insertNativeCommand();
      commandLog.push({ kind: "native", id: nativeId, created_at: Number(nativeCreated) - offset });
      await sleep(randomBetween(4_000, 12_000));
      const [lightId, lightCreated] = insertLightingCommand();
      commandLog.push({ kind: "lighting", id: lightId, created_at: Number(lightCreated) - offset });
    }

    mark("viewer");
    const token = await userToken();
    const viewerEnd = Date.now() + phases.viewer;
    while (Date.now() < viewerEnd) {
      for (const [rpc, device] of [["gas_mixer_native_status", mixer], ["lighting_native_status", light]]) {
        const response = await fetch(`${api}/rest/v1/rpc/${rpc}`, {
          method: "POST",
          headers: { apikey: environment.ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ requested_project_id: project, requested_device_id: device }),
        });
        const body = await response.json();
        if (body?.last_bridge_at) viewerAges.push({ rpc, age_ms: Date.now() - Date.parse(body.last_bridge_at) - offset });
      }
      await sleep(5_000);
    }

    mark("session");
    const sessionId = sql(`insert into public.gas_mixer_remote_sessions(project_id, device_id, user_id, mode, status, token_hash, expires_at)
      values ('${project}', '${mixer}', (select id from auth.users where email = 'harness-researcher@example.invalid'), 'view', 'connected',
        encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), now() + interval '4 minutes')
      returning id`);
    const sessionStartedAt = Date.now();
    const sessionEnd = sessionStartedAt + phases.session;
    await sleep(5_000);
    while (Date.now() < sessionEnd - 5_000) {
      const [tapId, tapCreated] = insertTap(sessionId);
      commandLog.push({ kind: "tap", id: tapId, created_at: Number(tapCreated) - offset });
      await sleep(randomBetween(3_000, 7_000));
    }
    sql(`update public.gas_mixer_remote_sessions set status = 'ended', ended_at = now() where id = '${sessionId}'`);

    mark("faults");
    // (1) A command expired on arrival must never be delivered.
    const [expiredId] = insertNativeCommand("now() - interval '1 second'");
    // (2) Drop every LISTEN connection mid-hold; commands still arrive.
    await sleep(10_000);
    sql(`select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name = 'exacth2o-agent-wake'`);
    const [afterDropId, afterDropCreated] = insertNativeCommand();
    commandLog.push({ kind: "native_after_listener_drop", id: afterDropId, created_at: Number(afterDropCreated) - offset });
    await sleep(20_000);
    // (3) A slow database: lock the native state row for 8 s.
    const locker = spawn("psql", [db, "-qAtX", "-c", `begin; select 1 from public.gas_mixer_native_device_state where device_id = '${mixer}' for update; select pg_sleep(8); commit;`]);
    await new Promise((resolve) => locker.on("exit", resolve));
    const [afterLockId, afterLockCreated] = insertNativeCommand();
    commandLog.push({ kind: "native_after_row_lock", id: afterLockId, created_at: Number(afterLockCreated) - offset });
    await sleep(Math.max(0, phases.faults - 40_000));
    commandLog.push({ kind: "native_expired_on_arrival", id: expiredId, created_at: null });
    mark("end");
  } finally {
    await sleep(2_000);
    for (const child of clients) child.kill("SIGTERM");
    sql("select 1");
    await sleep(1_500);
    proxy.kill("SIGTERM");
    execFileSync("sh", ["-c", "docker ps -q --filter ancestor=eclipse-temurin:8-jdk | xargs -r docker kill >/dev/null 2>&1 || true"]);
  }
  const statsAfter = sql(statementsSql);

  const rows = readFileSync(proxyLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const phaseOf = (time) => {
    let current = "warmup";
    for (const entry of marks) if (time >= entry.at) current = entry.name;
    return current;
  };
  const byPhase = {};
  for (const row of rows) {
    const phase = phaseOf(row.started_at);
    const key = `${row.function}:${row.action}`;
    byPhase[phase] ??= {};
    byPhase[phase][key] ??= { calls: 0, errors: 0, durations: [] };
    byPhase[phase][key].calls += 1;
    if (row.status >= 400) byPhase[phase][key].errors += 1;
    byPhase[phase][key].durations.push(row.ended_at - row.started_at);
  }
  const phaseDurations = Object.fromEntries(marks.slice(0, -1).map((entry, index) => [entry.name, marks[index + 1].at - entry.at]));
  const rates = {};
  for (const [phase, entries] of Object.entries(byPhase)) {
    if (!phaseDurations[phase]) continue;
    rates[phase] = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, {
      calls: value.calls,
      errors: value.errors,
      calls_per_hour: Math.round(value.calls / (phaseDurations[phase] / 3_600_000)),
      duration_ms: summarize(value.durations),
    }]));
    const callsPerHour = Object.values(rates[phase]).reduce((sum, value) => sum + value.calls_per_hour, 0);
    rates[phase]._total = { calls_per_hour: callsPerHour, projected_31_days: Math.round(callsPerHour * 24 * 31) };
  }

  const deliveredAt = new Map();
  for (const row of rows) for (const id of row.delivered ?? []) if (!deliveredAt.has(id)) deliveredAt.set(id, row.ended_at);
  const statusRows = sql(`select json_agg(json_build_object('id', id, 'status', status, 'applied_ms', (extract(epoch from applied_at) * 1000)::bigint)) from public.gas_mixer_native_commands where id in (${commandLog.filter((c) => c.kind.startsWith("native")).map((c) => `'${c.id}'`).join(",") || "null"})`);
  const lightingRows = sql(`select json_agg(json_build_object('id', id, 'status', status, 'observed_ms', (extract(epoch from observed_at) * 1000)::bigint)) from public.lighting_commands where id in (${commandLog.filter((c) => c.kind === "lighting").map((c) => `'${c.id}'`).join(",") || "null"})`);
  const nativeStatus = new Map((JSON.parse(statusRows || "null") ?? []).map((row) => [row.id, row]));
  const lightingStatus = new Map((JSON.parse(lightingRows || "null") ?? []).map((row) => [row.id, row]));
  const taps = existsSync(join(work, "screen-taps.jsonl"))
    ? readFileSync(join(work, "screen-taps.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

  const latency = {};
  const outcomes = {};
  for (const command of commandLog) {
    const delivered = deliveredAt.get(command.id);
    outcomes[command.kind] ??= {};
    const status = command.kind === "lighting" ? lightingStatus.get(command.id)?.status
      : command.kind === "tap" ? (delivered ? "delivered" : "not_delivered")
        : nativeStatus.get(command.id)?.status;
    outcomes[command.kind][status ?? "unknown"] = (outcomes[command.kind][status ?? "unknown"] ?? 0) + 1;
    if (command.created_at === null) {
      outcomes[command.kind].delivered = delivered ? 1 : 0;
      continue;
    }
    latency[command.kind] ??= { queue_to_agent_ms: [], queue_to_applied_ms: [] };
    if (delivered) latency[command.kind].queue_to_agent_ms.push(delivered - command.created_at);
    const applied = command.kind === "lighting" ? lightingStatus.get(command.id)?.observed_ms
      : nativeStatus.get(command.id)?.applied_ms;
    if (applied) latency[command.kind].queue_to_applied_ms.push(applied - offset - command.created_at);
  }
  for (const value of Object.values(latency)) {
    value.queue_to_agent_ms = summarize(value.queue_to_agent_ms);
    value.queue_to_applied_ms = summarize(value.queue_to_applied_ms);
  }
  const frameRows = rows.filter((row) => row.function === "gas-mixer-agent" && row.action === "frame");
  const sessionMark = marks.find((entry) => entry.name === "session")?.at;
  const firstFrameAfterSession = frameRows.find((row) => row.started_at >= sessionMark);
  const [callsBefore, timeBefore] = statsBefore.split("|").map(Number);
  const [callsAfter, timeAfter] = statsAfter.split("|").map(Number);

  const result = {
    label,
    generated_at: new Date().toISOString(),
    environment: `local Supabase stack (postgres 17.6.1.127, PostgREST 14.5, edge-runtime 1.69.28); clients: native bridge ${args["native-bridge"] ? "STAGED " + args["native-bridge"].split("/").slice(-2).join("/") : "2.1.2 (installed)"}, screen agent ${args["screen-agent"] ? "STAGED " + args["screen-agent"].split("/").slice(-2).join("/") : "1.0.1 (installed)"}, lighting bridge 2.1.0 (JDK 8)`,
    clock_offset_ms: Math.round(offset),
    phase_ms: phaseDurations,
    invocation_rates: rates,
    command_latency_ms: latency,
    command_outcomes: outcomes,
    screen_session: {
      first_frame_after_session_ms: firstFrameAfterSession ? firstFrameAfterSession.started_at - sessionMark : null,
      frames_during_session: frameRows.filter((row) => row.started_at >= sessionMark && row.started_at < (marks.find((entry) => entry.name === "faults")?.at ?? Infinity)).length,
      taps_executed: taps.length,
    },
    viewer_bridge_age_ms: {
      native: summarize(viewerAgesFor("gas_mixer_native_status")),
      lighting: summarize(viewerAgesFor("lighting_native_status")),
    },
    database_statements: { api_role_calls: callsAfter - callsBefore, api_role_exec_ms: Math.round(timeAfter - timeBefore) },
  };
  function viewerAgesFor(rpc) {
    return viewerAges.filter((entry) => entry.rpc === rpc).map((entry) => entry.age_ms);
  }
  writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
