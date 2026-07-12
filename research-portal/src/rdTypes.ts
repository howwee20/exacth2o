export type RdPredictionScore = {
  curve_mae: number | null;
  peak_error: number | null;
  time_to_peak_error_minutes: number | null;
  integrated_response_error: number | null;
  interval_coverage: number | null;
  scored_horizons: number;
};

export type RdCurvePoint = {
  minute: number;
  p10: number | null;
  predicted: number | null;
  p90: number | null;
  actual: number | null;
};

export type RdLabEvent = {
  id: string;
  pairing_name: string;
  state: string;
  target_vwc: number;
  trigger_vwc: number;
  committed_at: string;
  feature_as_of_device_at: string;
  irrigation_opened_device_at: string | null;
  model_version: string;
  prediction_lead_seconds: number;
  curve: RdCurvePoint[];
  score: RdPredictionScore | null;
  censored: boolean;
  confidence: string;
};

export type RdProgressPoint = {
  event: string;
  index: number;
  curve_mae: number | null;
};

export type RdIrrigationEvent = {
  id: string;
  valve_event_id: string;
  sequence: number;
  opened_at: string;
  duration_ms: number | null;
  duration_source: "observed_event" | "configured_snapshot" | "unknown";
  prediction_status: "committed" | "missed_causal_window";
  prediction_lead_seconds: number | null;
  prediction: RdLabEvent | null;
  quality: Record<string, unknown>;
};

export type RdCorrectionEpisode = {
  id: string;
  pairing_name: string;
  status: "active" | "observing" | "complete";
  started_at: string;
  last_open_at: string;
  target_vwc: number;
  pulse_count: number;
  correction_ended_at: string | null;
  observation_ends_at: string;
  completed_at: string | null;
  curve: RdCurvePoint[];
  pulses: RdIrrigationEvent[];
  missed_forecasts: number;
  quality: Record<string, unknown>;
};

export type RdPotSummary = {
  pairing_name: string;
  target_vwc: number;
  current_vwc: number;
  distance_to_target: number;
  last_reading_at: string | null;
  state: string;
  event: RdLabEvent | null;
  next_forecast?: RdLabEvent | null;
  active_episode?: RdCorrectionEpisode | null;
  episodes?: RdCorrectionEpisode[];
};

export type RdLabSnapshot = {
  generated_at: string;
  mode: "shadow";
  champion_version: string;
  candidate_version: string | null;
  clean_events_learned: number;
  current: RdLabEvent;
  pots: RdPotSummary[];
  episodes?: RdCorrectionEpisode[];
  history: RdLabEvent[];
  progress: RdProgressPoint[];
};
