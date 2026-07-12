import replayFixture from "./rdReplayFixture.json";
import { ResponseCurveLab } from "./ResponseCurveLab";
import type { RdCorrectionEpisode, RdLabSnapshot, RdPotSummary } from "./rdTypes";

const fixture = replayFixture as RdLabSnapshot;
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
    prediction: index === 1 ? null : fixture.current,
    quality: {},
  })),
  missed_forecasts: 1,
  quality: {},
};

const previewEvents = [fixture.current, ...fixture.history];
const previewPots: RdPotSummary[] = [...new Map(previewEvents.map((event) => [event.pairing_name, event])).values()]
  .map((event, index) => ({
    pairing_name: event.pairing_name,
    target_vwc: event.target_vwc,
    current_vwc: event.trigger_vwc,
    distance_to_target: event.trigger_vwc - event.target_vwc,
    last_reading_at: event.feature_as_of_device_at,
    state: index === 0 ? "episode_active" : event.state,
    event,
    next_forecast: null,
    active_episode: index === 0 ? previewEpisode : null,
    episodes: index === 0 ? [previewEpisode] : [],
  }));

const previewSnapshot: RdLabSnapshot = {
  ...fixture,
  pots: previewPots,
  episodes: [previewEpisode],
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
