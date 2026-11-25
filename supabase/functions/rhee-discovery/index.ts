import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  FIELD_DEVICE_ID as device,
  FIELD_PROJECT_ID as project,
  normalizedValveKey,
} from "../_shared/installation-field-map.mjs";
import {
  type Choice,
  clearResponse,
  type Match,
  type Pair,
  type Probe,
  rankResponses,
  type Rise,
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
  evidence?: Record<
    number,
    { rises: Rise[]; complete: boolean; reason: string }
  >;
  queue?: number[];
  baselineRetries?: number;
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
  tries?: number; // attempts on the probe at `cursor`
  streak?: number; // failed reads in a row, across probes
  holds?: number; // reader outages in a row
  holdUntil?: number;
  unsure?: string[]; // faulted (not silent) during discovery; kept as candidates
  fill?: string[]; // candidates still short of three readings after pass 3
  readMs?: number;
  issues?: Issue[];
  unconfirmed?: { pot: number; at: number; why: string }[];
  repulse?: number[];
};
type Issue = {
  t: number;
  probe: string;
  phase: Phase;
  pass: number;
  pot?: number;
  reason: string;
};
type Read = { raw: number } | { silent: true } | {
  fault: string;
  fatal?: boolean;
};
const READ_BUDGET_MS = 40_000; // per tick; the lease is 100 s and one read is capped at 25 s
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const clock = (t: number) =>
  new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Detroit" });
