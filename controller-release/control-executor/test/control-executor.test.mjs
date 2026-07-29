import assert from "node:assert/strict";
import test from "node:test";
import {
  createApiClient,
  createSupabaseRpcClient,
  executeCommand,
  fetchJsonWithTimeout,
  getConfig,
  IndeterminateMutationError,
  reportControllerReadiness,
  assertRuntimeConfig,
  retryDelayMs,
  stripTrailingSlash,
  tick,
} from "../src/control-executor.mjs";

const commandId = "11111111-1111-4111-8111-111111111111";

function apiFixture(overrides = {}) {
  const calls = [];
  const state = overrides.state || "STOPPED";
  const data = {
    pairings: [{ name: "Pot 41", sensorId: 41, valveId: 141 }],
    sensors: [{ id: 41, name: "Sensor 41", boardSerialId: "A", address: 1 }],
    valves: [{ id: 141, name: "Valve 41", relayAddress: 3, address: 7 }],
    groups: [{ id: 1, name: "Bench" }],
    calibrations: [{ id: 9, name: "Cal A" }],
    ...overrides.data,
  };

  return {
    calls,
    api: {
      async get(path) {
        calls.push(["GET", path]);
        if (path === "/system") return { state };
        if (path === "/pairings") return data.pairings;
        if (path === "/sensors") return data.sensors;
        if (path === "/valves") return data.valves;
        if (path === "/groups") return data.groups;
        if (path === "/calibrations") return data.calibrations;
        throw new Error(`Unexpected GET ${path}`);
      },
      async post(path, body) {
        calls.push(["POST", path, body]);
        return { ok: true, path, body };
      },
      async put(path, body) {
        calls.push(["PUT", path, body]);
        return { ok: true, path, body };
      },
      async delete(path) {
        calls.push(["DELETE", path]);
        return { ok: true, path };
      },
    },
  };
}

test("stripTrailingSlash removes only trailing slashes", () => {
  assert.equal(stripTrailingSlash("https://example.test///"), "https://example.test");
});

test("poll retry backoff is bounded", () => {
  assert.equal(retryDelayMs(1, 5000, 60_000), 5000);
  assert.equal(retryDelayMs(2, 5000, 60_000), 10_000);
  assert.equal(retryDelayMs(20, 5000, 60_000), 60_000);
});

test("live startup requires state-sync identity and credentials", () => {
  const baseEnv = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    EXACTH2O_DEVICE_TOKEN: "device-token",
  };
  const dryRunConfig = getConfig(baseEnv);
  assert.equal(dryRunConfig.dryRun, true);
  assert.equal(dryRunConfig.manualWaterEnabled, false);
  assert.equal(dryRunConfig.pollRetryMaxMs, 60_000);
  assert.equal(getConfig({ ...baseEnv, EXACTH2O_MANUAL_WATER_ENABLED: "flase" }).manualWaterEnabled, false);
  assert.equal(getConfig({ ...baseEnv, EXACTH2O_MANUAL_WATER_ENABLED: "off" }).manualWaterEnabled, false);
  assert.equal(getConfig({ ...baseEnv, EXACTH2O_MANUAL_WATER_ENABLED: "1" }).manualWaterEnabled, true);
  assert.doesNotThrow(() => assertRuntimeConfig(dryRunConfig));

  const liveConfig = getConfig({ ...baseEnv, EXACTH2O_CONTROL_EXECUTOR_DRY_RUN: "0" });
  assert.throws(
    () => assertRuntimeConfig(liveConfig),
    /EXACTH2O_PROJECT_ID, EXACTH2O_DEVICE_ID, EXACTH2O_CONTROLLER_COMMAND_SECRET, SYNC_OWNER_HEALTH_SECRET/,
  );
  assert.doesNotThrow(() => assertRuntimeConfig(getConfig({
    ...baseEnv,
    EXACTH2O_CONTROL_EXECUTOR_DRY_RUN: "0",
    EXACTH2O_PROJECT_ID: "project-id",
    EXACTH2O_DEVICE_ID: "device-id",
    EXACTH2O_CONTROLLER_COMMAND_SECRET: "controller-secret",
    SYNC_OWNER_HEALTH_SECRET: "sync-secret",
  })));
});

