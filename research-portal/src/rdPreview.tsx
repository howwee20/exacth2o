import replayFixture from "./rdReplayFixture.json";
import { ResponseCurveLab } from "./ResponseCurveLab";
import type { RdCorrectionEpisode, RdLabSnapshot, RdPotSummary } from "./rdTypes";

const fixture = replayFixture as RdLabSnapshot;
const previewChampion = "curve-living-v4-n279-local-preview";
const previewCandidate = "curve-saturation-v5-n275-local-preview";
const previewEpisode: RdCorrectionEpisode = {
  id: "preview-episode",
  pairing_name: fixture.current.pairing_name,
  status: "active",
  started_at: fixture.current.irrigation_opened_device_at!,
  last_open_at: "2026-07-29T23:28:00Z",
  target_vwc: fixture.current.target_vwc,
  pulse_count: 3,
  correction_ended_at: null,
  observation_ends_at: "2026-07-30T03:28:00Z",
  completed_at: null,
  curve: fixture.current.curve,
  pulses: [0, 14, 28].map((minute, index) => ({
    id: `preview-event-${index + 1}`,
    valve_event_id: `preview-open-${index + 1}`,
    sequence: index + 1,
    opened_at: new Date(Date.parse("2026-07-29T23:00:00Z") + minute * 60_000).toISOString(),
    duration_ms: null,
    duration_source: "configured_snapshot",
    prediction_status: index === 1 ? "missed_causal_window" : "committed",
    prediction_lead_seconds: index === 1 ? null : 120,
    prediction: index === 1 ? null : { ...fixture.current, model_version: previewChampion },
    quality: {},
  })),
  missed_forecasts: 1,
  quality: {},
};

const previewPastEpisodes: RdCorrectionEpisode[] = fixture.history.slice(0, 4).map((event, index) => {
  const startedAt = new Date(Date.parse("2026-07-29T14:00:00Z") - (index + 1) * 86_400_000).toISOString();
  const pulseCount = 3 + index;
  const excluded = index === 1 || index === 3;
  return {
    id: `preview-past-episode-${index + 1}`,
    pairing_name: fixture.current.pairing_name,
    status: "complete",
    started_at: startedAt,
    last_open_at: new Date(Date.parse(startedAt) + (pulseCount - 1) * 16 * 60_000).toISOString(),
    target_vwc: fixture.current.target_vwc,
    pulse_count: pulseCount,
    correction_ended_at: new Date(Date.parse(startedAt) + pulseCount * 16 * 60_000).toISOString(),
    observation_ends_at: new Date(Date.parse(startedAt) + 6 * 60 * 60_000).toISOString(),
    completed_at: new Date(Date.parse(startedAt) + 6 * 60 * 60_000).toISOString(),
    curve: event.curve,
    pulses: Array.from({ length: pulseCount }, (_, pulseIndex) => ({
      id: `preview-past-${index + 1}-pulse-${pulseIndex + 1}`,
      valve_event_id: `preview-past-${index + 1}-open-${pulseIndex + 1}`,
      sequence: pulseIndex + 1,
      opened_at: new Date(Date.parse(startedAt) + pulseIndex * 16 * 60_000).toISOString(),
      duration_ms: pulseIndex % 2 ? null : 2_000,
      duration_source: pulseIndex % 2 ? "configured_snapshot" : "observed_event",
      prediction_status: "committed",
      prediction_lead_seconds: 160,
      prediction: { ...event, pairing_name: fixture.current.pairing_name, model_version: previewChampion },
      quality: {},
    })),
    missed_forecasts: 0,
    quality: {},
    outcome: {
      observed_horizons: excluded ? 7 : 12,
      eligible_for_scoring: true,
      eligible_for_training: !excluded,
      quality_reasons: excluded ? [index === 1 ? "right_censored" : "configured_duration_only"] : [],
      right_censored: index === 1,
      sample_interval_minutes: 15,
      outcome_version: "local-preview-v1",
      completed_at: new Date(Date.parse(startedAt) + 6 * 60 * 60_000).toISOString(),
    },
    score: event.score ? {
      ...event.score,
      model_version: previewChampion,
      model_role: "champion",
    } : null,
  };
});

