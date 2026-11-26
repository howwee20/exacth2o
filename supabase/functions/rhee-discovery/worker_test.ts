// Drives the real worker against an in-memory database and probe reader.
// Run: deno test --allow-env --allow-net supabase/functions/rhee-discovery/worker_test.ts
// deno-lint-ignore-file no-explicit-any
const RealDate = Date;
let skew = 0;
class Clock extends RealDate {
  constructor(...a: any[]) {
    if (a.length) super(...(a as [any]));
    else super(RealDate.now() + skew);
  }
  static override now() {
    return RealDate.now() + skew;
  }
}
globalThis.Date = Clock as DateConstructor;
for (
  const [k, v] of Object.entries({
    SUPABASE_URL: "http://db.test",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    OWNER_HEALTH_BASE_URL: "http://pi.test/owner-health",
    OWNER_HEALTH_USER: "u",
    OWNER_HEALTH_PASSWORD: "p",
    RHEE_DISCOVERY_PULSES_ENABLED: "1",
    CONTROL_COMMAND_INTAKE_ENABLED: "1",
  })
) Deno.env.set(k, v);

const RUN = "11111111-1111-4111-8111-111111111111";
const curve = [100.68, -.1289, .00004];
const keys = ["B1:A", "B1:B", "B1:C", "B1:D", "B1:E", "B1:F"];
const json = (data: unknown, status = 200) => Response.json(data, { status });
type Cmd = Record<string, any>;
let run: Record<string, any>, commands: Cmd[], rpcCalls: number;
let reader: (key: string, n: number) => Response | Promise<Response>;
let rpcMode: "ok" | "committed-then-502" | "lost";
let level: Record<string, number>;
const asked: Record<string, number> = {};
const normal = (key: string) => json({ sensorKey: key, rawValue: level[key] });

function reset(pots: number[]) {
  skew = 0;
  commands = [];
  rpcCalls = 0;
  rpcMode = "ok";
  reader = normal;
  level = Object.fromEntries(keys.map((k, i) => [k, 1810 + 4 * i]));
  for (const k of keys) asked[k] = 0;
  run = {
    id: RUN,
    project_id: "22222222-2222-4222-8222-222222222222",
    device_id: "3100e37ee3205651fe3dd86dafd4dc0c",
    owner_id: "owner",
    status: "running",
    worker_version: 2,
    revision: 0,
    dispatch_token: null,
    lease_until: null,
    updated_at: new Date().toISOString(),
    setup: {
      name: "t",
      mode: "calibration",
      curve: "curve",
      pots: pots.map((pot) => ({ pot, group: "g", target: null })),
    },
    progress: {
      evidence: {},
      phase: "baseline",
      potIndex: 0,
      pass: 0,
      cursor: 0,
      probes: keys.map((key, i) => ({ id: i + 1, key })),
      candidates: [],
      baseline: {},
      after: {},
      matches: [],
      missing: [],
      coefficients: curve,
      message: "",
      command: "",
      pulseAt: 0,
    },
  };
}
const tables: Record<string, () => unknown[]> = {
  rhee_discovery_runs: () => [run],
  project_control_commands: () => commands,
  device_config_state: () => [{
    pairings: [],
    sensors: keys.map((k, i) => ({
      id: i + 1,
      boardSerialId: "B1",
      address: k.slice(3),
    })),
    valves: [1, 2, 3].map((n) => ({
      relayAddress: "0x24",
      address: String(n),
    })),
    calibrations: [{
      name: "curve",
      polynomialCoefficientsCommaDelimited: curve.join(","),
    }],
    config_hash: "h",
  }],
  device_runtime_state: () => [{
    controller_state: "running",
    state_fresh_until: new Date(Date.now() + 60000).toISOString(),
  }],
  device_control_executor_status: () => [{
    manual_water_enabled: true,
    dry_run: false,
    local_api_reachable: true,
    observed_at: new Date().toISOString(),
  }],
  manual_valve_routes: () =>
    [1, 2, 3].map((n) => ({
      pot_number: n,
      status: "confirmed",
      relay_address: 36,
      channel: n,
    })),
  portal_access: () => [{ role: "researcher" }],
};
const cell = (row: any, col: string) =>
  col.includes("->>")
    ? row[col.split("->>")[0]]?.[col.split("->>")[1]]
    : row[col];