test("readiness heartbeat reports local controller reachability without mutating it", async () => {
  const fixture = apiFixture({ state: "RUNNING" });
  const statuses = [];
  const result = await reportControllerReadiness({
    api: fixture.api,
    rpc: {
      async reportStatus(status) {
        statuses.push(status);
      },
    },
  });

  assert.deepEqual(result, {
    localApiReachable: true,
    controllerState: "RUNNING",
    lastError: null,
  });
  assert.deepEqual(statuses, [result]);
  assert.deepEqual(fixture.calls, [["GET", "/system"]]);
});

test("readiness heartbeat reports an unreachable local controller", async () => {
  const statuses = [];
  const result = await reportControllerReadiness({
    api: {
      async get() {
        throw new Error("connection refused");
      },
    },
    rpc: {
      async reportStatus(status) {
        statuses.push(status);
      },
    },
  });

  assert.equal(result.localApiReachable, false);
  assert.equal(result.controllerState, null);
  assert.match(result.lastError, /connection refused/);
  assert.deepEqual(statuses, [result]);
});

test("update_pairing maps portal payload to local controller fields", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    {
      command_type: "update_pairing",
      payload: {
        pairing_name: "Pot 41",
        target_vwc: 35,
        open_time_seconds: 12,
        measurement_interval_seconds: 300,
      },
    },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
  );

  assert.deepEqual(result.body, {
    WTCPercentLimit: 35,
    ValveOpenTime: 12000,
    MeasurementInterval: 300000,
  });
  assert.deepEqual(fixture.calls.at(-1), [
    "PUT",
    "/pairings/41/141",
    { WTCPercentLimit: 35, ValveOpenTime: 12000, MeasurementInterval: 300000 },
  ]);
});

test("update_pairing can rename and move a pairing using current inventory", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    {
      command_type: "update_pairing",
      payload: {
        pairing_name: "Pot 41",
        new_name: "Zone1-Pot41",
        group_name: "Bench",
      },
    },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
  );

  assert.deepEqual(result.body, {
    name: "Zone1-Pot41",
    groupId: 1,
  });
  assert.deepEqual(fixture.calls.at(-1), [
    "PUT",
    "/pairings/41/141",
    { name: "Zone1-Pot41", groupId: 1 },
  ]);
});

test("delete_pairing deletes the resolved pair only while stopped", async () => {
  const fixture = apiFixture();
  await executeCommand(
    { command_type: "delete_pairing", payload: { pairing_name: "Pot 41" } },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
  );
  assert.deepEqual(fixture.calls.at(-1), ["DELETE", "/pairings/41/141"]);

  const runningFixture = apiFixture({ state: "RUNNING" });
  await assert.rejects(
    () => executeCommand(
      { command_type: "delete_pairing", payload: { pairing_name: "Pot 41" } },
      { api: runningFixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
    ),
    /requires controller state STOPPED/,
  );
});

test("pairing mutations fail closed when a name is ambiguous", async () => {
  const fixture = apiFixture({
    data: {
      pairings: [
        { name: "Pot 41", sensorId: 41, valveId: 141 },
        { name: "Pot 41", sensorId: 42, valveId: 142 },
      ],
    },
  });
  await assert.rejects(
    () => executeCommand(
      { command_type: "delete_pairing", payload: { pairing_name: "Pot 41" } },
      { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
    ),
    /Pairing name is ambiguous/,
  );
});

test("update_pairing refuses to edit while controller is running", async () => {
  const fixture = apiFixture({ state: "RUNNING" });
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "update_pairing", payload: { pairing_name: "Pot 41", target_vwc: 30 } },
        { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
      ),
    /requires controller state STOPPED/,
  );
});