const previewEvents = [fixture.current, ...fixture.history];
const previewBasePots: RdPotSummary[] = [...new Map(previewEvents.map((event) => [event.pairing_name, event])).values()]
  .map((event, index) => {
    const state = ["episode_active", "tracking_response", "armed_refresh", "tracking_response", "armed_early", "tracking_response"][index] ?? "waiting_threshold";
    const forecastOnly = state.startsWith("armed_");
    const previewEvent = {
      ...event,
      state,
      model_version: previewChampion,
      curve: event.curve.map((point) => ({ ...point, actual: forecastOnly ? null : point.actual })),
    };
    return {
      pairing_name: event.pairing_name,
      target_vwc: event.target_vwc,
      current_vwc: event.trigger_vwc,
      distance_to_target: event.trigger_vwc - event.target_vwc,
      last_reading_at: event.feature_as_of_device_at,
      state,
      event: previewEvent,
      next_forecast: forecastOnly ? previewEvent : null,
      active_episode: index === 0 ? previewEpisode : null,
      episodes: index === 0 ? [previewEpisode, ...previewPastEpisodes] : [],
    };
  });

const previewPots: RdPotSummary[] = [
  ...previewBasePots,
  ...[
    ["Zone2-Pot47", 19.82],
    ["Zone2-Pot49", 20.31],
    ["Zone4-Pot97", 20.08],
    ["Zone4-Pot99", 20.24],
  ].map(([pairingName, currentVwc]) => {
    const name = String(pairingName);
    const value = Number(currentVwc);
    const forecastEvent = {
      ...fixture.current,
      id: `preview-forecast-${name}`,
      pairing_name: name,
      state: "armed_early",
      target_vwc: 20,
      trigger_vwc: value,
      model_version: previewChampion,
      irrigation_opened_device_at: null,
      curve: fixture.current.curve.map((point) => ({ ...point, actual: null })),
      score: null,
    };
    return {
      pairing_name: name,
      target_vwc: 20,
      current_vwc: value,
      distance_to_target: value - 20,
      last_reading_at: fixture.generated_at,
      state: "armed_early",
      event: forecastEvent,
      next_forecast: forecastEvent,
      active_episode: null,
      episodes: [],
    };
  }),
];

const previewSnapshot: RdLabSnapshot = {
  ...fixture,
  champion_version: previewChampion,
  candidate_version: previewCandidate,
  pots: previewPots,
  episodes: [previewEpisode, ...previewPastEpisodes],
  model_comparison: {
    champion_version: previewChampion,
    evaluation_candidate_version: previewCandidate,
    latest_challenger_version: "curve-saturation-v5r2-n456-local-preview",
    overall: {
      event_count: 181,
      candidate_mae: 0.281,
      champion_mae: 0.151,
      zero_mae: 0.344,
      candidate_signed_bias: 0.171,
      interval_coverage: 0.82,
    },
    first_pulses: {
      event_count: 18,
      candidate_mae: 0.315,
      champion_mae: 0.333,
      zero_mae: 0.389,
      candidate_signed_bias: 0.029,
      interval_coverage: 0.78,
    },
    correction_pulses: {
      event_count: 163,
      candidate_mae: 0.277,
      champion_mae: 0.130,
      zero_mae: 0.339,
      candidate_signed_bias: 0.187,
      interval_coverage: 0.83,
    },
    first_pulse_pot_count: 10,
    required_first_pulse_pots: 8,
    qualified_windows: 0,
    required_windows: 2,
  },
};

export default function RdPreview() {
  return (
    <main className="dashboard-shell portal-admin-shell rd-preview-shell">
      <header className="dashboard-header">
        <a className="dashboard-logo" href="#preview">exact<span>H</span>2<span>O</span></a>
        <div className="rd-preview-label">LOCAL REPLAY · SYNTHETIC DATA</div>
      </header>
      <ResponseCurveLab snapshot={previewSnapshot} />
    </main>
  );
}
