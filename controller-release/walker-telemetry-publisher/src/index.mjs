import { readFile } from "node:fs/promises";
import {
  initializeObserverState,
  normalizeSensorResponse,
  publishObservationBatch,
  publisherEnvelope,
  replayPendingBatch,
  retryBounded,
  walkerSensorCatalog,
} from "./publisher-core.mjs";
import { FileCursorStore, FileHealthStore } from "./state-store.mjs";

const requiredIdentity = "walker-pi5-a1c4ace2";

function required(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function secret(name) {
  const file = (process.env[`${name}_FILE`] ?? "").trim();
  if (file) return (await readFile(file, "utf8")).trim();
  return required(name);
}

function positiveInteger(name, fallback, maximum) {
  const raw = (process.env[name] ?? "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

const publisherInstance = required("WALKER_TELEMETRY_PUBLISHER_INSTANCE");
if (publisherInstance !== requiredIdentity) {
  throw new Error(`Publisher identity must be ${requiredIdentity}`);
}
const receiverUrl = new URL(required("WALKER_TELEMETRY_RECEIVER_URL"));
if (
  receiverUrl.protocol !== "https:" ||
  receiverUrl.pathname !== "/functions/v1/receive-walker-telemetry"
) {
  throw new Error("Receiver must be the HTTPS Walker telemetry Edge Function");
}
const sensorReadUrl = new URL(required("WALKER_SENSOR_READ_URL"));
if (
  sensorReadUrl.protocol !== "http:" ||
  sensorReadUrl.hostname !== "cron_svc" ||
  sensorReadUrl.port !== "3000" ||
  sensorReadUrl.pathname !== "/v1/sensors" ||
  sensorReadUrl.search ||
  sensorReadUrl.hash
) {
  throw new Error("Sensor source must be the internal Walker sensing-only route");
}
const controllerStateUrl = new URL("/v1/state", sensorReadUrl.origin);
const receiverSecret = await secret("WALKER_TELEMETRY_PUBLISH_SECRET");
const bootstrapCursor = positiveInteger(
  "WALKER_TELEMETRY_BOOTSTRAP_CURSOR",
  1_518_645,
  Number.MAX_SAFE_INTEGER,
);
const scanIntervalMs = positiveInteger(
  "WALKER_SENSOR_SCAN_INTERVAL_MS",
  600_000,
  3_600_000,
);
const heartbeatMs = positiveInteger(
  "WALKER_TELEMETRY_HEARTBEAT_MS",
  30_000,
  120_000,
);
const requestTimeoutMs = positiveInteger(
  "WALKER_TELEMETRY_REQUEST_TIMEOUT_MS",
  20_000,
  60_000,
);

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Walker sensing route returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function controllerState() {
  const payload = await fetchJson(controllerStateUrl);
  const state = typeof payload?.data === "string" ? payload.data.trim() : "";
  if (!state) throw new Error("Walker controller state response is invalid");
  return state;
}

async function readSensor(sensor) {
  const url = new URL(sensorReadUrl);
  url.searchParams.set("boardSerialId", sensor.boardSerial);
  url.searchParams.set("sensorAddress", sensor.address);
  url.searchParams.set("measurements", "1");
  return await fetchJson(url);
}

const sink = {
  async send(payload) {
    return retryBounded(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch(receiverUrl, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${receiverSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Walker telemetry receiver returned ${response.status}`);
        }
        return await response.json();
      } finally {
        clearTimeout(timeout);
      }
    });
  },
};

const store = new FileCursorStore(
  process.env.WALKER_TELEMETRY_CURSOR_PATH ??
    "/var/lib/walker-telemetry/cursor.json",
);
const healthStore = new FileHealthStore(
  process.env.WALKER_TELEMETRY_HEALTH_PATH ??
    "/var/lib/walker-telemetry/health.json",
);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

let state = await initializeObserverState({
  sink,
  store,
  publisherInstance,
  bootstrapCursor,
});

const sensorsByBoard = Map.groupBy(
  walkerSensorCatalog,
  (sensor) => sensor.boardSerial,
);
const boardSerials = [...sensorsByBoard.keys()].sort();
if (
  boardSerials.length !== 2 ||
  boardSerials.some((board) => sensorsByBoard.get(board)?.length !== 48)
) {
  throw new Error("Walker observer requires the verified two boards with 48 sensors each");
}

let lastScan = {
  startedAt: null,
  completedAt: null,
  succeeded: 0,
  failed: 0,
};

async function recordHealth(extra = {}) {
  await healthStore.write({
    version: 2,
    publisher_instance: publisherInstance,
    source_stream: state.sourceStream,
    cursor: state.cursor,
    source_latest_known: state.cursor,
    caught_up: true,
    controller_state: extra.controllerState ?? null,
    scan_started_at: lastScan.startedAt,
    scan_completed_at: lastScan.completedAt,
    scan_succeeded: lastScan.succeeded,
    scan_failed: lastScan.failed,
    last_success_at: new Date().toISOString(),
  });
}

async function sendHeartbeat(extra = {}) {
  await sink.send(publisherEnvelope("heartbeat", state, {
    sourceCursor: state.cursor,
    sourceLatestKnown: state.cursor,
    observedAt: new Date().toISOString(),
  }));
  await recordHealth(extra);
}

await sendHeartbeat({ controllerState: await controllerState() });
console.log("Walker sensing-only observer initialized", {
  cursor: state.cursor,
  acceptedAfter: state.acceptedAfter,
  sensors: walkerSensorCatalog.length,
});

while (!stopping) {
  const scanStartedMs = Date.now();
  lastScan = {
    startedAt: new Date(scanStartedMs).toISOString(),
    completedAt: null,
    succeeded: 0,
    failed: 0,
  };
  try {
    state = await replayPendingBatch({ sink, store, state });
    for (let index = 0; index < 48 && !stopping; index += 1) {
      const currentControllerState = await controllerState();
      if (currentControllerState !== "STOPPED") {
        throw new Error(
          `Sensing-only observer paused because controller is ${currentControllerState}`,
        );
      }
      const sensors = boardSerials.map((board) => sensorsByBoard.get(board)[index]);
      const results = await Promise.allSettled(sensors.map(readSensor));
      const observations = [];
      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        const result = results[resultIndex];
        if (result.status === "fulfilled") {
          try {
            normalizeSensorResponse(
              sensors[resultIndex],
              result.value,
              1,
              new Date(),
            );
            observations.push({
              sensor: sensors[resultIndex],
              payload: result.value,
            });
            lastScan.succeeded += 1;
          } catch (error) {
            lastScan.failed += 1;
            console.error("Walker sensor returned no usable observation", {
              sensor: sensors[resultIndex].pairingName,
              message: error instanceof Error
                ? error.message
                : String(error),
            });
          }
        } else {
          lastScan.failed += 1;
          console.error("Walker sensor observation failed", {
            sensor: sensors[resultIndex].pairingName,
            message: result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          });
        }
      }
      if (observations.length) {
        state = await publishObservationBatch({
          observations,
          sink,
          store,
          state,
        });
        await recordHealth({ controllerState: currentControllerState });
      } else {
        await sendHeartbeat({ controllerState: currentControllerState });
      }
    }
    lastScan.completedAt = new Date().toISOString();
    await sendHeartbeat({ controllerState: await controllerState() });
    console.log("Walker sensing-only observation scan", {
      cursor: state.cursor,
      succeeded: lastScan.succeeded,
      failed: lastScan.failed,
      startedAt: lastScan.startedAt,
      completedAt: lastScan.completedAt,
    });
  } catch (error) {
    try {
      state = await initializeObserverState({
        sink,
        store,
        publisherInstance,
        bootstrapCursor,
      });
    } catch (restoreError) {
      console.error("Walker durable observer state could not be restored", {
        message: restoreError instanceof Error
          ? restoreError.message
          : String(restoreError),
      });
    }
    console.error("Walker sensing-only observation scan paused", {
      message: error instanceof Error ? error.message : String(error),
      cursor: state.cursor,
      succeeded: lastScan.succeeded,
      failed: lastScan.failed,
    });
  }

  const nextScanAt = scanStartedMs + scanIntervalMs;
  while (!stopping && Date.now() < nextScanAt) {
    const delay = Math.min(heartbeatMs, Math.max(1, nextScanAt - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!stopping) {
      try {
        await sendHeartbeat({ controllerState: await controllerState() });
      } catch (error) {
        console.error("Walker sensing-only observer heartbeat failed", {
          message: error instanceof Error ? error.message : String(error),
          cursor: state.cursor,
        });
      }
    }
  }
}