test("manual_water uses a controller-owned timed pulse by default", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    { id: commandId, command_type: "manual_water", payload: { valve_keys: ["valve 41"], duration_seconds: 0.001 } },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60, manualWaterEnabled: true },
  );

  assert.equal(result.valveCount, 1);
  assert.equal(result.failSafe, "controller_timed_pulse");
  assert.deepEqual(fixture.calls.at(-1), [
    "POST",
    "/valves/pulse",
    {
      address: 7,
      relayAddress: 3,
      durationMilliseconds: 1,
      commandId,
      pulseId: `${commandId}:3:7`,
    },
  ]);
  assert.equal(fixture.calls.some((call) => call[1] === "/valves/operate"), false);
});

test("manual_water accepts portal pairing_names and resolves their valves", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    { id: commandId, command_type: "manual_water", payload: { pairing_names: ["Pot 41"], duration_seconds: 0.001 } },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60, manualWaterEnabled: true },
  );

  assert.equal(result.valveCount, 1);
  assert.deepEqual(fixture.calls.at(-1), [
    "POST",
    "/valves/pulse",
    {
      address: 7,
      relayAddress: 3,
      durationMilliseconds: 1,
      commandId,
      pulseId: `${commandId}:3:7`,
    },
  ]);
});

test("manual_water rejects excessive duration", async () => {
  const fixture = apiFixture();
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "manual_water", payload: { valve_keys: ["valve 41"], duration_seconds: 61 } },
        { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
      ),
    /exceeds max/,
  );
});

test("manual_water stays disabled independently of the global dry-run switch", async () => {
  const fixture = apiFixture();
  await assert.rejects(
    () => executeCommand(
      { id: commandId, command_type: "manual_water", payload: { pairing_names: ["Pot 41"], duration_seconds: 1 } },
      { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60, manualWaterEnabled: false },
    ),
    /disabled until the controller timed-pulse bench protocol is approved/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("manual_water rejects an excessive aggregate valve-seconds budget", async () => {
  const fixture = apiFixture({
    data: {
      pairings: [
        { name: "Pot 41", sensorId: 41, valveId: 141 },
        { name: "Pot 42", sensorId: 42, valveId: 142 },
      ],
      valves: [
        { id: 141, name: "Valve 41", relayAddress: 3, address: 7 },
        { id: 142, name: "Valve 42", relayAddress: 3, address: 8 },
      ],
    },
  });

  await assert.rejects(
    () => executeCommand(
      {
        id: commandId,
        command_type: "manual_water",
        payload: { pairing_names: ["Pot 41", "Pot 42"], duration_seconds: 60 },
      },
      {
        api: fixture.api,
        dryRun: false,
        manualWaterMaxSeconds: 60,
        manualWaterMaxValveSeconds: 100,
        manualWaterEnabled: true,
      },
    ),
    /valve-seconds exceeds max/,
  );
});

test("create_group refuses to edit config while controller is running", async () => {
  const fixture = apiFixture({ state: "RUNNING" });
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "create_group", payload: { group_name: "New group" } },
        { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
      ),
    /requires controller state STOPPED/,
  );
});

test("create_calibration refuses to edit config while controller is running", async () => {
  const fixture = apiFixture({ state: "RUNNING" });
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "create_calibration", payload: { name: "New calibration", points: [] } },
        { api: fixture.api, dryRun: true, manualWaterMaxSeconds: 60 },
      ),
    /requires controller state STOPPED/,
  );
});

test("update_board_config uses the controller API payload shape", async () => {
  const fixture = apiFixture();
  const result = await executeCommand(
    { command_type: "update_board_config", payload: { boards: [{ address: "0x20", reset_pin: 17 }] } },
    { api: fixture.api, dryRun: false, manualWaterMaxSeconds: 60 },
  );

  assert.deepEqual(result.body, {
    boardConfigs: [{ address: 32, resetPin: 17 }],
    updateHardwareService: true,
  });
  assert.deepEqual(fixture.calls.at(-1), [
    "POST",
    "/system/board-configs",
    { boardConfigs: [{ address: 32, resetPin: 17 }], updateHardwareService: true },
  ]);
});

test("initialize_sensors is hard-blocked in the production executor", async () => {
  const fixture = apiFixture();
  await assert.rejects(
    () =>
      executeCommand(
        { command_type: "initialize_sensors", payload: {} },
        { api: fixture.api, dryRun: true, manualWaterMaxSeconds: 60 },
      ),
    /disabled in the production executor/,
  );
});

