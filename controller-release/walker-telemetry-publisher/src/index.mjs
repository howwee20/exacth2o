import { readFile } from "node:fs/promises";
import { createPool } from "mysql2/promise";
import {
  initializeAtSourceTail,
  publishCycle,
  retryBounded,
} from "./publisher-core.mjs";
import { FileCursorStore } from "./state-store.mjs";

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
const receiverSecret = await secret("WALKER_TELEMETRY_PUBLISH_SECRET");
const databasePassword = await secret("WALKER_TELEMETRY_DB_PASSWORD");
const databaseName = required("WALKER_TELEMETRY_DB_NAME");
const batchSize = positiveInteger("WALKER_TELEMETRY_BATCH_SIZE", 500, 1000);
const maxRowsPerCycle = positiveInteger(
  "WALKER_TELEMETRY_MAX_ROWS_PER_CYCLE",
  2000,
  10_000,
);
const pollMs = positiveInteger("WALKER_TELEMETRY_POLL_MS", 15_000, 300_000);
const requestTimeoutMs = positiveInteger(
  "WALKER_TELEMETRY_REQUEST_TIMEOUT_MS",
  15_000,
  60_000,
);

const pool = createPool({
  host: required("WALKER_TELEMETRY_DB_HOST"),
  port: positiveInteger("WALKER_TELEMETRY_DB_PORT", 3306, 65_535),
  user: required("WALKER_TELEMETRY_DB_USER"),
  password: databasePassword,
  database: databaseName,
  connectionLimit: 2,
  enableKeepAlive: true,
  namedPlaceholders: false,
});

const source = {
  async latestId() {
    const [rows] = await pool.query("SELECT COALESCE(MAX(id), 0) AS latestId FROM readings");
    return Number(rows[0].latestId);
  },
  async after(cursor, limit) {
    const [rows] = await pool.execute(
      `SELECT
         id,
         sensorId,
         rawValue,
         calibratedValue,
         temperature,
         electricalConductivity,
         createdAt
       FROM readings
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [cursor, limit],
    );
    return rows;
  },
};

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
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

let state = await initializeAtSourceTail({
  source,
  sink,
  store,
  publisherInstance,
});
console.log("Walker telemetry publisher initialized", {
  cursor: state.cursor,
  acceptedAfter: state.acceptedAfter,
});

while (!stopping) {
  try {
    const result = await publishCycle({
      source,
      sink,
      store,
      state,
      batchSize,
      maxRowsPerCycle,
    });
    state = result.state;
    console.log("Walker telemetry publisher cycle", {
      published: result.published,
      cursor: state.cursor,
      sourceLatestKnown: result.sourceLatestKnown,
      caughtUp: result.caughtUp,
    });
  } catch (error) {
    console.error("Walker telemetry publisher cycle failed", {
      message: error instanceof Error ? error.message : String(error),
      cursor: state.cursor,
    });
  }
  if (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

await pool.end();
