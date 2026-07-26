const VERSION = "exacth2o-control-executor/0.3.1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class IndeterminateMutationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "IndeterminateMutationError";
  }
}

class LeaseLostError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaseLostError";
  }
}

export function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function retryDelayMs(consecutiveFailures, baseMs, maxMs) {
  const exponent = Math.max(0, Math.min(10, Number(consecutiveFailures) - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function boolEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return !["0", "false", "no"].includes(String(value).trim().toLowerCase());
}

function explicitlyEnabledEnv(value) {
  return ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}

function numberEnv(value, defaultValue, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

export function getConfig(env = process.env) {
  return {
    localApiBase: stripTrailingSlash(env.EXACTH2O_LOCAL_API_BASE || env.CONTROL_BRIDGE_API_BASE || "http://api_svc:8888/v1"),
    supabaseUrl: stripTrailingSlash(env.SUPABASE_URL || env.VITE_SUPABASE_URL || ""),
    supabaseAnonKey: env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || "",
    deviceToken: env.EXACTH2O_DEVICE_TOKEN || "",
    projectId: env.EXACTH2O_PROJECT_ID || env.CONTROL_BRIDGE_PROJECT_ID || "",
    deviceId: env.EXACTH2O_DEVICE_ID || env.CONTROL_BRIDGE_DEVICE_ID || "",
    controllerCommandSecret: env.EXACTH2O_CONTROLLER_COMMAND_SECRET || "",
    syncOwnerHealthUrl: stripTrailingSlash(
      env.EXACTH2O_SYNC_OWNER_HEALTH_URL ||
        (env.SUPABASE_URL ? `${stripTrailingSlash(env.SUPABASE_URL)}/functions/v1/sync-owner-health` : ""),
    ),
    syncOwnerHealthSecret: env.SYNC_OWNER_HEALTH_SECRET || env.EXACTH2O_SYNC_OWNER_HEALTH_SECRET || "",
    pollMs: numberEnv(env.EXACTH2O_CONTROL_EXECUTOR_POLL_MS || env.CONTROL_BRIDGE_POLL_INTERVAL_MS, 5000, 1000, 60000),
    localApiTimeoutMs: numberEnv(env.EXACTH2O_LOCAL_API_TIMEOUT_MS, 10_000, 1000, 60_000),
    supabaseRpcTimeoutMs: numberEnv(env.EXACTH2O_SUPABASE_RPC_TIMEOUT_MS, 15_000, 1000, 60_000),
    pollRetryMaxMs: numberEnv(env.EXACTH2O_CONTROL_EXECUTOR_RETRY_MAX_MS, 60_000, 5000, 15 * 60_000),
    commandLeaseRenewMs: numberEnv(env.EXACTH2O_COMMAND_LEASE_RENEW_MS, 30_000, 10_000, 60_000),
    dryRun: boolEnv(env.EXACTH2O_CONTROL_EXECUTOR_DRY_RUN, true),
    manualWaterEnabled: explicitlyEnabledEnv(env.EXACTH2O_MANUAL_WATER_ENABLED),
    manualWaterMaxSeconds: numberEnv(
      env.EXACTH2O_MANUAL_WATER_MAX_SECONDS || env.CONTROL_BRIDGE_MANUAL_WATER_MAX_SECONDS,
      60,
      1,
      60,
    ),
    manualWaterMaxValveSeconds: numberEnv(env.EXACTH2O_MANUAL_WATER_MAX_VALVE_SECONDS, 120, 1, 120),
    manualWaterPulsePath: env.EXACTH2O_MANUAL_WATER_PULSE_PATH || "/valves/pulse",
    stateSyncMs: numberEnv(env.EXACTH2O_STATE_SYNC_MS, 120_000, 60_000, 15 * 60_000),
    stateSyncTimeoutMs: numberEnv(env.EXACTH2O_STATE_SYNC_TIMEOUT_MS, 30_000, 5000, 60_000),
    runOnce: boolEnv(env.EXACTH2O_RUN_ONCE, false),
  };
}

export function assertRuntimeConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
  if (!config.deviceToken) missing.push("EXACTH2O_DEVICE_TOKEN");
  if (!config.dryRun) {
    if (!config.projectId) missing.push("EXACTH2O_PROJECT_ID");
    if (!config.deviceId) missing.push("EXACTH2O_DEVICE_ID");
    if (!config.syncOwnerHealthUrl) missing.push("EXACTH2O_SYNC_OWNER_HEALTH_URL");
    if (!config.syncOwnerHealthSecret) missing.push("SYNC_OWNER_HEALTH_SECRET");
  }
  if (config.manualWaterEnabled && !config.controllerCommandSecret) {
    missing.push("EXACTH2O_CONTROLLER_COMMAND_SECRET");
  }
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
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (response.ok) throw error;
      body = text;
    }
  }
  if (!response.ok) {
    const message = body?.message || body?.error || text || response.statusText;
    const responseError = new Error(`${context} failed: ${response.status} ${message}`);
    responseError.code = "HTTP_ERROR";
    responseError.status = response.status;
    throw responseError;
  }
  return body;
}

