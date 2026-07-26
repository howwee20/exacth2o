export const walkerPublisherIdentity = Object.freeze({
  projectId: "33333333-3333-4333-8333-333333333331",
  deviceId: "balena:a1c4ace2b367fbee8521f1aff6a6329b",
});

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid source timestamp");
  return date.toISOString();
}

function finite(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (value == null) throw new Error(`Invalid ${label}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}`);
  return number;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

export function normalizeSourceReading(row) {
  const sourceReadingId = integer(row.id, "source reading ID");
  const sourceSensorId = integer(row.sensorId, "source sensor ID");
  if (sourceReadingId < 1 || sourceSensorId < 1) {
    throw new Error("Source reading and sensor IDs must be positive");
  }
  const createdAt = iso(row.createdAt);
  return {
    source_reading_id: sourceReadingId,
    source_sensor_id: sourceSensorId,
    raw_value: finite(row.rawValue, "raw value"),
    calibrated_value: finite(row.calibratedValue, "calibrated value"),
    temperature: finite(row.temperature, "temperature", true),
    electrical_conductivity: finite(
      row.electricalConductivity,
      "electrical conductivity",
      true,
    ),
    device_recorded_at: createdAt,
    source_created_at: createdAt,
  };
}

export function publisherEnvelope(kind, state, input = {}) {
  return {
    kind,
    project_id: walkerPublisherIdentity.projectId,
    device_id: walkerPublisherIdentity.deviceId,
    source_cursor: input.sourceCursor ?? state.cursor,
    source_latest_known: input.sourceLatestKnown ?? state.cursor,
    observed_at: input.observedAt ?? new Date().toISOString(),
    publisher_instance: state.publisherInstance,
    ...(kind === "append" ? { readings: input.readings } : {}),
  };
}

export async function initializeAtSourceTail({
  source,
  sink,
  store,
  publisherInstance,
  now = () => new Date(),
}) {
  const existing = await store.read();
  if (existing) {
    if (
      existing.projectId !== walkerPublisherIdentity.projectId ||
      existing.deviceId !== walkerPublisherIdentity.deviceId ||
      existing.publisherInstance !== publisherInstance ||
      !Number.isSafeInteger(existing.cursor) ||
      existing.cursor < 0
    ) {
      throw new Error("Durable Walker cursor identity is invalid");
    }
    return existing;
  }

  const tail = integer(await source.latestId(), "source tail");
  const state = {
    version: 1,
    projectId: walkerPublisherIdentity.projectId,
    deviceId: walkerPublisherIdentity.deviceId,
    publisherInstance,
    cursor: tail,
    acceptedAfter: now().toISOString(),
  };
  await sink.send(publisherEnvelope("initialize", state, {
    sourceCursor: tail,
    sourceLatestKnown: tail,
    observedAt: state.acceptedAfter,
  }));
  await store.write(state);
  return state;
}

export async function publishCycle({
  source,
  sink,
  store,
  state,
  batchSize = 500,
  maxRowsPerCycle = 2000,
  now = () => new Date(),
}) {
  const boundedBatchSize = Math.max(1, Math.min(1000, Math.trunc(batchSize)));
  const boundedCycleRows = Math.max(
    boundedBatchSize,
    Math.min(10_000, Math.trunc(maxRowsPerCycle)),
  );
  const latestId = integer(await source.latestId(), "source tail");
  let published = 0;
  let cursor = state.cursor;

  while (cursor < latestId && published < boundedCycleRows) {
    const limit = Math.min(boundedBatchSize, boundedCycleRows - published);
    const sourceRows = await source.after(cursor, limit);
    if (!sourceRows.length) {
      throw new Error("Walker source cursor has a gap that cannot be resolved");
    }
    const readings = sourceRows.map(normalizeSourceReading);
    const nextCursor = readings.at(-1).source_reading_id;
    if (nextCursor <= cursor) throw new Error("Walker source cursor did not advance");
    const observedAt = now().toISOString();
    await sink.send(publisherEnvelope("append", state, {
      sourceCursor: nextCursor,
      sourceLatestKnown: latestId,
      observedAt,
      readings,
    }));
    cursor = nextCursor;
    published += readings.length;
    state = { ...state, cursor };
    await store.write(state);
  }

  if (published === 0) {
    await sink.send(publisherEnvelope("heartbeat", state, {
      sourceCursor: cursor,
      sourceLatestKnown: latestId,
      observedAt: now().toISOString(),
    }));
  }
  return {
    state,
    published,
    sourceLatestKnown: latestId,
    caughtUp: cursor >= latestId,
  };
}

export async function retryBounded(
  operation,
  {
    attempts = 5,
    initialDelayMs = 500,
    maximumDelayMs = 8000,
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.min(
        maximumDelayMs,
        initialDelayMs * (2 ** (attempt - 1)),
      );
      await wait(delay);
    }
  }
  throw lastError;
}