function matches(row: any, q: URLSearchParams) {
  for (const [col, cond] of q) {
    if (["select", "limit", "order"].includes(col)) continue;
    if (!(col in row) && !col.includes("->>")) continue; // fixture rows omit scope columns
    const [op, ...rest] = cond.split("."), value = rest.join(".");
    if (op === "eq" && String(cell(row, col)) !== value) return false;
    if (
      op === "in" &&
      !value.slice(1, -1).split(",").includes(String(cell(row, col)))
    ) return false;
  }
  return true;
}
globalThis.fetch = (async (input: any, init: any = {}) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  if (url.host === "pi.test") {
    const key = url.searchParams.get("key")!;
    return reader(key, ++asked[key]);
  }
  if (url.pathname === "/auth/v1/user") return json({ id: "owner" });
  if (url.pathname === "/rest/v1/rpc/pulse_rhee_discovery") {
    rpcCalls++;
    const b = await req.json();
    if (rpcMode === "lost") throw new TypeError("connection reset");
    if (
      run.status !== "running" || run.revision !== b.expected_revision ||
      run.progress.phase !== "pulse" || run.progress.command !== b.cmd
    ) {
      return json(
        { code: "P0001", message: "This pulse is no longer due" },
        400,
      );
    }
    commands.push({
      client_request_id: b.cmd,
      pot: b.pot,
      status: "queued",
      started_at: null,
      completed_at: null,
      expires_at: new Date(Date.now() + 45000).toISOString(),
      result: null,
      error: null,
    });
    run.progress = { ...run.progress, phase: "receipt", pulseAt: Date.now() };
    return rpcMode === "committed-then-502"
      ? new Response("<html>502 Bad Gateway</html>", { status: 502 })
      : new Response(null, { status: 204 });
  }
  const name = url.pathname.split("/").pop()!;
  const rows = (tables[name]?.() ?? []).filter((row) =>
    matches(row, url.searchParams)
  ) as any[];
  if (req.method === "PATCH") {
    const patch = await req.json();
    for (const row of rows) Object.assign(row, structuredClone(patch));
    if (!(req.headers.get("Prefer") ?? "").includes("return=representation")) {
      return new Response(null, { status: 204 });
    }
  }
  if ((req.headers.get("Accept") ?? "").includes("vnd.pgrst.object")) {
    return rows.length === 1
      ? json(structuredClone(rows[0]))
      : json({ code: "PGRST116", message: "no single row" }, 406);
  }
  return json(structuredClone(rows));
}) as typeof fetch;

let handler!: (req: Request) => Promise<Response>;
(Deno as any).serve = (h: typeof handler) => {
  handler = h;
  return {};
};
await import("./index.ts");

async function tick() {
  run.dispatch_token = crypto.randomUUID();
  const resp = await handler(
    new Request("http://fn/rhee-discovery", {
      method: "POST",
      headers: { "x-rhee-ticket": run.dispatch_token },
      body: JSON.stringify({ action: "dispatch", id: RUN }),
    }),
  );
  await resp.body?.cancel();
}
async function until(done: () => boolean, limit = 40) {
  for (let n = 0; n < limit && !done(); n++) await tick();
  if (!done()) throw Error("stuck: " + JSON.stringify(run.progress.message));
}
const check = (ok: unknown, why: string) => {
  if (!ok) throw Error(why + " · " + run.status + " · " + run.progress.message);
};
const confirm = (extra: Cmd = {}) =>
  Object.assign(commands.at(-1)!, {
    status: "succeeded",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    result: { dryRun: false, pulses: [{}] },
    ...extra,
  });
const options = { sanitizeOps: false, sanitizeResources: false };

Deno.test(
  "one failed probe read is retried, re-read and reported; the pot still matches",
  options,
  async () => {
    reset([1, 2]);
    reader = (key, n) =>
      key === "B1:C" && n === 1
        ? new Response("<html>502 Bad Gateway</html>", { status: 502 }) // retried at once
        : key === "B1:D" && (n === 2 || n === 3)
        ? json(
          { error: "Another probe is being read. Try again in a moment." },
          409,
        )
        : key === "B1:F"
        ? json({ error: "The probe returned no valid reading." }, 503) // unplugged
        : normal(key);
    await until(() => run.progress.phase === "pulse");
    const g = run.progress;
    check(run.status === "running", "run must survive failed reads");
    check(g.candidates.length === 5, "silent probe is not a candidate");
    check(
      g.candidates.every((k: string) => g.baseline[k].length === 3),
      "every candidate has three baseline readings",
    );
    check(
      g.issues.length === 1 && g.issues[0].probe === "B1:D" &&
        /HTTP 409 · Another probe is being read/.test(g.issues[0].reason),
      "the skipped read names the probe and the reader's own words",
    );
    await tick();
    check(
      g !== run.progress && run.progress.phase === "receipt",
      "pulse queued",
    );
    confirm();
    await tick();
    check(run.progress.phase === "observe", "clean receipt starts the watch");
    level["B1:B"] += 13; // the true probe for pot 1
    skew += 61000;
    await until(() => run.progress.potIndex === 1);
    check(
      run.progress.matches[0]?.pot === 1 &&
        run.progress.matches[0].sensorKey === "B1:B",
      "pot 1 matches the probe that rose",
    );
    check(rpcCalls === 1, "one pulse for one pot");
  },
);