export async function fetchJsonWithTimeout(fetchImpl, url, options, timeoutMs, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
    return await readJson(response, context);
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${context} timed out after ${timeoutMs}ms`);
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createApiClient(localApiBase, fetchImpl = globalThis.fetch, timeoutMs = 10_000, controllerCommandSecret = "") {
  async function request(method, path, body) {
    const context = `${method} ${path}`;
    try {
      return await fetchJsonWithTimeout(
        fetchImpl,
        `${localApiBase}${path}`,
        {
          method,
          headers: {
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(controllerCommandSecret ? { "x-exacth2o-controller-secret": controllerCommandSecret } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        timeoutMs,
        context,
      );
    } catch (error) {
      const indeterminateMutation = method !== "GET" && (
        error?.code === "REQUEST_TIMEOUT" ||
        error?.code !== "HTTP_ERROR" ||
        Number(error?.status) >= 500
      );
      if (indeterminateMutation) {
        throw new IndeterminateMutationError(
          `${context} did not return a definite rejection; controller outcome is unknown and must be reconciled`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),
  };
}

export function createSupabaseRpcClient(config, fetchImpl = globalThis.fetch) {
  async function rpc(name, body) {
    const context = `RPC ${name}`;
    return fetchJsonWithTimeout(
      fetchImpl,
      `${config.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          apikey: config.supabaseAnonKey,
          authorization: `Bearer ${config.supabaseAnonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      config.supabaseRpcTimeoutMs,
      context,
    );
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
    async renew(commandId) {
      const renewed = await rpc("device_renew_control_command_lease", {
        device_token: config.deviceToken,
        command_id: commandId,
      });
      if (renewed !== true) throw new Error("Command lease is no longer renewable");
      return true;
    },
    async quarantine(commandId, reason) {
      return rpc("device_quarantine_control_command", {
        device_token: config.deviceToken,
        command_id: commandId,
        quarantine_reason: reason,
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

function itemId(item) {
  return firstDefined(item?.id, item?.Id);
}

function sameId(a, b) {
  const left = firstDefined(a);
  const right = firstDefined(b);
  return left !== undefined && right !== undefined && String(left) === String(right);
}

function findByName(items, wanted, label, nameFn = (item) => firstDefined(item?.name, item?.Name, item?.id)) {
  const target = normalizeKey(wanted);
  const match = items.find((item) => normalizeKey(nameFn(item)) === target);
  if (!match) throw new Error(`${label} not found: ${wanted}`);
  return match;
}

function resolvePairing(index, name) {
  const target = normalizeKey(name);
  const matches = index.pairings.filter((item) => normalizeKey(pairName(item)) === target);
  if (matches.length === 0) throw new Error(`Pairing not found: ${name}`);
  if (matches.length > 1) throw new Error(`Pairing name is ambiguous: ${name}`);
  return matches[0];
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

function resolvePairingValve(index, pairing) {
  const nestedValve = pairing?.valve || pairing?.Valve;
  if (nestedValve && firstDefined(nestedValve.address, nestedValve.Address) !== undefined) return nestedValve;

  const valveId = firstDefined(pairing?.valveId, pairing?.ValveId, nestedValve?.id, nestedValve?.Id);
  const valve = index.valves.find((candidate) => sameId(itemId(candidate), valveId));
  if (!valve) throw new Error(`Valve not found for pairing: ${pairName(pairing) || "unknown"}`);
  return valve;
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

function valveIdentity(valve) {
  const body = valveOperationBody(valve, "IDENTITY");
  return `${body.relayAddress}:${body.address}`;
}

function resolveManualWaterValves(index, payload) {
  const valves = [];
  for (const name of asArray(payload.pairing_names)) {
    valves.push(resolvePairingValve(index, resolvePairing(index, name)));
  }
  for (const key of asArray(payload.valve_keys || payload.valves)) {
    valves.push(resolveValve(index, key));
  }

  const deduped = [];
  const seen = new Set();
  for (const valve of valves) {
    const identity = valveIdentity(valve);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(valve);
  }
  return deduped;
}

async function pulseValve(api, valve, durationSeconds, pulsePath, dryRun, commandId) {
  const identity = valveOperationBody(valve, "PULSE");
  const body = {
    address: identity.address,
    relayAddress: identity.relayAddress,
    durationMilliseconds: Math.round(durationSeconds * 1000),
    commandId,
    pulseId: `${commandId}:${identity.relayAddress}:${identity.address}`,
  };
  if (dryRun) return { dryRun: true, body };
  return api.post(pulsePath, body);
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
    if (payload.new_name) {
      const duplicate = index.pairings.find((candidate) => {
        const candidateIds = pairingIds(candidate);
        return (
          normalizeKey(pairName(candidate)) === normalizeKey(payload.new_name) &&
          !(sameId(candidateIds.sensorId, ids.sensorId) && sameId(candidateIds.valveId, ids.valveId))
        );
      });
      if (duplicate) throw new Error(`Pairing name already exists: ${payload.new_name}`);
      patch.name = payload.new_name;
    }
    if (payload.group_name) patch.groupId = itemId(resolveGroup(index, payload.group_name));
    if (dryRun) return { dryRun, action: "update_pairing", ids, patch };
    return api.put(`/pairings/${encodeURIComponent(ids.sensorId)}/${encodeURIComponent(ids.valveId)}`, patch);
  }

  if (command.command_type === "bulk_update_pairings") {
    await requireStopped(api, "bulk_update_pairings");
    const index = await loadControllerIndex(api);
    const patch = localPairingPatch(payload);
    if (payload.group_name) patch.groupId = itemId(resolveGroup(index, payload.group_name));
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
    if (index.pairings.some((item) => normalizeKey(pairName(item)) === normalizeKey(payload.name))) {
      throw new Error(`Pairing name already exists: ${payload.name}`);
    }
    const group = payload.group_name ? resolveGroup(index, payload.group_name) : null;
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

  if (command.command_type === "delete_pairing") {
    await requireStopped(api, "delete_pairing");
    const index = await loadControllerIndex(api);
    const ids = pairingIds(resolvePairing(index, payload.pairing_name));
    if (dryRun) return { dryRun, action: "delete_pairing", ids };
    return api.delete(`/pairings/${encodeURIComponent(ids.sensorId)}/${encodeURIComponent(ids.valveId)}`);
  }

  if (command.command_type === "create_group") {
    await requireStopped(api, "create_group");
    const body = {
      name: payload.group_name,
      type: payload.group_type === "none" ? "" : payload.group_type,
    };
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
    await requireStopped(api, "create_calibration");
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
    if (!dryRun && options.manualWaterEnabled !== true) {
      throw new Error("manual_water is disabled until the controller timed-pulse bench protocol is approved");
    }

    const index = await loadControllerIndex(api);
    const valves = resolveManualWaterValves(index, payload);
    if (valves.length === 0) throw new Error("manual_water requires at least one pairing_name or valve");
    const totalValveSeconds = durationSeconds * valves.length;
    const maxValveSeconds = options.manualWaterMaxValveSeconds ?? 120;
    if (totalValveSeconds > maxValveSeconds) {
      throw new Error(`manual_water budget ${totalValveSeconds} valve-seconds exceeds max ${maxValveSeconds}`);
    }

    const pulsePath = options.manualWaterPulsePath || "/valves/pulse";
    const pulseCommandId = command.id || (dryRun ? "dry-run" : null);
    if (!pulseCommandId) throw new Error("manual_water requires a command id for idempotent timed pulses");
    const pulses = [];
    for (const valve of valves) {
      pulses.push(await pulseValve(api, valve, durationSeconds, pulsePath, dryRun, pulseCommandId));
      if (!dryRun) await sleep(durationSeconds * 1000);
    }
    return {
      dryRun,
      action: "manual_water",
      failSafe: "controller_timed_pulse",
      durationSeconds,
      totalValveSeconds,
      valveCount: valves.length,
      pulses,
    };
  }

  if (command.command_type === "update_board_config") {
    await requireStopped(api, "update_board_config");
    const boards = Array.isArray(payload.boards) ? payload.boards : [];
    const boardConfigs = boards.map((board) => {
      const normalized = {
        ...board,
        address: boardAddress(board.address),
        resetPin: firstDefined(board.resetPin, board.reset_pin),
      };
      delete normalized.reset_pin;
      return normalized;
    });
    if (boardConfigs.length === 0) throw new Error("update_board_config requires boards");
    const body = { boardConfigs, updateHardwareService: true };
    if (dryRun) return { dryRun, action: "update_board_config", body };
    return api.post("/system/board-configs", body);
  }

  if (command.command_type === "initialize_sensors") {
    throw new Error("initialize_sensors is disabled in the production executor");
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

const syncAfterCommandTypes = new Set([
  "update_pairing",
  "bulk_update_pairings",
  "create_pairing",
  "delete_pairing",
  "create_group",
  "remove_group",
  "create_calibration",
  "delete_calibration",
  "apply_calibration",
  "manual_water",
  "update_board_config",
  "initialize_sensors",
  "update_system_state",
]);

async function refreshOwnerHealthMirror(command, config, fetchImpl = globalThis.fetch) {
  if (command && config.dryRun) return { skipped: true, reason: "dry_run" };
  if (command && !syncAfterCommandTypes.has(command.command_type)) return { skipped: true, reason: "command_type" };
  if (!config.syncOwnerHealthUrl || !config.syncOwnerHealthSecret) {
    return { skipped: true, reason: "missing_sync_owner_health_config" };
  }

  const projectId = command?.project_id || config.projectId;
  const deviceId = command?.device_id || config.deviceId;
  if (!projectId || !deviceId) return { skipped: true, reason: "missing_project_or_device_id" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.stateSyncTimeoutMs);
  try {
    const response = await fetchImpl(config.syncOwnerHealthUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.syncOwnerHealthSecret}`,
        "x-sync-owner-health-secret": config.syncOwnerHealthSecret,
      },
      body: JSON.stringify({
        project_id: projectId,
        device_id: deviceId,
        source: command ? "control_executor" : "control_executor_watchdog",
        include_config: Boolean(command),
      }),
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 500);
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function tick({ rpc, api, config }) {
  const command = await rpc.claim();
  if (!command) return false;

  let leaseRenewalInFlight = false;
  let leaseLost = false;
  let successfulMutations = 0;
  const assertLease = () => {
    if (leaseLost) throw new LeaseLostError("Command lease renewal failed; stopping before the next controller operation");
  };
  const leasedApi = {
    get: (...args) => {
      assertLease();
      return api.get(...args);
    },
    post: async (...args) => {
      assertLease();
      const result = await api.post(...args);
      successfulMutations += 1;
      return result;
    },
    put: async (...args) => {
      assertLease();
      const result = await api.put(...args);
      successfulMutations += 1;
      return result;
    },
    delete: async (...args) => {
      assertLease();
      const result = await api.delete(...args);
      successfulMutations += 1;
      return result;
    },
  };
  const leaseTimer = setInterval(async () => {
    if (leaseRenewalInFlight) return;
    leaseRenewalInFlight = true;
    try {
      await rpc.renew(command.id);
    } catch (error) {
      leaseLost = true;
      console.error("Command lease renewal failed", { id: command.id, error: error.message });
    } finally {
      leaseRenewalInFlight = false;
    }
  }, config.commandLeaseRenewMs);

  let finalStatus = "succeeded";
  let finalResult = {};
  let finalError = null;
  let quarantineReason = null;

  try {
    const result = await executeCommand(command, {
      api: leasedApi,
      dryRun: config.dryRun,
      manualWaterMaxSeconds: config.manualWaterMaxSeconds,
      manualWaterMaxValveSeconds: config.manualWaterMaxValveSeconds,
      manualWaterPulsePath: config.manualWaterPulsePath,
      manualWaterEnabled: config.manualWaterEnabled,
    });
    assertLease();
    const postCommandSync = await refreshOwnerHealthMirror(command, config);
    if (!config.dryRun && syncAfterCommandTypes.has(command.command_type) && postCommandSync.ok !== true) {
      throw new IndeterminateMutationError(
        `post-command controller readback failed; outcome is quarantined until authoritative state is reconciled`,
      );
    }
    finalResult = { ...result, post_command_sync: postCommandSync, executor_version: VERSION };
  } catch (error) {
    finalStatus = "failed";
    finalResult = { executor_version: VERSION, dryRun: config.dryRun };
    finalError = error.message;
    if (
      error instanceof IndeterminateMutationError ||
      error instanceof LeaseLostError ||
      leaseLost ||
      successfulMutations > 0
    ) {
      quarantineReason = successfulMutations > 0
        ? `${error.message}; ${successfulMutations} earlier controller mutation(s) may already be applied`
        : error.message;
    }
  } finally {
    clearInterval(leaseTimer);
  }

  if (quarantineReason) {
    try {
      await rpc.quarantine(command.id, quarantineReason);
    } catch (error) {
      console.error("Could not record command quarantine; lease expiry remains the fail-closed backstop", {
        id: command.id,
        error: error.message,
      });
    }
    console.error("Quarantined command after indeterminate controller outcome", {
      id: command.id,
      type: command.command_type,
      error: quarantineReason,
    });
    return true;
  }

  try {
    await rpc.complete(command.id, finalStatus, finalResult, finalError);
  } catch (error) {
    console.error("Could not record final command status; command lease remains the fail-closed backstop", {
      id: command.id,
      intendedStatus: finalStatus,
      error: error.message,
    });
    return true;
  }

  if (finalStatus === "succeeded") {
    console.log("Completed command", { id: command.id, type: command.command_type, dryRun: config.dryRun });
  } else {
    console.error("Failed command", { id: command.id, type: command.command_type, error: finalError });
  }

  return true;
}

