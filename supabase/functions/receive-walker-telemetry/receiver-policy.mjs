export const walkerTelemetryIdentity = Object.freeze({
  projectId: "33333333-3333-4333-8333-333333333331",
  deviceId: "balena:a1c4ace2b367fbee8521f1aff6a6329b",
});

const maximumBatchSize = 1000;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
  }
}

export async function readBoundedJson(request, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Invalid request-body limit");
  }
  if (!request.body) throw new Error("Request body is required");

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

export function constantTimeSecretMatch(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(supplied);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function parseWalkerTelemetryEnvelope(value) {
  const payload = record(value);
  if (
    payload.project_id !== walkerTelemetryIdentity.projectId ||
    payload.device_id !== walkerTelemetryIdentity.deviceId
  ) {
    throw new Error("Walker telemetry identity mismatch");
  }

  const kind = payload.kind;
  if (!["initialize", "append", "heartbeat"].includes(kind)) {
    throw new Error("Unsupported Walker telemetry message");
  }
  const sourceCursor = integer(payload.source_cursor);
  const sourceLatestKnown = integer(payload.source_latest_known);
  const observedAt = timestamp(payload.observed_at);
  const publisherInstance = typeof payload.publisher_instance === "string"
    ? payload.publisher_instance.trim()
    : "";
  if (
    sourceCursor == null ||
    sourceCursor < 0 ||
    sourceLatestKnown == null ||
    sourceLatestKnown < sourceCursor ||
    !observedAt ||
    !publisherInstance ||
    publisherInstance.length > 160
  ) {
    throw new Error("Invalid Walker telemetry envelope");
  }

  if (kind !== "append") {
    if (payload.readings != null) {
      throw new Error("Only append messages may include readings");
    }
    return {
      kind,
      sourceCursor,
      sourceLatestKnown,
      observedAt,
      publisherInstance,
      readings: [],
    };
  }

  if (
    !Array.isArray(payload.readings) ||
    payload.readings.length < 1 ||
    payload.readings.length > maximumBatchSize
  ) {
    throw new Error("Walker append batches require 1 to 1000 readings");
  }
  const readings = payload.readings.map((input) => {
    const reading = record(input);
    const sourceReadingId = integer(reading.source_reading_id);
    const sourceSensorId = integer(reading.source_sensor_id);
    const rawValue = finiteNumber(reading.raw_value);
    const calibratedValue = finiteNumber(reading.calibrated_value);
    const temperature = reading.temperature == null
      ? null
      : finiteNumber(reading.temperature);
    const electricalConductivity = reading.electrical_conductivity == null
      ? null
      : finiteNumber(reading.electrical_conductivity);
    const deviceRecordedAt = timestamp(reading.device_recorded_at);
    const sourceCreatedAt = timestamp(reading.source_created_at);
    if (
      sourceReadingId == null ||
      sourceReadingId <= 0 ||
      sourceSensorId == null ||
      sourceSensorId <= 0 ||
      rawValue == null ||
      calibratedValue == null ||
      (reading.temperature != null && temperature == null) ||
      (reading.electrical_conductivity != null &&
        electricalConductivity == null) ||
      !deviceRecordedAt ||
      !sourceCreatedAt
    ) {
      throw new Error("Walker append batch contains an invalid reading");
    }
    return {
      source_reading_id: sourceReadingId,
      source_sensor_id: sourceSensorId,
      raw_value: rawValue,
      calibrated_value: calibratedValue,
      temperature,
      electrical_conductivity: electricalConductivity,
      device_recorded_at: deviceRecordedAt,
      source_created_at: sourceCreatedAt,
    };
  });
  if (Math.max(...readings.map((reading) => reading.source_reading_id)) !== sourceCursor) {
    throw new Error("Walker append cursor must equal the largest reading ID");
  }

  return {
    kind,
    sourceCursor,
    sourceLatestKnown,
    observedAt,
    publisherInstance,
    readings,
  };
}

export function walkerTelemetryRpc(envelope) {
  const common = {
    source_cursor: envelope.sourceCursor,
    source_latest_known: envelope.sourceLatestKnown,
    observed_at: envelope.observedAt,
    publisher_instance: envelope.publisherInstance,
  };
  if (envelope.kind === "initialize") {
    return { name: "walker_live_initialize_ingest", args: common };
  }
  if (envelope.kind === "heartbeat") {
    return { name: "walker_live_record_heartbeat", args: common };
  }
  return {
    name: "ingest_walker_live_telemetry_batch",
    args: { reading_rows: envelope.readings, ...common },
  };
}