type Run = {
  id: string;
  project_id: string;
  device_id: string;
  owner_id: string;
  status: string;
  setup: Setup;
  progress: Progress;
  revision: number;
  worker_version: number;
  dispatch_token?: string;
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
const visible = (r: Run | null, uid: string, admin = false) =>
  r
    ? {
      id: r.id,
      owner: r.owner_id === uid,
      canClose: admin || r.owner_id === uid,
      updatedAt: r.updated_at,
      workerVersion: r.worker_version,
      evidence: r.progress.evidence ?? {},
      preview: r.progress.phase === "observe"
        ? rankResponses(
          r.progress.baseline,
          r.progress.after,
          r.progress.candidates,
        ).slice(0, 5)
        : [],
      status: r.status,
      setup: r.setup,
      message: r.progress.message,
      phase: r.progress.phase === "observe" &&
          Date.now() - (r.progress.acknowledgedAt ?? 0) < 60000
        ? "soak"
        : r.progress.phase,
      soakUntil: r.progress.phase === "observe"
        ? (r.progress.acknowledgedAt ?? 0) + 60000
        : undefined,
      scan: ["baseline", "observe"].includes(r.progress.phase)
        ? {
          pass: r.progress.pass + 1,
          done: r.progress.cursor,
          total: r.progress.candidates.length
            ? (r.progress.pass < 3
              ? r.progress.candidates.length
              : r.progress.fill?.length ?? 0)
            : r.progress.probes.length,
          answering: r.progress.candidates.length ||
            Object.keys(r.progress.baseline).length,
          readMs: r.progress.readMs,
          holdUntil: r.progress.holdUntil,
        }
        : undefined,
      issues: r.progress.issues ?? [],
      unconfirmed: r.progress.unconfirmed ?? [],
      pot: r.setup.pots[r.progress.potIndex]?.pot,
      finished: r.progress.matches.length + new Set(r.progress.missing).size,
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
// Never throws for a read problem: the caller decides whether one probe or the reader is at fault.
async function rawProbe(probe: Probe): Promise<Read> {
  const base = Deno.env.get("OWNER_HEALTH_BASE_URL") ||
    "https://" + device + ".balena-devices.com/owner-health";
  const user = Deno.env.get("OWNER_HEALTH_USER") ||
    Deno.env.get("MATT_OWNER_HEALTH_USER");
  const pass = Deno.env.get("OWNER_HEALTH_PASSWORD") ||
    Deno.env.get("MATT_OWNER_HEALTH_PASSWORD");
  if (!user || !pass) throw Error("Rhee probe access is unavailable.");
  let status = 0, text = "";
  try {
    const resp = await fetch(
      base.replace(/\/$/, "") + "/api/bench-sensor-read?" +
        new URLSearchParams({ id: String(probe.id), key: probe.key }),
      {
        headers: { Authorization: "Basic " + btoa(user + ":" + pass) },
        // The controller gives up on a probe after 15 s and on the lookup after 5 s.
        signal: AbortSignal.timeout(25000),
        redirect: "error",
      },
    );
    status = resp.status;
    text = await resp.text();
  } catch (e) {
    return {
      fault: (e as Error)?.name === "TimeoutError"
        ? "no answer from the controller within 25 s"
        : "could not reach the controller (" + msg(e) + ")",
    };
  }
  let data: { error?: string; sensorKey?: string; rawValue?: unknown } = {};
  try {
    data = JSON.parse(text) ?? {};
  } catch { /* a proxy error page; reported below */ }
  if (status === 503 && /no valid reading/.test(data.error || "")) {
    return { silent: true };
  }
  if (status === 409 && /identity changed/i.test(data.error || "")) {
    return { fault: data.error!, fatal: true };
  }
  if (status < 200 || status > 299) {
    return {
      fault: "HTTP " + status + " · " +
        (data.error ||
          text.replace(/<[^>]*>|\s+/g, " ").trim().slice(0, 90) ||
          "empty reply"),
    };
  }
  if (data.sensorKey !== probe.key) {
    return {
      fault: "the reader answered for " + (data.sensorKey || "no probe"),
      fatal: true,
    };
  }
  if (!Number.isFinite(data.rawValue)) {
    return { fault: "the reader returned a non-numeric value" };
  }
  return { raw: data.rawValue as number };
}
function note(r: Run, probe: string, reason: string) {
  const g = r.progress, issues = g.issues ??= [];
  issues.push({
    t: Date.now(),
    probe,
    phase: g.phase,
    pass: g.pass + 1,
    pot: r.setup.pots[g.potIndex]?.pot,
    reason,
  });
  if (issues.length > 30) issues.splice(0, issues.length - 30);
}
// Mid-tick heartbeat. A stop or close bumps the revision, so no match means "stop reading".
async function checkpoint(r: Run) {
  const saved = await table().update({
    progress: r.progress,
    updated_at: new Date().toISOString(),
  }).eq("id", r.id).eq("revision", r.revision).select("id");
  return !saved.error && saved.data?.length === 1;
}
function resetScans(g: Progress) {
  g.pass = 0;
  g.cursor = 0;
  g.tries = 0;
  delete g.fill;
}
async function scan(r: Run, i: Inventory) {
  const g = r.progress;
  const baseline = g.phase === "baseline",
    first = baseline && !g.candidates.length && g.pass === 0;
  if (Date.now() < (g.holdUntil ?? 0)) return;
  const keys = first
    ? g.probes.map((p) => p.key)
    : g.pass < 3
    ? g.candidates
    : g.fill ?? [];
  const eligible = new Set(probes(i).map((s) => s.key));
  const readings = baseline ? g.baseline : g.after;
  const pot = r.setup.pots[g.potIndex].pot;
  const label = () =>
    (first ? "Finding probes" : baseline ? "Baseline" : "Watching moisture") +
    " for pot " + pot + " · " +
    (g.pass < 3 ? "pass " + (g.pass + 1) + "/3" : "re-reading missed probes") +
    " · " + g.cursor + "/" + keys.length + " probes";
  const started = Date.now();
  let saved = started;
  while (g.cursor < keys.length && Date.now() - started < READ_BUDGET_MS) {
    const key = keys[g.cursor], probe = g.probes.find((s) => s.key === key)!;
    if (!eligible.has(key)) {
      throw Error(
        "Probe inventory changed. Recheck the run before continuing.",
      );
    }
    const asked = Date.now();
    const read = await rawProbe(probe);
    if ("fault" in read) {
      if (read.fatal) {
        throw Error(
          "Probe " + key + ": " + read.fault +
            ". Recheck the run before continuing.",
        );
      }
      g.streak = (g.streak ?? 0) + 1;
      if (g.streak >= 4) {
        // Four failed reads in a row is the reader, not a probe: wait instead of skipping probes.
        g.holds = (g.holds ?? 0) + 1;
        g.streak = 0;
        g.tries = 0;
        if (g.holds > 5) {
          throw Error(
            "The probe reader stopped answering during " +
              (baseline ? "the baseline" : "the moisture watch") + " for pot " +
              pot + " (last: probe " + key + " · " + read.fault + ").",
          );
        }
        g.holdUntil = Date.now() +
          Math.min(120000, 15000 * 2 ** (g.holds - 1));
        g.message = "Probe reader is not answering (probe " + key + " · " +
          read.fault + "). Retry " + g.holds + "/5 at " + clock(g.holdUntil) +
          ".";
        return;
      }
      g.tries = (g.tries ?? 0) + 1;
      if (g.tries < 2) {
        await sleep(/being read/.test(read.fault) ? 1500 : 500);
        continue;
      }
      // Skip this probe for this pass only; passes 4 and 5 come back for it.
      note(r, key, read.fault + " · read twice, skipped this pass");
      if (first) (g.unsure ??= []).push(key);
    } else {
      g.streak = 0;
      g.holds = 0;
      g.readMs = Math.round(
        g.readMs
          ? .8 * g.readMs + .2 * (Date.now() - asked)
          : Date.now() - asked,
      );
      const raw = "raw" in read ? read.raw : NaN;
      const v = g.coefficients.reduceRight((value, c) => value * raw + c, 0);
      if (Number.isFinite(raw) && raw > 0 && Number.isFinite(v)) {
        (readings[key] ??= []).push({ v, raw, t: Date.now() });
      }
    }
    g.tries = 0;
    g.cursor++;
    if (Date.now() - saved > 10000) {
      g.message = label();
      if (!await checkpoint(r)) return;
      saved = Date.now();
    }
  }
  g.message = label();
  if (g.cursor < keys.length) return;
  if (first) {
    g.candidates = keys.filter((k) =>
      g.baseline[k]?.length || g.unsure?.includes(k)
    );
    delete g.unsure;
    if (g.candidates.length < r.setup.pots.length) {
      throw Error(
        "Only " + g.candidates.length +
          " available probes returned a raw reading for " +
          r.setup.pots.length + " pots. Check that the probes are plugged in.",
      );
    }
  }
  g.cursor = 0;
  g.pass++;
  if (g.pass < 3) return;
  // One failed read must not end the run: re-read only the probes that are short, at most twice.
  const short = g.candidates.filter((k) => (readings[k]?.length ?? 0) < 3);
  if (short.length && g.pass < 5) {
    g.fill = short;
    g.message = "Re-reading " + short.length + " missed probe" +
      (short.length > 1 ? "s" : "") + " for pot " + pot;
    return;
  }
  delete g.fill;
  if (baseline) {
    if (short.length) {
      // Still short after five passes: leave those probes out, visibly, and keep going.
      for (const k of short) {
        note(
          r,
          k,
          "left out of this run · " + (g.baseline[k]?.length ?? 0) +
            " of 3 baseline readings",
        );
        delete g.baseline[k];
      }
      g.candidates = g.candidates.filter((k) => !short.includes(k));
      if (!g.candidates.length) {
        throw Error(
          "No probe kept three baseline readings. Check the probe reader.",
        );
      }
    }
    if (
      g.candidates.some((k) => {
        const v = g.baseline[k].map((s) => s.v);
        return Math.max(...v) - Math.min(...v) > .5;
      })
    ) {
      g.baselineRetries = (g.baselineRetries ?? 0) + 1;
      if (g.baselineRetries > 2) {
        throw Error(
          "Moisture is still changing before watering. Review and retry when the readings settle.",
        );
      }
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
  const complete = g.candidates.every((k) => (g.after[k]?.length ?? 0) >= 3);
  const rises = rankResponses(g.baseline, g.after, g.candidates);
  const best = clearResponse(rises, complete);
  const evidence = (g.evidence ??= {})[pot] = {
    rises,
    complete,
    reason: best
      ? "Clear response"
      : !complete
      ? "Incomplete readings"
      : rises.length
      ? "No distinct, sustained rise"
      : "No rise recorded",
  };
  const prior = best
    ? g.matches.find((m) => m.sensorKey === best.key)
    : undefined;
  if (prior) {
    g.matches = g.matches.filter((m) => m !== prior);
    g.missing.push(prior.pot, pot);
    evidence.reason = "More than one outlet produced this response";
    if (g.evidence?.[prior.pot]) g.evidence[prior.pot].reason = evidence.reason;
  } else if (best && i.pairs.some((p) => sensorId(p) === best.key)) {
    g.missing.push(pot);
    evidence.reason = "Responding probe already has a controller route";
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
  g.baselineRetries = 0;
  g.potIndex = g.queue
    ? (g.queue.shift() ?? r.setup.pots.length)
    : g.potIndex + 1;
  resetScans(g);
  // Recent post-pulse measurements can seed the next pot. Always take one new
  // reading per probe and run the ordinary stability check before opening a valve.
  const reuse = complete && g.candidates.every((key) => {
    const samples = g.after[key];
    return samples.length >= 3 &&
      Date.now() - samples[samples.length - 2].t < 5 * 60000;
  });
  g.baseline = reuse
    ? Object.fromEntries(
      g.candidates.map((key) => [key, g.after[key].slice(-2)]),
    )
    : {};
  if (reuse) g.pass = 2;
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
  if (
    g.unconfirmed?.some((u) => u.pot === pot) && !g.repulse?.includes(pot)
  ) {
    throw Error(
      "Pot " + pot +
        " has an unconfirmed pulse. Choose it explicitly to pulse this outlet again.",
    );
  }
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
      .eq("device_id", device).in("status", ["opening", "open"]).limit(1),
  );
  if (hold.length) throw Error("Manual watering is in progress.");
  const now = Date.now();
  const queued = await db.rpc("pulse_rhee_discovery", {
    run_id: r.id,
    expected_revision: r.revision,
    pot,
    cmd: g.command,
    expected_valve: v.key,
  });
  if (queued.error) {
    // An SQLSTATE means the database rejected the pulse and rolled back: nothing was queued.
    if ((queued.error as { code?: string }).code) {
      throw Error(queued.error.message);
    }
    // Otherwise the reply was lost and the pulse may have queued. Queuing moves the run to
    // "receipt" in the same transaction, so fence the row while it still says "pulse": the
    // revision bump makes a late enqueue fail, and no match means the pulse is already queued.
    const fence = await table().update({ revision: r.revision + 1 }).eq(
      "id",
      r.id,
    ).eq("revision", r.revision).eq("progress->>phase", "pulse").select(
      "revision",
    );
    if (fence.error) {
      unconfirmed(g, pot, "the pulse request may have queued");
      throw Error(
        "Pot " + pot + ": the pulse request got no reply (" +
          queued.error.message +
          "). It may have queued, so Autopair will not pulse this outlet again on its own.",
      );
    }
    if (fence.data?.length) {
      r.revision = fence.data[0].revision;
      throw Error(
        "Pot " + pot + ": the pulse request did not reach the database (" +
          queued.error.message + "). It was withdrawn. The valve did not open.",
      );
    }
  }
  g.phase = "receipt";
  g.pulseAt = now;
  g.message = "Waiting for controller confirmation for pot " + pot;
}
function unconfirmed(g: Progress, pot: number, why: string) {
  g.unconfirmed = [
    ...(g.unconfirmed ?? []).filter((u) => u.pot !== pot),
    { pot, at: g.pulseAt || Date.now(), why },
  ];
  g.repulse = (g.repulse ?? []).filter((p) => p !== pot);
  (g.evidence ??= {})[pot] = {
    rises: [],
    complete: false,
    reason: "Pulse not confirmed · " + why,
  };
}
async function receipt(r: Run) {
  const g = r.progress, pot = r.setup.pots[g.potIndex].pot;
  const c = requireData(
    await db.from("project_control_commands").select(
      "status,result,error,started_at,completed_at,expires_at",
    ).eq("project_id", project).eq("client_request_id", g.command).single(),
  );
  // Never claimed and no longer claimable: the controller cannot have opened the valve.
  if (
    !c.started_at &&
    (["expired", "canceled"].includes(c.status) ||
      (["queued", "accepted"].includes(c.status) &&
        Date.parse(c.expires_at) < Date.now()))
  ) {
    throw Error(
      "Pot " + pot + ": the controller never picked up the pulse sent at " +
        clock(g.pulseAt) + " (" + (c.error || "it expired unclaimed") +
        "). The valve did not open.",
    );
  }
  const clean = c.status === "succeeded" && c.result &&
    c.result.dryRun === false && Array.isArray(c.result.pulses) &&
    c.result.pulses.length === 1 && !c.result?.interruptions?.length &&
    !c.result?.interrupted && !c.result?.interruptedBy;
  if (!clean) {
    const settled = ["succeeded", "failed", "expired", "canceled"].includes(
      c.status,
    );
    if (!settled && Date.now() - g.pulseAt <= 180000) return;
    // Claimed by the controller without a clean receipt: the valve may have opened.
    const why = c.status === "succeeded"
      ? "the controller reported an interrupted or simulated pulse"
      : settled
      ? "the controller reported " + c.status +
        (c.error ? " · " + c.error : "")
      : "no receipt after 3 minutes (still " + c.status + ")";
    unconfirmed(g, pot, why);
    throw Error(
      "Pot " + pot + ": the pulse sent at " + clock(g.pulseAt) +
        " was not confirmed (" + why +
        "). The valve may have opened. Autopair will not pulse this outlet again on its own.",
    );
  }
  g.unconfirmed = (g.unconfirmed ?? []).filter((u) => u.pot !== pot);
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
      await db.from("project_control_commands").select(
        "status,error,completed_at",
      ).eq(
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
    } else if (
      Date.now() -
          Math.max(...list.map((c) => Date.parse(c.completed_at) || 0)) > 180000
    ) {
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
async function advance(r: Run, action: string, ticket?: string) {
  if (r.lease_until && Date.parse(r.lease_until) > Date.now()) return;
  let claim = table().update({
    revision: r.revision + 1,
    lease_until: new Date(Date.now() + 100_000).toISOString(),
    dispatch_token: null,
  }).eq("id", r.id).eq("revision", r.revision);
  if (ticket) claim = claim.eq("dispatch_token", ticket);
  const leased = requireData(await claim.select("*").maybeSingle()) as
    | Run
    | null;
  if (!leased) return;
  r = leased;
  try {
    if (
      action === "tick" && r.status === "running" &&
      Date.now() - Date.parse(r.updated_at) > 180000
    ) {
      throw Error(
        "Autopair paused after losing its worker heartbeat. Review the pots before retrying.",
      );
    }
    await step(r, action);
  } catch (e) {
    // Say plainly whether water was involved, so the operator never has to guess.
    const g = r.progress,
      dry = action === "tick" &&
        ["baseline", "pulse"].includes(g.phase) &&
        !/valve|outlet/i.test(msg(e));
    g.message = msg(e) +
      (dry
        ? " Autopair did not open the valve for pot " +
          r.setup.pots[g.potIndex]?.pot + "."
        : "");
    if (action === "tick") {
      r.status = "review";
      r.progress.phase = "review";
      r.progress.missing = r.setup.pots.filter((p) =>
        !r.progress.matches.some((m) => m.pot === p.pot)
      ).map((p) => p.pot);
    }
  }
  const now = new Date().toISOString();
  const saved = await table().update({
    status: r.status,
    progress: r.progress,
    lease_until: null,
    dispatch_after: now,
    updated_at: now,
    revision: r.revision + 1,
  }).eq("id", r.id).eq("revision", r.revision);
  if (saved.error) throw Error(saved.error.message);
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST required." }, 405);
  try {
    const body = await req.json(), action = body.action;
    if (action === "dispatch") {
      const ticket = req.headers.get("x-rhee-ticket") ?? "";
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (!uuid.test(ticket) || !uuid.test(body.id ?? "")) {
        return reply({ error: "Invalid worker ticket." }, 401);
      }
      const r = requireData(
        await table().select("*").eq("id", body.id).eq("dispatch_token", ticket)
          .eq("worker_version", 2).in("status", ["running", "applying"])
          .maybeSingle(),
      ) as Run | null;
      if (!r) return reply({ error: "Expired worker ticket." }, 401);
      await advance(r, "tick", ticket);
      return reply({ accepted: true });
    }
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
    let r = await current();
    if (action === "status" || action === "tick") {
      return reply({ run: visible(r, user.id, access.role === "admin") });
    }
    if (!["admin", "researcher"].includes(access.role)) {
      return reply({ error: "Researcher access is required." }, 403);
    }
    if (action === "start") {
      if (body.version !== 2) {
        return reply(
          { error: "Refresh the portal before starting Autopair." },
          409,
        );
      }
      if (r) {
        return reply({
          run: visible(r, user.id, access.role === "admin"),
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
        evidence: {},
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
          worker_version: 2,
          setup,
          progress,
        }).select().single(),
      ) as Run;
      return reply({ run: visible(r, user.id, access.role === "admin") });
    }
    if (!r || body.id !== r.id) {
      return reply({ error: "This run has ended." }, 409);
    }
    if (
      r.owner_id !== user.id &&
      !((action === "close" || action === "stop") && access.role === "admin")
    ) {
      return reply({
        error: "Only the operator who started this run can change it.",
      }, 403);
    }
    if (action === "close" || action === "stop") {
      const stopped = await db.rpc("stop_rhee_discovery", {
        run_id: r.id,
        keep_setup: action === "stop",
      });
      if (stopped.error) throw Error(stopped.error.message);
    } else if (
      action === "retry" && r.status === "review" && r.worker_version === 2 &&
      r.progress.missing.length
    ) {
      const i = await inventory();
      checkController(i);
      checkSelection(i, r.setup, r.progress.matches);
      const held = (r.progress.unconfirmed ?? []).map((u) => u.pot);
      const repulse: number[] = Array.isArray(body.repulse)
        ? body.repulse.filter((p: unknown) => held.includes(p as number))
        : [];
      const remaining = r.setup.pots.flatMap((p, index) =>
        r!.progress.missing.includes(p.pot) &&
          (!held.includes(p.pot) || repulse.includes(p.pot))
          ? [index]
          : []
      );
      const [potIndex, ...queue] = remaining;
      if (potIndex === undefined) {
        throw Error(
          held.length
            ? "Only pots with an unconfirmed pulse are left. Choose each one to pulse it again."
            : "No unresolved pots.",
        );
      }
      const g = {
        ...r.progress,
        phase: "baseline",
        potIndex,
        queue,
        probes: probes(i),
        candidates: [],
        baseline: {},
        after: {},
        baselineRetries: 0,
        pass: 0,
        cursor: 0,
        command: "",
        pulseAt: 0,
        // Pots left out of this retry stay unresolved instead of silently disappearing.
        missing: r.progress.missing.filter((p) =>
          held.includes(p) && !repulse.includes(p)
        ),
        repulse,
        tries: 0,
        streak: 0,
        holds: 0,
        holdUntil: 0,
        issues: [],
        message: "Reading a new baseline for the unresolved pots.",
      };
      delete g.fill;
      delete g.unsure;
      const restarted = await table().update({
        status: "running",
        progress: g,
        revision: r.revision + 1,
        updated_at: new Date().toISOString(),
        dispatch_after: new Date().toISOString(),
      }).eq("id", r.id).eq("revision", r.revision).eq("status", "review")
        .select("id").single();
      if (restarted.error) throw Error(restarted.error.message);
    } else if (action === "apply" && r.status === "review") {
      await advance(r, "apply");
    } else {return reply({
        error: "This action is unavailable in the current phase.",
      }, 409);}
    return reply({
      run: visible(await current(), user.id, access.role === "admin"),
    });
  } catch (e) {
    return reply({ error: msg(e) }, 400);
  }
});
