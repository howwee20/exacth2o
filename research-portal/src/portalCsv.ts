import type { PortalExperiment } from "./experimentRegistry";
import { formatTargetVwc, pairingCalibrationName } from "./portalFormat";
import { sourceLabelForReading } from "./portalReadings";
import { csvEscape } from "./readingsExport";
import type { PairingRow, SensorReading } from "./types";

/** Pure formatting; callers retain export scope, loading, and download ownership. */
export function formatLoadedReadingsCsv(readings: SensorReading[], pairingByName: Map<string, PairingRow>, selectedExperiment: PortalExperiment) {
  const headers = [
    "source",
    "event_id",
    "pairing_name",
    "plant_group",
    "treatment",
    "zone",
    "pot_number",
    "sensor_key",
    "device_recorded_at",
    "server_received_at",
    "calibrated_vwc",
    "raw_value",
    "temperature",
    "electrical_conductivity",
  ];
  const rows = readings.map((reading) => {
    const pairing = pairingByName.get(reading.pairing_name);
    return [
      sourceLabelForReading(reading),
      reading.event_id,
      reading.pairing_name,
      selectedExperiment.assignments?.find((item) => item.pairing_name === reading.pairing_name)?.crop ?? "",
      selectedExperiment.assignments?.find((item) => item.pairing_name === reading.pairing_name)?.treatment ?? "",
      pairing?.zone ?? "",
      pairing?.pot_number ?? "",
      reading.sensor_key,
      reading.device_recorded_at,
      reading.server_received_at,
      reading.calibrated_value,
      reading.raw_value,
      reading.temperature,
      reading.electrical_conductivity,
    ].map(csvEscape).join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  return csv;
}

export function formatPairingsCsv(pairings: PairingRow[], selectedExperiment: PortalExperiment) {
  const headers = [
    "name",
    "zone",
    "pot_number",
    "plant_group",
    "treatment",
    "sensor_key",
    "valve_key",
    "target_vwc",
    "valve_open_seconds",
    "measurement_interval_seconds",
    "calibration",
  ];
  const rows = pairings.map((pairing) => [
    pairing.name,
    pairing.zone,
    pairing.pot_number,
    selectedExperiment.assignments?.find((item) => item.pairing_name === pairing.name)?.crop ?? "",
    selectedExperiment.assignments?.find((item) => item.pairing_name === pairing.name)?.treatment ?? "",
    pairing.sensor_key,
    pairing.valve_key,
    formatTargetVwc(pairing.wtc_percent_limit),
    Number((pairing.valve_open_time_ms / 1000).toFixed(3)),
    Number((pairing.measurement_interval_ms / 1000).toFixed(3)),
    pairingCalibrationName(pairing),
  ].map(csvEscape).join(","));
  const csv = [headers.join(","), ...rows].join("\n");
  return csv;
}
