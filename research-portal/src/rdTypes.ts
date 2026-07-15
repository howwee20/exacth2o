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
  outcome?: {
    observed_horizons: number;
    eligible_for_scoring: boolean;
    eligible_for_training: boolean;
    quality_reasons: string[];
    right_censored: boolean;
    sample_interval_minutes: number;
    outcome_version: string;
    completed_at: string;
  } | null;
  score?: (RdPredictionScore & {
    model_version: string;
    model_role: "baseline" | "candidate" | "champion";
  }) | null;
};

export type RdLearningState = {
  completed_episode_totals: number;
  eligible_episode_totals: number;
  minimum_episode_floor: number;
  next_training_at: number;
  episodes_until_next_training: number;
  represented_control_pots: number;
  required_control_pots: number;
  multi_pulse_episodes: number;
  required_multi_pulse_episodes: number;
  calendar_span_days: number;
  required_calendar_span_days: number;
  qualified_chronological_windows: number;
  required_chronological_windows: number;
  model_family: string;
  last_training_at: string | null;
  scientific_clock?: string;
  current_interval_coverage?: number | null;
  interval_calibrated?: boolean;
  status: "collecting_evidence" | "candidate_evaluating" | "champion_active";
};

export type RdModelSegment = {
  event_count: number;
  candidate_mae: number | null;
  champion_mae: number | null;
  zero_mae: number | null;
  candidate_signed_bias: number | null;
  interval_coverage: number | null;
};

export type RdModelComparison = {
  champion_version: string;
  evaluation_candidate_version: string | null;
  latest_challenger_version: string | null;
  overall: RdModelSegment | null;
  first_pulses: RdModelSegment | null;
  correction_pulses: RdModelSegment | null;
  pot_count: number;
  evaluation_span_days: number;
  first_pulse_pot_count: number;
  required_first_pulse_pots: number;
  qualified_windows: number;
  required_windows: number;
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
  learning?: RdLearningState;
  model_comparison?: RdModelComparison;
  current: RdLabEvent;
  pots: RdPotSummary[];
  episodes?: RdCorrectionEpisode[];
  history: RdLabEvent[];
  progress: RdProgressPoint[];
};