test("local controller requests abort instead of hanging indefinitely", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const api = createApiClient("http://controller.test/v1", fetchImpl, 5);

  await assert.rejects(() => api.get("/system"), /GET \/system timed out after 5ms/);
});

test("local controller requests carry the dedicated controller command secret", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = createApiClient("http://controller.test/v1", fetchImpl, 1000, "controller-secret");
  await api.post("/valves/pulse", { pulseId: "pulse-1" });
  assert.equal(requests[0].options.headers["x-exacth2o-controller-secret"], "controller-secret");
});

test("the timeout remains active while a response body is being read", async () => {
  const fetchImpl = async (_url, options) => ({
    ok: true,
    async text() {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      });
    },
  });

  await assert.rejects(
    () => fetchJsonWithTimeout(fetchImpl, "https://controller.test", {}, 5, "body read"),
    /body read timed out after 5ms/,
  );
});

test("a timed-out controller mutation is classified as an unknown outcome", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const api = createApiClient("http://controller.test/v1", fetchImpl, 5);

  await assert.rejects(
    () => api.post("/system/state", { state: "STOPPED" }),
    (error) => error instanceof IndeterminateMutationError && /outcome is unknown/.test(error.message),
  );
});

test("server and transport errors after a mutation are quarantined but definite 4xx rejections are not", async () => {
  const serverErrorApi = createApiClient(
    "http://controller.test/v1",
    async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    1000,
  );
  await assert.rejects(
    () => serverErrorApi.post("/system/state", { state: "STOPPED" }),
    IndeterminateMutationError,
  );

  const transportErrorApi = createApiClient(
    "http://controller.test/v1",
    async () => { throw new TypeError("connection reset"); },
    1000,
  );
  await assert.rejects(
    () => transportErrorApi.put("/pairings/1/2", {}),
    IndeterminateMutationError,
  );

  const rejectedApi = createApiClient(
    "http://controller.test/v1",
    async () => new Response(JSON.stringify({ error: "invalid state" }), { status: 400 }),
    1000,
  );
  await assert.rejects(
    () => rejectedApi.post("/system/state", { state: "INVALID" }),
    (error) => !(error instanceof IndeterminateMutationError) && /400 invalid state/.test(error.message),
  );
});

test("tick quarantines an indeterminate mutation without recording a normal failure", async () => {
  const calls = [];
  const rpc = {
    async claim() {
      return { id: commandId, command_type: "update_system_state", payload: { state: "stopped" } };
    },
    async renew() { return true; },
    async complete(...args) { calls.push(["complete", ...args]); },
    async quarantine(...args) { calls.push(["quarantine", ...args]); },
  };
  const api = {
    async post() { throw new IndeterminateMutationError("mutation timed out; outcome is unknown"); },
  };

  await tick({
    rpc,
    api,
    config: {
      dryRun: false,
      commandLeaseRenewMs: 60_000,
      manualWaterMaxSeconds: 60,
      manualWaterMaxValveSeconds: 120,
      manualWaterPulsePath: "/valves/pulse",
    },
  });

  assert.deepEqual(calls, [["quarantine", commandId, "mutation timed out; outcome is unknown"]]);
});