Deno.test(
  "a reader outage pauses the run and names the cause; it resumes without a pulse",
  options,
  async () => {
    reset([1]);
    let down = true;
    reader = (key) =>
      down ? new Response("tunnel closed", { status: 504 }) : normal(key);
    await until(() => run.progress.holdUntil > Date.now(), 5);
    check(run.status === "running", "an outage must not end the run");
    check(
      /not answering \(probe B1:[AB] · HTTP 504 · tunnel closed\)\. Retry 1\/5/
        .test(run.progress.message),
      "the phone sees which probe, which error and when the retry is",
    );
    down = false;
    skew += 16000;
    await until(() => run.progress.phase === "pulse");
    const g = run.progress;
    check(rpcCalls === 0, "no pulse while the reader was down");
    check(
      g.candidates.length === 6 &&
        g.candidates.every((k: string) => g.baseline[k].length === 3),
      "the probe skipped before the outage was recognised is read again in full",
    );
  },
);

Deno.test(
  "an unconfirmed receipt is never pulsed again without the operator choosing that pot",
  options,
  async () => {
    reset([1, 2]);
    await until(() => run.progress.phase === "receipt");
    Object.assign(commands[0], {
      status: "running",
      started_at: new Date().toISOString(),
    });
    skew += 181000;
    run.updated_at = new Date().toISOString(); // the cron heartbeat kept ticking
    await tick();
    check(run.status === "review", "stops for review");
    check(run.progress.unconfirmed[0].pot === 1, "pot 1 is held");
    check(
      /may have opened.*will not pulse this outlet again/.test(
        run.progress.message,
      ),
      "the operator is told the valve may have opened",
    );
    const act = async (body: Record<string, unknown>) =>
      await (await handler(
        new Request("http://fn/rhee-discovery", {
          method: "POST",
          headers: { Authorization: "Bearer user" },
          body: JSON.stringify({ id: RUN, ...body }),
        }),
      )).json();
    await act({ action: "retry" });
    check(run.status === "running", "retry restarts the other pot");
    check(
      run.setup.pots[run.progress.potIndex].pot === 2 &&
        !run.progress.queue.length && run.progress.missing.includes(1),
      "the blanket retry leaves pot 1 unresolved and untouched",
    );
    await until(() => run.progress.phase === "receipt");
    check(commands.length === 2 && commands[1].pot === 2, "only pot 2 pulsed");
    run.status = "review";
    run.progress.missing = [1, 2];
    await act({ action: "retry", repulse: [1] });
    check(run.setup.pots[run.progress.potIndex].pot === 1, "explicit choice");
    check(
      run.progress.repulse.includes(1),
      "the choice is recorded for the guard",
    );
  },
);

Deno.test(
  "a lost reply to the pulse request cannot become a second pulse",
  options,
  async () => {
    reset([1]);
    rpcMode = "committed-then-502";
    await until(() => run.progress.phase === "pulse");
    await tick();
    check(
      run.status === "running" && run.progress.phase === "receipt" &&
        run.lease_until === null,
      "a queued pulse keeps its receipt phase",
    );
    check(rpcCalls === 1 && commands.length === 1, "queued exactly once");

    reset([1]);
    rpcMode = "lost";
    await until(() => run.progress.phase === "pulse");
    const before = run.revision;
    await tick();
    check(run.status === "review" && !commands.length, "withdrawn, not queued");
    check(run.revision > before + 1, "the fence moved the revision first");
    check(
      /did not reach the database.*The valve did not open/.test(
        run.progress.message,
      ),
      "the operator is told no water moved",
    );
  },
);

Deno.test(
  "a pulse the controller never claimed is reported as not opened",
  options,
  async () => {
    reset([1]);
    await until(() => run.progress.phase === "receipt");
    skew += 46000;
    await tick();
    check(run.status === "review", "stops for review");
    check(
      !run.progress.unconfirmed?.length,
      "nothing is held: it can be retried",
    );
    check(
      /never picked up the pulse.*The valve did not open/.test(
        run.progress.message,
      ),
      "exact reason",
    );
  },
);

Deno.test("single-pot trial records the early watch and finishes without advancing to another valve", options, async () => {
  reset([1, 2, 3]);
  Object.assign(run.progress, {singlePot: 2, potIndex: 1, queue: []});
  await until(() => run.progress.phase === "receipt");
  confirm();
  await tick();
  await tick();
  check(run.progress.after["B1:B"]?.length === 1, "early observations start immediately after receipt");
  level["B1:B"] += 13;
  await until(() => run.status === "review");
  check(run.progress.archive?.after["B1:B"].length === 4, "all four observed points are saved");
  check(run.progress.matches[0]?.pot === 2 && run.progress.matches[0].sensorKey === "B1:B", "three later readings confirm the rise");
  check(rpcCalls === 1 && commands[0].pot === 2, "only the chosen valve was pulsed");
});