async function main() {
  const config = getConfig();
  assertRuntimeConfig(config);

  const api = createApiClient(
    config.localApiBase,
    globalThis.fetch,
    config.localApiTimeoutMs,
    config.controllerCommandSecret,
  );
  const rpc = createSupabaseRpcClient(config);
  console.log("Starting ExactH2O control executor", {
    version: VERSION,
    localApiBase: config.localApiBase,
    pollMs: config.pollMs,
    dryRun: config.dryRun,
    stateSyncMs: config.stateSyncMs,
    manualWaterMode: "controller_timed_pulse_only",
    manualWaterEnabled: config.manualWaterEnabled,
  });

  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });

  let nextStateSyncAt = 0;
  let consecutivePollFailures = 0;
  do {
    try {
      const processedCommand = await tick({ rpc, api, config });
      consecutivePollFailures = 0;
      if (processedCommand) nextStateSyncAt = Date.now() + config.stateSyncMs;
      if (Date.now() >= nextStateSyncAt) {
        const syncResult = await refreshOwnerHealthMirror(null, config);
        if (syncResult?.ok === false) console.error("State mirror watchdog failed", syncResult);
        nextStateSyncAt = Date.now() + config.stateSyncMs;
      }
    } catch (error) {
      if (config.runOnce) throw error;
      consecutivePollFailures += 1;
      const retryMs = retryDelayMs(consecutivePollFailures, config.pollMs, config.pollRetryMaxMs);
      console.error("Control executor poll failed; staying fail-closed and retrying", {
        error: error.message,
        consecutiveFailures: consecutivePollFailures,
        retryMs,
        dryRun: config.dryRun,
        manualWaterEnabled: config.manualWaterEnabled,
      });
      if (!stopping) await sleep(retryMs);
      continue;
    }
    if (!config.runOnce && !stopping) await sleep(config.pollMs);
  } while (!config.runOnce && !stopping);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
