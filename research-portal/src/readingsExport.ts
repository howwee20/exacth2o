import { type SensorReading } from "./types";

export function readingExportKey(reading: SensorReading) {
  if (!reading.pairing_name || !reading.sensor_key || !reading.device_recorded_at) {
    return reading.event_id || String(reading.id);
  }

  return [
    reading.pairing_name,
    reading.sensor_key,
    reading.device_recorded_at,
    reading.calibrated_value ?? "",
    reading.raw_value ?? "",
    reading.temperature ?? "",
    reading.electrical_conductivity ?? "",
  ].join("\u001f");
}

export function exportSourcePriority(reading: SensorReading) {
  if (reading.event_id.startsWith("live-device:")) return 2;
  if (reading.event_id.startsWith("balena-export-v2:")) return 1;
  return 0;
}

export function dedupeReadingsForExport(readings: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const reading of readings) {
    const key = readingExportKey(reading) || reading.event_id || String(reading.id);
    const existing = byKey.get(key);
    if (!existing || exportSourcePriority(reading) > exportSourcePriority(existing)) {
      byKey.set(key, reading);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) =>
      new Date(a.device_recorded_at).getTime() -
      new Date(b.device_recorded_at).getTime(),
  );
}
export function csvEscape(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadJsonFile(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `exacth2o-${name}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
