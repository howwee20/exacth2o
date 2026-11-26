import type { SensorReading } from "./types";

export function isAcknowledgement(reading: Pick<SensorReading, "sensor_frame">) {
  return reading.sensor_frame === "sdi12_acknowledgement";
}

export function readingQualityNote(reading: Pick<SensorReading, "sensor_frame" | "calibrated_value">) {
  return isAcknowledgement(reading) ? "Sensor acknowledgement recorded as a measurement" : vwcQuality(reading.calibrated_value);
}

/** Plausibility and freshness are separate. Preserve the recorded values in every view. */
export function vwcQuality(value: number | null | undefined) {
  if (value == null) return null;
  if (!Number.isFinite(value)) return "VWC is not a finite measurement";
  return value < 0 || value > 100 ? "Outside the 0–100% VWC range" : null;
}

export function latestQualityIssues(readings: readonly Pick<SensorReading, "pairing_name" | "device_recorded_at" | "calibrated_value">[]) {
  const latest = new Map<string, typeof readings[number]>();
  for (const reading of readings) {
    const at = Date.parse(reading.device_recorded_at);
    if (Number.isFinite(at) && at >= Date.parse(latest.get(reading.pairing_name)?.device_recorded_at ?? "1970-01-01")) latest.set(reading.pairing_name, reading);
  }
  return [...latest.values()].filter((reading) => vwcQuality(reading.calibrated_value));
}
