const VERSION = "exacth2o-control-executor/0.1.0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function boolEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return !["0", "false", "no"].includes(String(value).trim().toLowerCase());
}

function numberEnv(value, defaultValue, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

function getConfig(env = process.env) {
  return {
    localApiBase: stripTrailingSlash(env.EXACTH2O_LOCAL_API_BASE || "http://api_svc:8888/v1"),
    supabaseUrl: stripTrailingSlash(env.SUPABASE_URL || env.VITE_SUPABASE_URL || ""),
    supabaseAnonKey: env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || "",
    deviceToken: env.EXACTH2O_DEVICE_TOKEN || "",
    pollMs: numberEnv(env.EXACTH2O_CONTROL_EXECUTOR_POLL_MS, 5000, 1000, 60000),
    dryRun: boolEnv(env.EXACTH2O_CONTROL_EXECUTOR_DRY_RUN, true),
    manualWaterMaxSeconds: numberEnv(env.EXACTH2O_MANUAL_WATER_MAX_SECONDS, 60, 1, 300),
    runOnce: boolEnv(env.EXACTH2O_RUN_ONCE, false),
  };
}

function assertRuntimeConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
  if (!config.deviceToken) missing.push("EXACTH2O_DEVICE_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function ensureObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function readJson(response, context) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.message || body?.error || text || response.statusText;
    throw new Error(`${context} failed: ${response.status} ${message}`);
  }
  return body;
}