test("tick quarantines a multi-step command after any earlier mutation succeeds", async () => {
  const fixture = apiFixture({
    data: {
      pairings: [
        { name: "Pot 41", sensorId: 41, valveId: 141 },
        { name: "Pot 42", sensorId: 42, valveId: 142 },
      ],
    },
  });
  let putCount = 0;
  fixture.api.put = async (path, body) => {
    fixture.calls.push(["PUT", path, body]);
    putCount += 1;
    if (putCount === 2) throw new Error("second pairing was rejected");
    return { ok: true, path, body };
  };

  const calls = [];
  const rpc = {
    async claim() {
      return {
        id: commandId,
        command_type: "bulk_update_pairings",
        payload: { pairing_names: ["Pot 41", "Pot 42"], target_vwc: 25 },
      };
    },
    async renew() { return true; },
    async complete(...args) { calls.push(["complete", ...args]); },
    async quarantine(...args) { calls.push(["quarantine", ...args]); },
  };

  await tick({
    rpc,
    api: fixture.api,
    config: {
      dryRun: false,
      commandLeaseRenewMs: 60_000,
      manualWaterMaxSeconds: 60,
      manualWaterMaxValveSeconds: 120,
      manualWaterPulsePath: "/valves/pulse",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "quarantine");
  assert.match(calls[0][2], /1 earlier controller mutation/);
});

test("a final-status RPC error is not converted into a contradictory failed completion", async () => {
  const completions = [];
  const rpc = {
    async claim() { return { id: commandId, command_type: "export_data", payload: {} }; },
    async renew() { return true; },
    async quarantine() { throw new Error("unexpected quarantine"); },
    async complete(...args) {
      completions.push(args);
      throw new Error("status response timed out");
    },
  };

  await tick({
    rpc,
    api: {},
    config: {
      dryRun: true,
      commandLeaseRenewMs: 60_000,
      manualWaterMaxSeconds: 60,
      manualWaterMaxValveSeconds: 120,
      manualWaterPulsePath: "/valves/pulse",
    },
  });

  assert.equal(completions.length, 1);
  assert.equal(completions[0][1], "succeeded");
});

test("dry-run controller mutations fail instead of reporting false activation success", async () => {
  const fixture = apiFixture();
  const completions = [];
  const rpc = {
    async claim() {
      return {
        id: commandId,
        command_type: "update_pairing",
        payload: {
          pairing_name: "Pot 41",
          target_vwc: 40,
          open_time_seconds: 2,
          measurement_interval_seconds: 600,
        },
      };
    },
    async renew() { return true; },
    async quarantine() { throw new Error("unexpected quarantine"); },
    async complete(...args) { completions.push(args); },
  };

  await tick({
    rpc,
    api: fixture.api,
    config: {
      dryRun: true,
      commandLeaseRenewMs: 60_000,
      manualWaterMaxSeconds: 60,
      manualWaterMaxValveSeconds: 120,
      manualWaterPulsePath: "/valves/pulse",
    },
  });

  assert.equal(completions.length, 1);
  assert.equal(completions[0][1], "failed");
  assert.equal(completions[0][2].dryRun, true);
  assert.match(completions[0][3], /no controller mutation was applied/);
  assert.equal(fixture.calls.some(([method]) => method === "PUT"), false);
});

test("command lease renewal is authenticated with the device token", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response("true", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rpc = createSupabaseRpcClient({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key",
    deviceToken: "device-token",
    supabaseRpcTimeoutMs: 1000,
  }, fetchImpl);

  assert.equal(await rpc.renew("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(requests[0].url.endsWith("/rpc/device_renew_control_command_lease"), true);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    device_token: "device-token",
    command_id: "11111111-1111-4111-8111-111111111111",
  });
});

test("readiness reports executor mode and required live configuration", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rpc = createSupabaseRpcClient({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key",
    deviceToken: "device-token",
    projectId: "project-id",
    deviceId: "device-id",
    controllerCommandSecret: "controller-secret",
    syncOwnerHealthUrl: "https://example.supabase.co/functions/v1/sync-owner-health",
    syncOwnerHealthSecret: "sync-secret",
    dryRun: false,
    manualWaterEnabled: false,
    supabaseRpcTimeoutMs: 1000,
  }, fetchImpl);

  await rpc.reportStatus({
    localApiReachable: true,
    controllerState: "RUNNING",
    lastError: null,
  });

  assert.equal(
    requests[0].url.endsWith("/rpc/device_report_control_executor_status"),
    true,
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    device_token: "device-token",
    executor_version: "exacth2o-control-executor/0.4.0",
    executor_dry_run: false,
    executor_manual_water_enabled: false,
    executor_sync_ready: true,
    executor_local_api_reachable: true,
    executor_controller_state: "RUNNING",
    executor_last_error: null,
  });
});
