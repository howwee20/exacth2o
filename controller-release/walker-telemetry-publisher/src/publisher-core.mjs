export const walkerPublisherIdentity = Object.freeze({
  projectId: "33333333-3333-4333-8333-333333333331",
  deviceId: "balena:a1c4ace2b367fbee8521f1aff6a6329b",
});

const calibrationCoefficients = Object.freeze([
  100.68,
  -0.1289,
  0.00004,
  0,
  0,
  0,
]);

function sourceSensorId(position) {
  if (position >= 1 && position <= 24) return 769 + position;
  if (position >= 25 && position <= 47) return 721 + position;
  if (position === 49) return 769;
  if (position >= 52 && position <= 75) return 869 - position;
  if (position >= 76 && position <= 99) return 917 - position;
  throw new Error(`Unsupported Walker sensor position ${position}`);
}

function walkerPosition(position) {
  const firstBoard = position < 50;
  const address = firstBoard
    ? (
      position === 49
        ? "X"
        : position <= 24
        ? String.fromCharCode("a".charCodeAt(0) + position - 1)
        : String.fromCharCode("A".charCodeAt(0) + position - 25)
    )
    : (
      position <= 75
        ? String.fromCharCode("X".charCodeAt(0) - (position - 52))
        : String.fromCharCode("x".charCodeAt(0) - (position - 76))
    );
  return Object.freeze({
    position,
    sourceSensorId: sourceSensorId(position),
    pairingName: position === 41 ? "Q-41" : `${position}-${address}`,
    boardSerial: firstBoard ? "D30GQN2S" : "D30GQN2F",
    address,
    calibrationCoefficients,
  });
}

export const walkerSensorCatalog = Object.freeze(
  Array.from({ length: 100 }, (_, index) => index + 1)
    .filter((position) => ![48, 50, 51, 100].includes(position))
    .map(walkerPosition),
);

if (
  walkerSensorCatalog.length !== 96 ||
  new Set(walkerSensorCatalog.map((sensor) => sensor.sourceSensorId)).size !== 96
) {
  throw new Error("Walker sensor observer catalog is not the verified 96-sensor set");
}

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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

export function calibrateRawValue(rawValue, coefficients = calibrationCoefficients) {
  const raw = finite(rawValue, "raw sensor value");
  if (!Array.isArray(coefficients) || !coefficients.length) {
    throw new Error("Calibration coefficients are required");
  }
  return coefficients.reduceRight(
    (result, coefficient) => result * raw + finite(coefficient, "calibration coefficient"),
    0,
  );
}

export function normalizeSensorResponse(sensor, payload, sourceReadingId, recordedAt) {
  if (!sensor || !walkerSensorCatalog.includes(sensor)) {
    throw new Error("Sensor response is outside the fixed Walker catalog");
  }
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Walker sensor response must contain exactly one measurement");
  }
  const row = rows[0];
  if (row?.sensorAddress !== sensor.address) {
    throw new Error("Walker sensor response address mismatch");
  }
  const rawValue = finite(row.volumetricWaterContent, "raw sensor value");
  const timestamp = iso(recordedAt);
  return {
    source_reading_id: positiveInteger(sourceReadingId, "source reading ID"),
    source_sensor_id: sensor.sourceSensorId,
    raw_value: rawValue,
    calibrated_value: calibrateRawValue(rawValue, sensor.calibrationCoefficients),
    temperature: finite(row.temperature, "temperature", true),
    electrical_conductivity: finite(
      row.electricalConductivity,
      "electrical conductivity",
      true,
    ),
    device_recorded_at: timestamp,
    source_created_at: timestamp,
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

function validateState(state, publisherInstance) {
  if (
    !state ||
    state.projectId !== walkerPublisherIdentity.projectId ||
    state.deviceId !== walkerPublisherIdentity.deviceId ||
    state.publisherInstance !== publisherInstance ||
    !Number.isSafeInteger(state.cursor) ||
    state.cursor < 0 ||
    !Number.isFinite(Date.parse(state.acceptedAfter))
  ) {
    throw new Error("Durable Walker cursor identity is invalid");
  }
  if (state.pending) {
    const pending = state.pending;
    if (
      pending.sourceCursor <= state.cursor ||
      !Array.isArray(pending.readings) ||
      !pending.readings.length ||
      pending.readings.at(-1)?.source_reading_id !== pending.sourceCursor ||
      !Number.isFinite(Date.parse(pending.observedAt))
    ) {
      throw new Error("Durable Walker outbox is invalid");
    }
  }
  return state;
}

export async function initializeObserverState({
  sink,
  store,
  publisherInstance,
  bootstrapCursor,
  now = () => new Date(),
}) {
  const existing = await store.read();
  if (existing) return validateState(existing, publisherInstance);

  const cursor = positiveInteger(bootstrapCursor, "bootstrap cursor");
  const acceptedAfter = iso(now());
  const state = {
    version: 2,
    sourceStream: "walker-sdi12-observer-v1",
    projectId: walkerPublisherIdentity.projectId,
    deviceId: walkerPublisherIdentity.deviceId,
    publisherInstance,
    cursor,
    acceptedAfter,
    pending: null,
  };
  await sink.send(publisherEnvelope("initialize", state, {
    sourceCursor: cursor,
    sourceLatestKnown: cursor,
    observedAt: acceptedAfter,
  }));
  await store.write(state);
  return state;
}

export async function replayPendingBatch({ sink, store, state }) {
  if (!state.pending) return state;
  const pending = state.pending;
  await sink.send(publisherEnvelope("append", state, {
    sourceCursor: pending.sourceCursor,
    sourceLatestKnown: pending.sourceCursor,
    observedAt: pending.observedAt,
    readings: pending.readings,
  }));
  const acknowledged = {
    ...state,
    cursor: pending.sourceCursor,
    pending: null,
  };
  await store.write(acknowledged);
  return acknowledged;
}

export async function publishObservationBatch({
  observations,
  sink,
  store,
  state,
  now = () => new Date(),
}) {
  if (!Array.isArray(observations) || !observations.length) return state;
  if (state.pending) throw new Error("Pending Walker outbox must be replayed first");

  const recordedAt = iso(now());
  const readings = observations.map(({ sensor, payload }, index) =>
    normalizeSensorResponse(sensor, payload, state.cursor + index + 1, recordedAt)
  );
  const sourceCursor = readings.at(-1).source_reading_id;
  const observedAt = iso(now());
  const pendingState = {
    ...state,
    pending: { sourceCursor, observedAt, readings },
  };
  await store.write(pendingState);
  await sink.send(publisherEnvelope("append", state, {
    sourceCursor,
    sourceLatestKnown: sourceCursor,
    observedAt,
    readings,
  }));
  const acknowledged = {
    ...state,
    cursor: sourceCursor,
    pending: null,
  };
  await store.write(acknowledged);
  return acknowledged;
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
