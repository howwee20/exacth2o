import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  FIELD_DEVICE_ID as device,
  FIELD_PROJECT_ID as project,
  normalizedValveKey,
} from "../_shared/installation-field-map.mjs";
import {
  assess,
  type Choice,
  type Match,
  type Pair,
  type Probe,
  route,
  type Sample,
  sensorId,
  type Setup,
  validateSetup,
  valveId,
} from "./model.ts";
type Phase = "baseline" | "pulse" | "receipt" | "observe" | "review" | "apply";
type Progress = {
  phase: Phase;
  potIndex: number;
  pass: number;
  cursor: number;
  probes: Probe[];
  candidates: string[];
  baseline: Record<string, Sample[]>;
  after: Record<string, Sample[]>;
  matches: Match[];
  missing: number[];
  coefficients: number[];
  message: string;
  command: string;
  pulseAt: number;
  batch?: string;
  acknowledgedAt?: number;
  intakeAt?: number;
};
type Run = {
  id: string;
  project_id: string;
  device_id: string;
  owner_id: string;
  status: string;
  setup: Setup;
  progress: Progress;
  revision: number;
  lease_until: string | null;
  updated_at: string;
};
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const table = () => db.from("rhee_discovery_runs");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Cache-Control": "no-store",
};
const reply = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: cors });
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
function requireData<T>(
  r: { data: T; error: { message: string } | null },
): NonNullable<T> {
  if (r.error) throw Error(r.error.message);
  return r.data as NonNullable<T>;
}
async function current() {
  return requireData(
    await table().select("*").eq("project_id", project).eq("device_id", device)
      .in("status", ["running", "review", "applying", "ready"]).maybeSingle(),
  ) as Run | null;
}
const visible = (r: Run | null, uid: string) =>
  r
    ? {
      id: r.id,
      owner: r.owner_id === uid,
      status: r.status,
      setup: r.setup,
      message: r.progress.message,
      phase: r.progress.phase,
      pot: r.setup.pots[r.progress.potIndex]?.pot,
      finished: r.progress.potIndex,
      matches: r.progress.matches,
      missing: r.progress.missing,
    }
    : null;