export function createApiClient(localApiBase, fetchImpl = globalThis.fetch) {
  async function request(method, path, body) {
    const response = await fetchImpl(`${localApiBase}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return readJson(response, `${method} ${path}`);
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),
  };
}

function createSupabaseRpcClient(config, fetchImpl = globalThis.fetch) {
  async function rpc(name, body) {
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        authorization: `Bearer ${config.supabaseAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return readJson(response, `RPC ${name}`);
  }

  return {
    async claim() {
      const rows = await rpc("device_claim_control_command", {
        device_token: config.deviceToken,
        executor_version: VERSION,
      });
      return Array.isArray(rows) ? rows[0] || null : rows || null;
    },
    async complete(commandId, finalStatus, result, error) {
      return rpc("device_complete_control_command", {
        device_token: config.deviceToken,
        command_id: commandId,
        final_status: finalStatus,
        command_result: result || {},
        command_error: error || null,
      });
    },
  };
}

async function loadControllerIndex(api) {
  const [pairings, sensors, valves, groups, calibrations] = await Promise.all([
    api.get("/pairings"),
    api.get("/sensors"),
    api.get("/valves"),
    api.get("/groups"),
    api.get("/calibrations"),
  ]);

  return {
    pairings: asArray(pairings),
    sensors: asArray(sensors),
    valves: asArray(valves),
    groups: asArray(groups),
    calibrations: asArray(calibrations),
  };
}

async function requireStopped(api, action) {
  const system = await api.get("/system");
  const state = system?.state || system?.systemState || system?.Status || "";
  if (String(state).toUpperCase() !== "STOPPED") {
    throw new Error(`${action} requires controller state STOPPED; current state is ${state || "unknown"}`);
  }
  return system;
}

function pairName(pairing) {
  return firstDefined(pairing?.name, pairing?.Name, pairing?.pairingName, pairing?.sensor?.name);
}

function sensorKeys(sensor) {
  return [
    sensor?.key,
    sensor?.id,
    sensor?.Id,
    sensor?.name,
    sensor?.Name,
    `${firstDefined(sensor?.boardSerialId, sensor?.BoardSerialId, "")}:${firstDefined(sensor?.address, sensor?.Address, "")}`,
  ].map(normalizeKey).filter(Boolean);
}

function valveKeys(valve) {
  return [
    valve?.key,
    valve?.id,
    valve?.Id,
    valve?.name,
    valve?.Name,
    `${firstDefined(valve?.relayAddress, valve?.RelayAddress, "")}:${firstDefined(valve?.address, valve?.Address, "")}`,
  ].map(normalizeKey).filter(Boolean);
}

function findByName(items, wanted, label, nameFn = (item) => firstDefined(item?.name, item?.Name, item?.id)) {
  const target = normalizeKey(wanted);
  const match = items.find((item) => normalizeKey(nameFn(item)) === target);
  if (!match) throw new Error(`${label} not found: ${wanted}`);
  return match;
}

function resolvePairing(index, name) {
  return findByName(index.pairings, name, "Pairing", pairName);
}

function resolveSensor(index, key) {
  const target = normalizeKey(key);
  const match = index.sensors.find((sensor) => sensorKeys(sensor).includes(target));
  if (!match) throw new Error(`Sensor not found: ${key}`);
  return match;
}

function resolveValve(index, key) {
  const target = normalizeKey(key);
  const match = index.valves.find((valve) => valveKeys(valve).includes(target));
  if (!match) throw new Error(`Valve not found: ${key}`);
  return match;
}

function resolveGroup(index, name) {
  return findByName(index.groups, name, "Group");
}

function resolveCalibration(index, name) {
  return findByName(index.calibrations, name, "Calibration");
}

function pairingIds(pairing) {
  const sensorId = firstDefined(pairing.sensorId, pairing.SensorId, pairing.sensor?.id, pairing.sensor?.Id);
  const valveId = firstDefined(pairing.valveId, pairing.ValveId, pairing.valve?.id, pairing.valve?.Id);
  if (sensorId === undefined || valveId === undefined) {
    throw new Error(`Pairing is missing sensor/valve ids: ${pairName(pairing) || "unknown"}`);
  }
  return { sensorId, valveId };
}

function localPairingPatch(payload) {
  const patch = {};
  if ("target_vwc" in payload) patch.WTCPercentLimit = payload.target_vwc;
  if ("disable_watering" in payload && payload.disable_watering === true) patch.WTCPercentLimit = -999999;
  if ("open_time_seconds" in payload) patch.ValveOpenTime = Math.round(Number(payload.open_time_seconds) * 1000);
  if ("measurement_interval_seconds" in payload) {
    patch.MeasurementInterval = Math.round(Number(payload.measurement_interval_seconds) * 1000);
  }
  return patch;
}

function valveOperationBody(valve, operation) {
  const address = firstDefined(valve.address, valve.Address);
  const relayAddress = firstDefined(valve.relayAddress, valve.RelayAddress);
  if (address === undefined || relayAddress === undefined) {
    throw new Error(`Valve is missing address/relayAddress: ${firstDefined(valve.name, valve.id, "unknown")}`);
  }
  return { address, relayAddress, operation };
}

async function operateValve(api, valve, operation, dryRun) {
  const body = valveOperationBody(valve, operation);
  if (dryRun) return { dryRun: true, body };
  return api.post("/valves/operate", body);
}

async function closeValveQuietly(api, valve) {
  try {
    await operateValve(api, valve, "CLOSE", false);
  } catch (error) {
    console.error("Valve close failed", {
      valve: firstDefined(valve?.name, valve?.id, valve?.address),
      error: error.message,
    });
  }
}

function boardAddress(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().startsWith("0x")) return Number.parseInt(value, 16);
  if (typeof value === "string") return Number.parseInt(value, 10);
  return value;
}

function calibrationPayload(payload) {
  const points = Array.isArray(payload.points) ? payload.points : [];
  const coefficients = payload.function_text || payload.polynomial_coefficients || payload.coefficients || "";
  return {
    name: payload.name,
    polynomialCoefficientsCommaDelimited: String(coefficients),
    readingsJSONString: JSON.stringify(points),
  };
}

export async function executeCommand(command, options) {
  const api = options.api;
  const dryRun = options.dryRun;
  const manualWaterMaxSeconds = options.manualWaterMaxSeconds;
  const payload = ensureObject(command.payload || {}, "payload");

  if (command.command_type === "export_data") {
    return { skipped: true, reason: "export_data is handled by the portal download path" };
  }

  if (command.command_type === "update_pairing") {
    await requireStopped(api, "update_pairing");
    const index = await loadControllerIndex(api);
    const pairing = resolvePairing(index, payload.pairing_name);
    const ids = pairingIds(pairing);
    const patch = localPairingPatch(payload);
    if (dryRun) return { dryRun, action: "update_pairing", ids, patch };
    return api.put(`/pairings/${encodeURIComponent(ids.sensorId)}/${encodeURIComponent(ids.valveId)}`, patch);
  }

  if (command.command_type === "bulk_update_pairings") {
    await requireStopped(api, "bulk_update_pairings");
    const index = await loadControllerIndex(api);
    const patch = localPairingPatch(payload);
    const results = [];
    for (const name of payload.pairing_names || []) {
      const ids = pairingIds(resolvePairing(index, name));
      results.push({ name, ids, patch });
      if (!dryRun) {
        await api.put(`/pairings/${encodeURIComponent(ids.sensorId)}/${encodeURIComponent(ids.valveId)}`, patch);
      }
    }
    return { dryRun, action: "bulk_update_pairings", results };
  }

  if (command.command_type === "create_pairing") {
    await requireStopped(api, "create_pairing");
    const index = await loadControllerIndex(api);
    const sensor = resolveSensor(index, payload.sensor_key);
    const valve = resolveValve(index, payload.valve_key);
    let group = payload.group_name ? index.groups.find((item) => normalizeKey(item.name || item.Name) === normalizeKey(payload.group_name)) : null;
    if (!group && payload.group_name && !dryRun) {
      group = await api.post("/groups", { name: payload.group_name });
    }
    const body = {
      name: payload.name,
      sensorId: firstDefined(sensor.id, sensor.Id),
      valveId: firstDefined(valve.id, valve.Id),
      groupId: firstDefined(group?.id, group?.Id, null),
      ...localPairingPatch(payload),
    };
    if (dryRun) return { dryRun, action: "create_pairing", body };
    return api.post("/pairings", body);
  }

  if (command.command_type === "create_group") {
    const body = { name: payload.group_name };
    if (dryRun) return { dryRun, action: "create_group", body };
    return api.post("/groups", body);
  }

  if (command.command_type === "remove_group") {
    await requireStopped(api, "remove_group");
    const index = await loadControllerIndex(api);
    const group = resolveGroup(index, payload.group_name);
    const groupId = firstDefined(group.id, group.Id);
    if (dryRun) return { dryRun, action: "remove_group", groupId };
    return api.delete(`/groups/${encodeURIComponent(groupId)}`);
  }

  if (command.command_type === "create_calibration") {
    const body = calibrationPayload(payload);
    if (dryRun) return { dryRun, action: "create_calibration", body };
    return api.post("/calibrations", body);
  }

  if (command.command_type === "delete_calibration") {
    await requireStopped(api, "delete_calibration");
    const index = await loadControllerIndex(api);
    const calibration = resolveCalibration(index, payload.calibration_name);
    const calibrationId = firstDefined(calibration.id, calibration.Id);
    if (dryRun) return { dryRun, action: "delete_calibration", calibrationId };
    return api.delete(`/calibrations/${encodeURIComponent(calibrationId)}`);
  }

  if (command.command_type === "apply_calibration") {
    await requireStopped(api, "apply_calibration");
    const index = await loadControllerIndex(api);
    const calibration = resolveCalibration(index, payload.calibration_name);
    const calibrationId = firstDefined(calibration.id, calibration.Id);
    const results = [];
    for (const name of payload.pairing_names || []) {
      const ids = pairingIds(resolvePairing(index, name));
      const patch = { calibrationId };
      results.push({ name, ids, patch });
      if (!dryRun) {
        await api.put(`/pairings/${encodeURIComponent(ids.sensorId)}/${encodeURIComponent(ids.valveId)}`, patch);
      }
    }
    return { dryRun, action: "apply_calibration", results };
  }

  if (command.command_type === "manual_water") {
    const durationSeconds = Number(payload.duration_seconds || payload.seconds || 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("manual_water requires a positive duration_seconds");
    }
    if (durationSeconds > manualWaterMaxSeconds) {
      throw new Error(`manual_water duration ${durationSeconds}s exceeds max ${manualWaterMaxSeconds}s`);
    }

    const index = await loadControllerIndex(api);
    const keys = payload.valve_keys || payload.valves || [];
    const valves = keys.map((key) => resolveValve(index, key));
    if (valves.length === 0) throw new Error("manual_water requires at least one valve");

    const opened = [];
    try {
      for (const valve of valves) {
        await operateValve(api, valve, "OPEN", dryRun);
        opened.push(valve);
      }
      if (!dryRun) await sleep(durationSeconds * 1000);
      return {
        dryRun,
        action: "manual_water",
        durationSeconds,
        valveCount: valves.length,
      };
    } finally {
      if (!dryRun) {
        await Promise.all(opened.map((valve) => closeValveQuietly(api, valve)));
      }
    }
  }

  if (command.command_type === "update_board_config") {
    await requireStopped(api, "update_board_config");
    const boards = Array.isArray(payload.boards) ? payload.boards : [];
    const body = boards.map((board) => ({
      ...board,
      address: boardAddress(board.address),
    }));
    if (body.length === 0) throw new Error("update_board_config requires boards");
    if (dryRun) return { dryRun, action: "update_board_config", body };
    return api.post("/system/board-configs", body);
  }

  if (command.command_type === "initialize_sensors") {
    await requireStopped(api, "initialize_sensors");
    if (payload.allow_initialize_sensors !== true) {
      throw new Error("initialize_sensors blocked: payload.allow_initialize_sensors must be true after backup/admin approval");
    }
    if (dryRun) return { dryRun, action: "initialize_sensors" };
    return api.post("/system/initialize-sensors", {});
  }

  if (command.command_type === "update_system_state") {
    const desired = String(payload.state || "").trim().toLowerCase();
    const state = desired === "running" || desired === "run" ? "RUNNING" : desired === "stopped" || desired === "stop" ? "STOPPED" : "";
    if (!state) throw new Error(`Unsupported system state: ${payload.state}`);
    if (dryRun) return { dryRun, action: "update_system_state", state };
    return api.post("/system/state", { state });
  }

  throw new Error(`Unsupported command_type: ${command.command_type}`);
}

async function tick({ rpc, api, config }) {
  const command = await rpc.claim();
  if (!command) return false;

  try {
    const result = await executeCommand(command, {
      api,
      dryRun: config.dryRun,
      manualWaterMaxSeconds: config.manualWaterMaxSeconds,
    });
    await rpc.complete(command.id, "succeeded", { ...result, executor_version: VERSION }, null);
    console.log("Completed command", { id: command.id, type: command.command_type, dryRun: config.dryRun });
  } catch (error) {
    await rpc.complete(command.id, "failed", { executor_version: VERSION, dryRun: config.dryRun }, error.message);
    console.error("Failed command", { id: command.id, type: command.command_type, error: error.message });
  }

  return true;
}

async function main() {
  const config = getConfig();
  assertRuntimeConfig(config);

  const api = createApiClient(config.localApiBase);
  const rpc = createSupabaseRpcClient(config);
  console.log("Starting ExactH2O control executor", {
    version: VERSION,
    localApiBase: config.localApiBase,
    pollMs: config.pollMs,
    dryRun: config.dryRun,
  });

  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });

  do {
    await tick({ rpc, api, config });
    if (!config.runOnce && !stopping) await sleep(config.pollMs);
  } while (!config.runOnce && !stopping);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
