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

export type RdPotSummary = {
  pairing_name: string;
  target_vwc: number;
  current_vwc: number;
  distance_to_target: number;
  last_reading_at: string | null;
  state: string;
  event: RdLabEvent | null;
};

export type RdLabSnapshot = {
  generated_at: string;
  mode: "shadow";
  champion_version: string;
  candidate_version: string | null;
  clean_events_learned: number;
  current: RdLabEvent;
  pots: RdPotSummary[];
  history: RdLabEvent[];
  progress: RdProgressPoint[];
};