async function inventory() {
  const [cf, es, as, rt, ex, cs] = await Promise.all([
    db.from("device_config_state").select(
      "pairings,sensors,valves,calibrations,config_hash,updated_at",
    ).eq("project_id", project).eq("device_id", device).single(),
    db.from("experiments").select("id,current_revision_id").eq(
      "project_id",
      project,
    ).in("status", [
      "published_sensing",
      "active",
      "activating",
      "activation_failed",
    ]),
    db.from("experiment_assignments").select(
      "experiment_id,revision_id,pairing_name,sensor_key_snapshot,valve_key_snapshot,pot_number",
    ).eq("project_id", project),
    db.from("device_runtime_state").select("controller_state,state_fresh_until")
      .eq("project_id", project).eq("device_id", device).single(),
    db.from("device_control_executor_status").select(
      "manual_water_enabled,dry_run,local_api_reachable,observed_at",
    ).eq("project_id", project).eq("device_id", device).single(),
    db.from("commissioning_sessions").select("run_id").eq("project_id", project)
      .eq("device_id", device).eq("active", true).limit(1),
  ]);
  const config = requireData(cf),
    active = requireData(es),
    rows = requireData(as),
    runtime = requireData(rt),
    executor = requireData(ex);
  if (requireData(cs).length) {
    throw Error("Another Autopair session is open on Rhee.");
  }
  const assignments = rows.filter((a) =>
    active.some((e) =>
      e.id === a.experiment_id && e.current_revision_id === a.revision_id
    )
  );
  const names = new Set(assignments.map((a) => a.pairing_name));
  const occupiedSensors = new Set(
    assignments.map((a) => a.sensor_key_snapshot),
  );
  const occupiedValves = new Set(
    assignments.map((a) => normalizedValveKey(a.valve_key_snapshot)),
  );
  const occupiedPots = new Set(assignments.map((a) => a.pot_number));
  const pairs: Pair[] = config.pairings;
  for (const p of pairs) {
    if (names.has(p.name)) {
      occupiedSensors.add(sensorId(p));
      occupiedValves.add(valveId(p));
    }
  }
  return {
    config,
    runtime,
    executor,
    pairs,
    occupiedSensors,
    occupiedValves,
    occupiedPots,
  };
}
type Inventory = Awaited<ReturnType<typeof inventory>>;
function checkSelection(i: Inventory, setup: Setup, installed: Match[] = []) {
  for (const choice of setup.pots) {
    const v = route(choice.pot), vk = normalizedValveKey(v.key);
    if (i.occupiedPots.has(choice.pot) || i.occupiedValves.has(vk)) {
      throw Error(
        "Pot " + choice.pot + " is reserved by an active experiment.",
      );
    }
    const owners = i.pairs.filter((p) =>
      valveId(p) === vk || p.name.toLowerCase() === v.name.toLowerCase()
    );
    if (
      owners.length &&
      !(owners.length === 1 &&
        installed.some((m) =>
          m.pot === choice.pot && m.name === owners[0].name &&
          m.sensorKey === sensorId(owners[0]) && valveId(owners[0]) === vk
        ))
    ) {
      throw Error(
        "Pot " + choice.pot +
          " already has a controller pairing. Use the existing pairing in experiment setup.",
      );
    }
    if (
      !i.config.valves.some((val: { relayAddress: string; address: string }) =>
        normalizedValveKey(val.relayAddress + ":" + val.address) === vk
      )
    ) {
      throw Error(
        "Valve for pot " + choice.pot +
          " is missing from controller inventory.",
      );
    }
  }
  const curve = i.config.calibrations.find((c: { name: string }) =>
    c.name === setup.curve
  );
  if (!curve) throw Error("Choose an installed soil curve.");
  const coefficients = String(curve.polynomialCoefficientsCommaDelimited).split(
    ",",
  ).map((s) => s.trim() ? Number(s) : NaN);
  if (!coefficients.length || !coefficients.every(Number.isFinite)) {
    throw Error("The soil curve has invalid coefficients.");
  }
  return coefficients;
}
function checkController(i: Inventory) {
  if (
    i.runtime.controller_state?.toLowerCase() !== "running" ||
    Date.parse(i.runtime.state_fresh_until) <= Date.now() ||
    Date.now() - Date.parse(i.executor.observed_at) > 180000 ||
    !i.executor.local_api_reachable || i.executor.dry_run
  ) throw Error("Waiting for a fresh, running Rhee controller.");
}
function probes(i: Inventory): Probe[] {
  const used = new Set(
    i.pairs.filter((p) => i.occupiedValves.has(valveId(p))).map(sensorId),
  );
  const seen = new Set<string>();
  return i.config.sensors.flatMap(
    (s: { id: number; boardSerialId: string; address: string }) => {
      const key = s.boardSerialId + ":" + s.address;
      if (
        !s.boardSerialId || !s.address || used.has(key) ||
        i.occupiedSensors.has(key)
      ) return [];
      if (seen.has(key)) {
        throw Error("Duplicate sensor identity in controller inventory.");
      }
      seen.add(key);
      return [{ id: s.id, key }];
    },
  );
}
async function rawProbe(probe: Probe) {
  const base = Deno.env.get("OWNER_HEALTH_BASE_URL") ||
    "https://" + device + ".balena-devices.com/owner-health";
  const user = Deno.env.get("OWNER_HEALTH_USER") ||
    Deno.env.get("MATT_OWNER_HEALTH_USER");
  const pass = Deno.env.get("OWNER_HEALTH_PASSWORD") ||
    Deno.env.get("MATT_OWNER_HEALTH_PASSWORD");
  if (!user || !pass) throw Error("Rhee probe access is unavailable.");
  const resp = await fetch(
    base.replace(/\/$/, "") + "/api/bench-sensor-read?" +
      new URLSearchParams({ id: String(probe.id), key: probe.key }),
    {
      headers: { Authorization: "Basic " + btoa(user + ":" + pass) },
      signal: AbortSignal.timeout(41000),
      redirect: "error",
    },
  );
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 503 && /no valid reading/.test(data.error || "")) {
    return null;
  }
  if (
    !resp.ok || data.sensorKey !== probe.key || !Number.isFinite(data.rawValue)
  ) throw Error(data.error || "Rhee probe reader is unavailable.");
  return data.rawValue as number;
}
function resetScans(g: Progress) {
  g.pass = 0;
  g.cursor = 0;
}
async function scan(r: Run, i: Inventory) {
  const g = r.progress;
  const baseline = g.phase === "baseline",
    first = baseline && g.potIndex === 0 && g.pass === 0;
  const keys = first ? g.probes.map((p) => p.key) : g.candidates;
  const eligible = new Set(probes(i).map((s) => s.key));
  const readings = baseline ? g.baseline : g.after;
  const started = Date.now();
  for (
    let n = 0;
    g.cursor < keys.length && n < 6 && Date.now() - started < 8000;
    n++
  ) {
    const key = keys[g.cursor], probe = g.probes.find((s) => s.key === key)!;
    if (!eligible.has(key)) {
      throw Error(
        "Probe inventory changed. Recheck the run before continuing.",
      );
    }
    const raw = await rawProbe(probe);
    const v = raw === null
      ? NaN
      : g.coefficients.reduceRight((value, c) => value * raw + c, 0);
    if (Number.isFinite(v) && v >= 0 && v <= 70) {
      (readings[key] ??= []).push({ v, t: Date.now() });
    } else if (!first) {
      throw Error(
        "A candidate probe stopped reporting usable moisture. No further pulse was requested.",
      );
    }
    g.cursor++;
  }
  g.message = (baseline ? "Baseline" : "Watching moisture rise") + " for pot " +
    r.setup.pots[g.potIndex].pot + " · pass " + (g.pass + 1) + "/3 · " +
    g.cursor + "/" + keys.length + " probes";
  if (g.cursor < keys.length) return;
  if (first) {
    g.candidates = Object.keys(g.baseline);
    if (g.candidates.length < r.setup.pots.length) {
      throw Error(
        "Only " + g.candidates.length +
          " unused probes returned plausible moisture for " +
          r.setup.pots.length + " pots. Check that the probes are plugged in.",
      );
    }
  }
  g.cursor = 0;
  g.pass++;
  if (g.pass < 3) return;
  if (baseline) {
    if (
      g.candidates.some((k) => {
        const v = g.baseline[k].map((s) => s.v);
        return Math.max(...v) - Math.min(...v) > .5;
      })
    ) {
      g.baseline = {};
      resetScans(g);
      g.message = "Waiting for stable moisture before the next pulse.";
      return;
    }
    g.phase = "pulse";
    g.command = crypto.randomUUID();
    g.message = "Baseline ready for pot " + r.setup.pots[g.potIndex].pot;
    return;
  }
  const pot = r.setup.pots[g.potIndex].pot,
    best = assess(g.baseline, g.after, g.candidates);
  const prior = best
    ? g.matches.find((m) => m.sensorKey === best.key)
    : undefined;
  if (prior) {
    g.matches = g.matches.filter((m) => m !== prior);
    g.missing.push(prior.pot, pot);
  } else if (best && i.pairs.some((p) => sensorId(p) === best.key)) {
    g.missing.push(pot);
    g.message = "Responding probe already has a controller route: " + best.key;
  } else if (best) {
    const v = route(pot);
    g.matches.push({
      pot,
      name: v.name,
      valveKey: v.key,
      sensorKey: best.key,
      delta: best.delta,
    });
  } else g.missing.push(pot);
  g.potIndex++;
  resetScans(g);
  g.baseline = {};
  g.after = {};
  if (g.potIndex >= r.setup.pots.length) {
    r.status = "review";
    g.phase = "review";
    g.message = g.matches.length + " of " + r.setup.pots.length +
      " pots matched. Review the results.";
  } else {
    g.phase = "baseline";
    g.message = "Collecting a fresh baseline for pot " +
      r.setup.pots[g.potIndex].pot;
  }
}
async function pulse(r: Run, i: Inventory) {
  const g = r.progress, pot = r.setup.pots[g.potIndex].pot, v = route(pot);
  const liveRoute = requireData(
    await db.from("manual_valve_routes").select("status,relay_address,channel")
      .eq("project_id", project).eq("device_id", device).eq("pot_number", pot)
      .single(),
  );
  if (
    liveRoute.status !== "confirmed" ||
    normalizedValveKey(liveRoute.relay_address + ":" + liveRoute.channel) !==
      normalizedValveKey(v.key)
  ) {
    throw Error(
      "The physical valve route changed. Review the field map before testing this pot.",
    );
  }
  if (
    !i.executor.manual_water_enabled ||
    Deno.env.get("RHEE_DISCOVERY_PULSES_ENABLED") !== "1" ||
    Deno.env.get("CONTROL_COMMAND_INTAKE_ENABLED") !== "1"
  ) throw Error("Timed pulses are disabled on Rhee.");
  const last = Math.min(
    ...g.candidates.map((k) => g.baseline[k]?.at(-1)?.t ?? 0),
  );
  if (Date.now() - last > 15 * 60_000) {
    g.phase = "baseline";
    resetScans(g);
    g.baseline = {};
    g.message = "Refreshing the baseline before watering.";
    return;
  }
  const hold = requireData(
    await db.from("manual_hold_sessions").select("id").eq("project_id", project)
      .eq("device_id", device).in("status", ["opening", "open"]).gte(
        "started_at",
        new Date(Date.now() - 120000).toISOString(),
      ).limit(1),
  );
  if (hold.length) throw Error("Manual watering is in progress.");
  const now = Date.now();
  requireData(
    await db.rpc("enqueue_portal_control_command", {
      command_project_id: project,
      command_device_id: device,
      command_type: "manual_water",
      command_payload: {
        valve_keys: [v.key],
        duration_seconds: 3,
        total_valve_seconds: 3,
      },
      command_requested_by: r.owner_id,
      command_expires_at: new Date(now + 45000).toISOString(),
      command_requires_confirmation: true,
      command_confirmed_at: new Date(now).toISOString(),
      command_client_request_id: g.command,
    }),
  );
  g.phase = "receipt";
  g.pulseAt = now;
  g.message = "Waiting for controller confirmation for pot " + pot;
}
async function receipt(r: Run) {
  const g = r.progress;
  const c = requireData(
    await db.from("project_control_commands").select(
      "status,result,error,completed_at",
    ).eq("project_id", project).eq("client_request_id", g.command).single(),
  );
  if (
    ["failed", "expired", "canceled"].includes(c.status) ||
    Date.now() - g.pulseAt > 180000
  ) throw Error(c.error || "The controller did not confirm the pulse.");
  if (c.status !== "succeeded") return;
  if (
    !c.result || c.result.dryRun !== false || !Array.isArray(c.result.pulses) ||
    c.result.pulses.length !== 1 || c.result?.interruptions?.length ||
    c.result?.interrupted || c.result?.interruptedBy
  ) throw Error("The pulse was interrupted or simulated.");
  g.acknowledgedAt = Date.parse(c.completed_at) || Date.now();
  g.phase = "observe";
  resetScans(g);
  g.message = "Pulse confirmed. Waiting for water to reach the probes.";
}
async function apply(r: Run, i: Inventory) {
  const matches = r.progress.matches;
  if (
    !matches.length || r.progress.missing.length ||
    matches.length !== r.setup.pots.length
  ) {
    throw Error(
      "Every selected pot needs a clear match before creating this experiment.",
    );
  }
  const installed = i.pairs.filter((p) =>
    matches.some((m) =>
      m.name === p.name && m.sensorKey === sensorId(p) &&
      normalizedValveKey(m.valveKey) === valveId(p)
    )
  );
  const pending = matches.filter((m) =>
    !installed.some((p) => p.name === m.name)
  ).slice(0, 19);
  if (!pending.length) throw Error("No new matches to install.");
  const free = new Set(probes(i).map((p) => p.key));
  if (
    pending.some((m) =>
      !free.has(m.sensorKey) || i.pairs.some((p) => sensorId(p) === m.sensorKey)
    )
  ) throw Error("A matched sensor is now in use.");
  const cmd = (command_type: string, payload: unknown) => ({
    command_type,
    payload,
    client_request_id: crypto.randomUUID(),
    requires_confirmation: true,
  });
  const commands = [
    cmd("update_system_state", { state: "stopped" }),
    ...pending.map((m) =>
      cmd("create_pairing", {
        name: m.name,
        sensor_key: m.sensorKey,
        valve_key: m.valveKey,
        disable_watering: true,
        open_time_seconds: 1,
        measurement_interval_seconds: 30,
      })
    ),
    cmd("apply_calibration", {
      calibration_name: r.setup.curve,
      pairing_names: pending.map((m) => m.name),
    }),
    cmd("update_system_state", { state: "running" }),
  ];
  requireData(
    await db.rpc("apply_rhee_discovery_batch", {
      run_id: r.id,
      expected_revision: r.revision,
      expected_hash: i.config.config_hash,
      restore_state: "running",
      batch_id: crypto.randomUUID(),
      commands,
    }),
  );
}
async function step(r: Run, action: string) {
  const g = r.progress;
  if (r.status === "applying") {
    const list = requireData(
      await db.from("project_control_commands").select("status,error").eq(
        "batch_id",
        g.batch,
      ),
    );
    if (
      list.some((c) => ["failed", "expired", "canceled"].includes(c.status))
    ) {
      throw Error(
        "Controller setup stopped: " +
          (list.find((c) => c.error)?.error ||
            "one step failed. Inspect the controller before retrying."),
      );
    }
    if (!list.length || list.some((c) => c.status !== "succeeded")) return;
    const i = await inventory();
    const done = g.matches.filter((m) =>
      i.pairs.some((p) =>
        p.name === m.name && sensorId(p) === m.sensorKey &&
        valveId(p) === normalizedValveKey(m.valveKey) &&
        (p as Pair & { Calibration?: { name: string } }).Calibration?.name ===
          r.setup.curve
      )
    );
    if (done.length === g.matches.length) {
      r.status = "ready";
      g.message =
        "Controller pairings and soil curve confirmed. Create the experiment below.";
    } else if (done.length >= 19 && g.matches.length > 19) {
      r.status = "review";
      g.message = "Continue installing the remaining matches.";
    } else if (Date.now() - Date.parse(r.updated_at) > 180000) {
      throw Error(
        "Waiting for the controller to report the installed pairings.",
      );
    }
    return;
  }
  const i = await inventory();
  checkController(i);
  const coeff = checkSelection(
    i,
    r.setup,
    r.status === "review" ? g.matches : [],
  );
  if (JSON.stringify(coeff) !== JSON.stringify(g.coefficients)) {
    throw Error("The soil curve changed. Start a fresh discovery.");
  }
  if (r.status === "review" && action === "apply") {
    await apply(r, i);
    return;
  }
  if (r.status !== "running") return;
  if (g.phase === "baseline") await scan(r, i);
  else if (g.phase === "pulse") await pulse(r, i);
  else if (g.phase === "receipt") await receipt(r);
  else if (
    g.phase === "observe" &&
    Date.now() - (g.acknowledgedAt ?? Date.now()) >= 60000
  ) {
    if (Date.now() - (g.acknowledgedAt ?? 0) > 30 * 60000) {
      throw Error(
        "The observation window expired. The pulse will not be repeated automatically.",
      );
    }
    await scan(r, i);
  }
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token =
      req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) return reply({ error: "Sign in." }, 401);
    const access = requireData(
      await db.from("portal_access").select("role").eq("project_id", project)
        .eq("access_scope", "project").eq("user_id", user.id).maybeSingle(),
    );
    if (!access) {
      return reply({ error: "Rhee project access is required." }, 403);
    }
    const body = await req.json(), action = body.action;
    let r = await current();
    if (action === "status") return reply({ run: visible(r, user.id) });
    if (!["admin", "researcher"].includes(access.role)) {
      return reply({ error: "Researcher access is required." }, 403);
    }
    if (action === "start") {
      if (r) {
        return reply({
          run: visible(r, user.id),
          error: "Another discovery is open.",
        }, 409);
      }
      const setup: Setup = body.setup;
      validateSetup(setup);
      const i = await inventory();
      checkController(i);
      const coefficients = checkSelection(i, setup);
      const prospective = probes(i);
      if (prospective.length < setup.pots.length) {
        throw Error("There are too few free probes.");
      }
      const progress: Progress = {
        phase: "baseline",
        potIndex: 0,
        pass: 0,
        cursor: 0,
        probes: prospective,
        candidates: [],
        baseline: {},
        after: {},
        matches: [],
        missing: [],
        coefficients,
        message: "Reading unused probes before the first pulse.",
        command: "",
        pulseAt: 0,
      };
      r = requireData(
        await table().insert({
          id: crypto.randomUUID(),
          project_id: project,
          device_id: device,
          owner_id: user.id,
          status: "running",
          setup,
          progress,
        }).select().single(),
      ) as Run;
      return reply({ run: visible(r, user.id) });
    }
    if (!r || body.id !== r.id) {
      return reply({ error: "This run has ended." }, 409);
    }
    if (
      r.owner_id !== user.id && !(action === "close" && access.role === "admin")
    ) {
      return reply({
        error: "Only the operator who started this run can advance it.",
      }, 403);
    }
    if (!["tick", "apply", "close"].includes(action)) {
      return reply({ error: "Unknown action." }, 400);
    }
    if (action === "close" && r.status === "applying") {
      throw Error("Wait for controller setup to finish.");
    }
    if (action === "tick" && !["running", "applying"].includes(r.status)) {
      return reply({ run: visible(r, user.id) });
    }
    if (r.lease_until && Date.parse(r.lease_until) > Date.now()) {
      return reply({ run: visible(r, user.id) });
    }
    const lease = requireData(
      await table().update({
        revision: r.revision + 1,
        lease_until: new Date(Date.now() + 85000).toISOString(),
      }).eq("id", r.id).eq("revision", r.revision).select("*").maybeSingle(),
    ) as Run | null;
    if (!lease) return reply({ run: visible(await current(), user.id) });
    r = lease;
    try {
      if (action === "close") r.status = "closed";
      else await step(r, action);
    } catch (e) {
      r.progress.message = msg(e);
      if (action === "tick") {
        r.status = "review";
        r.progress.phase = "review";
        if (
          r.progress.potIndex < r.setup.pots.length &&
          !r.progress.missing.length
        ) r.progress.missing.push(r.setup.pots[r.progress.potIndex].pot);
      }
    }
    requireData(
      await table().update({
        status: r.status,
        progress: r.progress,
        lease_until: null,
        updated_at: new Date().toISOString(),
        revision: r.revision + 1,
      }).eq("id", r.id).eq("revision", r.revision),
    );
    return reply({ run: visible(await current(), user.id) });
  } catch (e) {
    return reply({ error: msg(e) }, 400);
  }
});
