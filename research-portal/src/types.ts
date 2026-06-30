export type PairingRow = {
  id: number;
  name: string;
  zone: number;
  pot_number: number;
  source_sensor_id: number;
  sensor_key: string;
  source_valve_id: number;
  valve_key: string;
  wtc_percent_limit: number;
  valve_open_time_ms: number;
  measurement_interval_ms: number;
};

export type LatestState = {
  device_id: string;
  last_seen_at: string;
  health_status: string;
  latest_payload: Record<string, unknown>;
  updated_at: string;
};

export type SensorReading = {
  id: number;
  event_id: string;
  pairing_name: string;
  sensor_key: string;
  raw_value: number;
  calibrated_value: number;
  temperature: number | null;
  electrical_conductivity: number | null;
  device_recorded_at: string;
  server_received_at: string;
};

export type ValveEvent = {
  id: number;
  event_id: string;
  pairing_name: string;
  valve_key: string;
  action: "open" | "close";
  duration_ms: number | null;
  device_recorded_at: string;
  server_received_at: string;
};
