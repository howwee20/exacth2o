import { ArrowLeft, BrainCircuit, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  RdCorrectionEpisode,
  RdCurvePoint,
  RdIrrigationEvent,
  RdLabEvent,
  RdLabSnapshot,
  RdPotSummary,
} from "./rdTypes";

type LabTab = "pots" | "history" | "progress";

const chartWidth = 980;
const chartHeight = 430;
const pad = { left: 64, right: 28, top: 32, bottom: 52 };

function formatNumber(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function stateLabel(value: string) {
  const labels: Record<string, string> = {
    waiting_threshold: "Waiting",
    armed_early: "Early forecast",
    armed_refresh: "Forecast locked",
    committed: "Irrigation detected",
    tracking_response: "Measuring",
    episode_active: "Irrigating",
    episode_observing: "Measuring response",
    episode_complete: "Complete",
    scored: "Complete",
  };
  return labels[value] ?? value.replace(/_/g, " ");
}

function linePath(
  points: RdCurvePoint[],
  read: (point: RdCurvePoint) => number | null,
  x: (minute: number) => number,
  y: (value: number) => number,
) {
  let path = "";
  let drawing = false;
  for (const point of points) {
    const value = read(point);
    if (value == null) {
      drawing = false;
      continue;
    }
    path += `${drawing ? "L" : "M"}${x(point.minute).toFixed(2)},${y(value).toFixed(2)} `;
    drawing = true;
  }
  return path.trim();
}

function ResponseCurveChart({
  event,
  predictedLabel,
  measuredLabel,
  zeroLabel,
  pulseMarkers = [],
}: {
  event: RdLabEvent;
  predictedLabel: string;
  measuredLabel: string;
  zeroLabel: string;
  pulseMarkers?: Array<{ minute: number; label: string }>;
}) {
  const hasRange = event.curve.some((point) => point.p10 != null && point.p90 != null);
  const geometry = useMemo(() => {
    const values = event.curve.flatMap((point) => [point.p10, point.p90, point.actual])
      .filter((value): value is number => value != null && Number.isFinite(value));
    const minimum = Math.min(event.target_vwc, ...values);
    const maximum = Math.max(event.target_vwc, ...values);
    const span = Math.max(1, maximum - minimum);
    const minY = Math.floor((minimum - span * 0.12) * 2) / 2;
    const maxY = Math.ceil((maximum + span * 0.12) * 2) / 2;
    const maxMinute = Math.max(...event.curve.map((point) => point.minute), 1);
    const x = (minute: number) => pad.left + (minute / maxMinute) * (chartWidth - pad.left - pad.right);
    const y = (value: number) => pad.top + ((maxY - value) / (maxY - minY)) * (chartHeight - pad.top - pad.bottom);
    const bandTop = event.curve.filter((point) => point.p90 != null).map((point) => `${x(point.minute)},${y(point.p90!)}`);
    const bandBottom = event.curve.filter((point) => point.p10 != null).reverse().map((point) => `${x(point.minute)},${y(point.p10!)}`);
    return { minY, maxY, maxMinute, x, y, band: [...bandTop, ...bandBottom].join(" ") };
  }, [event]);

  const yTicks = Array.from({ length: 5 }, (_, index) => geometry.minY + (geometry.maxY - geometry.minY) * (index / 4));
  const xTicks = [0, 30, 60, 120, 180, 240].filter((minute) => minute <= geometry.maxMinute);
  const predictedPath = linePath(event.curve, (point) => point.predicted, geometry.x, geometry.y);
  const actualPath = linePath(event.curve, (point) => point.actual, geometry.x, geometry.y);

  return (
    <div className="rd-chart-wrap">
      <div className="rd-chart-legend" aria-label="Chart legend">
        <span><i className="is-predicted" /> {predictedLabel}</span>
        <span><i className="is-actual" /> {measuredLabel}</span>
        {hasRange ? <span><i className="is-band" /> {event.confidence === "trained_range" ? "Model range" : "Uncalibrated range"}</span> : null}
      </div>
      <svg className="rd-curve-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`${predictedLabel} and ${measuredLabel} for ${event.pairing_name}`}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={chartWidth - pad.right} y1={geometry.y(tick)} y2={geometry.y(tick)} className="rd-grid-line" />
            <text x={pad.left - 12} y={geometry.y(tick) + 4} textAnchor="end" className="rd-axis-label">{tick.toFixed(1)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={tick}>
            <line x1={geometry.x(tick)} x2={geometry.x(tick)} y1={pad.top} y2={chartHeight - pad.bottom} className="rd-grid-line is-vertical" />
            <text x={geometry.x(tick)} y={chartHeight - 22} textAnchor="middle" className="rd-axis-label">{tick === 0 ? zeroLabel : `${tick}m`}</text>
          </g>
        ))}
        <line x1={pad.left} x2={chartWidth - pad.right} y1={geometry.y(event.target_vwc)} y2={geometry.y(event.target_vwc)} className="rd-target-line" />
        <text x={chartWidth - pad.right} y={geometry.y(event.target_vwc) - 8} textAnchor="end" className="rd-target-label">TARGET {event.target_vwc.toFixed(1)}</text>
        {pulseMarkers.filter((pulse) => pulse.minute <= geometry.maxMinute).map((pulse) => (
          <g key={`${pulse.label}-${pulse.minute}`}>
            <line x1={geometry.x(pulse.minute)} x2={geometry.x(pulse.minute)} y1={pad.top} y2={chartHeight - pad.bottom} className="rd-pulse-line" />
            <text x={geometry.x(pulse.minute) + 4} y={pad.top + 14} className="rd-pulse-label">{pulse.label}</text>
          </g>
        ))}
        {hasRange ? <polygon points={geometry.band} className="rd-confidence-band" /> : null}
        <path d={predictedPath} className="rd-prediction-line" />
        <path d={actualPath} className="rd-actual-line" />
        {event.curve.map((point) => point.actual == null ? null : (
          <circle key={`actual-${point.minute}`} cx={geometry.x(point.minute)} cy={geometry.y(point.actual)} r="4.2" className="rd-actual-point">
            <title>{`${point.minute} min: ${point.actual.toFixed(2)} VWC`}</title>
          </circle>
        ))}
        <text x="18" y="28" className="rd-axis-title">VWC %</text>
      </svg>
    </div>
  );
}

function ProgressChart({ snapshot }: { snapshot: RdLabSnapshot }) {
  const points = snapshot.progress.filter((point) => point.curve_mae != null);
  const learning = snapshot.learning ?? {
    completed_episode_totals: 0,
    eligible_episode_totals: snapshot.clean_events_learned,
    minimum_episode_floor: 40,
    next_training_at: 40,
    episodes_until_next_training: Math.max(0, 40 - snapshot.clean_events_learned),
    represented_control_pots: 0,
    required_control_pots: 8,
    multi_pulse_episodes: 0,
    required_multi_pulse_episodes: 10,
    calendar_span_days: 0,
    required_calendar_span_days: 7,
    qualified_chronological_windows: 0,
    required_chronological_windows: 2,
    model_family: "regularized additive impulse",
    last_training_at: null,
    status: "collecting_evidence" as const,
  };
  const width = 760;
  const height = 260;
  const max = Math.max(...points.map((point) => point.curve_mae!), 0.5);
  const path = points.map((point, index) => {
    const x = 34 + (index / Math.max(1, points.length - 1)) * (width - 68);
    const y = 24 + (point.curve_mae! / max) * (height - 68);
    return `${index ? "L" : "M"}${x},${y}`;
  }).join(" ");
  return (
    <section className="rd-progress-panel">
      <div className="rd-learning-heading">
        <div><p className="rd-eyebrow">EPISODE-TOTAL EVIDENCE</p><h2>Training readiness</h2></div>
        <span className="rd-status-chip">{learning.status.replace(/_/g, " ")}</span>
      </div>
      <div className="rd-learning-gates">
        <article><strong>{learning.eligible_episode_totals}</strong><span>eligible totals</span><small>next train at {learning.next_training_at}</small></article>
        <article><strong>{learning.represented_control_pots}/{learning.required_control_pots}</strong><span>control pots</span><small>represented</small></article>
        <article><strong>{learning.multi_pulse_episodes}/{learning.required_multi_pulse_episodes}</strong><span>multi-event totals</span><small>minimum evidence</small></article>
        <article><strong>{learning.calendar_span_days.toFixed(1)}/{learning.required_calendar_span_days}</strong><span>calendar days</span><small>minimum span</small></article>
        <article><strong>{learning.qualified_chronological_windows}/{learning.required_chronological_windows}</strong><span>holdout wins</span><small>required to promote</small></article>
      </div>
      <div className="rd-learning-model-row">
        <span>Model<strong>{learning.model_family}</strong></span>
        <span>Clock<strong>{learning.scientific_clock ?? "First irrigation"}</strong></span>
        <span>Last train<strong>{formatTime(learning.last_training_at)}</strong></span>
        <span>Next batch<strong>{learning.episodes_until_next_training} episodes</strong></span>
      </div>
      <div><p className="rd-eyebrow">MEASURED EPISODE ERROR</p><h2>Chronological results</h2></div>
      {points.length ? (
        <svg viewBox={`0 0 ${width} ${height}`} className="rd-progress-chart" role="img" aria-label="Recent episode error trend">
          <line x1="34" x2={width - 34} y1={height - 36} y2={height - 36} className="rd-grid-line" />
          <path d={path} className="rd-progress-line" />
        </svg>
      ) : <div className="rd-empty-panel">No eligible episode-total scores yet.</div>}
    </section>
  );
}

function fallbackPots(snapshot: RdLabSnapshot): RdPotSummary[] {
  if (snapshot.pots?.length) return snapshot.pots;
  const events = [snapshot.current, ...snapshot.history];
  const byName = new Map<string, RdPotSummary>();
  for (const event of events) {
    if (byName.has(event.pairing_name)) continue;
    byName.set(event.pairing_name, {
      pairing_name: event.pairing_name,
      target_vwc: event.target_vwc,
      current_vwc: event.trigger_vwc,
      distance_to_target: event.trigger_vwc - event.target_vwc,
      last_reading_at: event.feature_as_of_device_at,
      state: event.state,
      event,
      next_forecast: event.state.startsWith("armed_") ? event : null,
      active_episode: null,
      episodes: [],
    });
  }
  return [...byName.values()];
}

function waitingEvent(pot: RdPotSummary, modelVersion: string): RdLabEvent {
  const now = new Date().toISOString();
  return {
    id: `waiting-${pot.pairing_name}`,
    pairing_name: pot.pairing_name,
    state: "waiting_threshold",
    target_vwc: pot.target_vwc,
    trigger_vwc: pot.current_vwc,
    committed_at: now,
    feature_as_of_device_at: pot.last_reading_at ?? now,
    irrigation_opened_device_at: null,
    model_version: modelVersion,
    prediction_lead_seconds: 0,
    curve: [],
    score: null,
    censored: false,
    confidence: "low_confidence",
  };
}

function episodeAsEvent(
  pot: RdPotSummary,
  episode: RdCorrectionEpisode,
  modelVersion: string,
): RdLabEvent {
  const predictedPulse = [...episode.pulses].reverse().find((pulse) => pulse.prediction)?.prediction;
  return {
    id: episode.id,
    pairing_name: pot.pairing_name,
    state: `episode_${episode.status}`,
    target_vwc: episode.target_vwc,
    trigger_vwc: pot.current_vwc,
    committed_at: predictedPulse?.committed_at ?? episode.started_at,
    feature_as_of_device_at: predictedPulse?.feature_as_of_device_at ?? episode.started_at,
    irrigation_opened_device_at: episode.started_at,
    model_version: predictedPulse?.model_version ?? modelVersion,
    prediction_lead_seconds: predictedPulse?.prediction_lead_seconds ?? 0,
    curve: episode.curve,
    score: null,
    censored: episode.outcome?.right_censored ?? false,
    confidence: predictedPulse?.confidence ?? "low_confidence",
  };
}

function EventCard({ pulse }: { pulse: RdIrrigationEvent | null }) {
  if (!pulse) return <section className="rd-side-card"><div className="rd-card-heading"><span>Selected event</span></div><p>No irrigation event yet.</p></section>;
  return (
    <section className="rd-side-card">
      <div className="rd-card-heading"><span>Event {pulse.sequence}</span></div>
      <dl className="rd-model-list">
        <div><dt>Opened</dt><dd>{formatTime(pulse.opened_at)}</dd></div>
        <div><dt>Forecast</dt><dd>{pulse.prediction ? "Locked before open" : "Missed"}</dd></div>
        <div><dt>Lead</dt><dd>{pulse.prediction_lead_seconds == null ? "—" : `${pulse.prediction_lead_seconds}s`}</dd></div>
        <div><dt>Duration</dt><dd>{pulse.duration_ms == null ? "Configured only" : `${pulse.duration_ms}ms`}</dd></div>
      </dl>
    </section>
  );
}

export function ResponseCurveLab({ snapshot, onBack }: { snapshot: RdLabSnapshot; onBack?: () => void }) {
  const [tab, setTab] = useState<LabTab>("pots");
  const pots = useMemo(() => fallbackPots(snapshot), [snapshot]);
  const [selectedName, setSelectedName] = useState(snapshot.current.pairing_name);
  const [selectedPulseId, setSelectedPulseId] = useState<string | null>(null);
  const selectedPot = pots.find((pot) => pot.pairing_name === selectedName) ?? pots[0];
  const activeEpisode = selectedPot?.active_episode ?? null;
  const nextForecast = selectedPot?.next_forecast ?? null;
  const current = activeEpisode && selectedPot
    ? episodeAsEvent(selectedPot, activeEpisode, snapshot.champion_version)
    : nextForecast ?? selectedPot?.event ?? (selectedPot
      ? waitingEvent(selectedPot, snapshot.champion_version)
      : snapshot.current);
  const selectedPulse = activeEpisode?.pulses.find((pulse) => pulse.id === selectedPulseId) ??
    activeEpisode?.pulses.at(-1) ?? null;

  return (
    <section className="rd-lab-main" aria-label="ExactH2O response curve laboratory">
      <header className="rd-lab-header">
        {onBack ? <button type="button" className="support-back-button" onClick={onBack}><ArrowLeft size={14} /> Home</button> : null}
        <div className="rd-lab-title-row">
          <div><p className="rd-eyebrow">EXACTH2O R&amp;D · CONTROL · {pots.length} POTS</p><h1>Response Curve Lab</h1></div>
          <div className="rd-lab-summary"><strong>{snapshot.episodes?.filter((episode) => episode.status !== "complete").length ?? 0}</strong><span>active episodes</span></div>
        </div>
        <nav className="rd-tabs" aria-label="R&D views">
          {(["pots", "history", "progress"] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>
              {item === "pots" ? "Live Pots" : item === "history" ? "Episode History" : "Model Evidence"}
            </button>
          ))}
        </nav>
      </header>

      <section className="rd-pot-panel" aria-label="Select a pot">
        {pots.map((pot) => (
          <button key={pot.pairing_name} type="button" className={`rd-pot-button ${pot.pairing_name === current.pairing_name ? "is-active" : ""}`} onClick={() => { setSelectedName(pot.pairing_name); setSelectedPulseId(null); }}>
            <span><strong>{pot.pairing_name}</strong><small>{stateLabel(pot.state)}</small></span>
            <span><strong>{formatNumber(pot.current_vwc)}</strong><small>target {formatNumber(pot.target_vwc, 0)} · {pot.active_episode?.pulse_count ?? 0} events</small></span>
          </button>
        ))}
      </section>

      {tab === "pots" ? (
        <>
          <section className="rd-event-banner">
            <div className="rd-event-icon"><BrainCircuit size={22} /></div>
            <div><p>{current.pairing_name}</p><h2>{stateLabel(selectedPot?.state ?? current.state)}</h2></div>
            <div className="rd-event-banner-facts">
              <span>Current<strong>{formatNumber(selectedPot?.current_vwc)}%</strong></span>
              <span>Target<strong>{current.target_vwc.toFixed(1)}%</strong></span>
              <span>Events<strong>{activeEpisode?.pulse_count ?? 0}</strong></span>
              <span>Next forecast<strong>{nextForecast ? stateLabel(nextForecast.state) : "—"}</strong></span>
            </div>
          </section>
          <div className="rd-current-grid">
            <section className="rd-chart-card">
              <div className="rd-chart-title">
                <div><p className="rd-eyebrow">{current.pairing_name}</p><h2>{activeEpisode ? "Predicted total vs. measured total" : nextForecast ? "Next event forecast" : "Waiting for threshold"}</h2></div>
                <span className="rd-status-chip">{stateLabel(selectedPot?.state ?? current.state)}</span>
              </div>
              {activeEpisode ? (
                <div className="rd-pulse-rail" aria-label="Irrigation events">
                  {activeEpisode.pulses.map((pulse) => (
                    <button key={pulse.id} type="button" className={selectedPulse?.id === pulse.id ? "is-active" : ""} onClick={() => setSelectedPulseId(pulse.id)}>
                      E{pulse.sequence}<small>{formatTime(pulse.opened_at)}</small><em>{pulse.prediction ? "predicted" : "missed"}</em>
                    </button>
                  ))}
                </div>
              ) : null}
              {current.curve.length ? (
                <ResponseCurveChart
                  event={current}
                  predictedLabel={activeEpisode ? "Predicted total" : "Event prediction"}
                  measuredLabel={activeEpisode ? "Measured total" : "Measured after open"}
                  zeroLabel={activeEpisode ? "EPISODE START" : "FUTURE OPEN"}
                  pulseMarkers={activeEpisode?.pulses.map((pulse) => ({
                    minute: (new Date(pulse.opened_at).getTime() - new Date(activeEpisode.started_at).getTime()) / 60_000,
                    label: `E${pulse.sequence}`,
                  }))}
                />
              ) : (
                <div className="rd-empty-chart"><strong>Waiting for target +0.1</strong><span>Each pot locks its own forecast before valve open.</span></div>
              )}
              <div className="rd-causal-strip">
                <Clock3 size={15} />
                <span>Reading <strong>{formatTime(selectedPot?.last_reading_at)}</strong></span>
                <span>Episode start <strong>{formatTime(activeEpisode?.started_at)}</strong></span>
                <span>Last event <strong>{formatTime(activeEpisode?.last_open_at)}</strong></span>
              </div>
            </section>
            <aside className="rd-side-stack">
              <EventCard pulse={selectedPulse} />
              <section className="rd-side-card">
                <div className="rd-card-heading"><span>Episode</span></div>
                <dl className="rd-model-list">
                  <div><dt>Status</dt><dd>{activeEpisode ? stateLabel(`episode_${activeEpisode.status}`) : "—"}</dd></div>
                  <div><dt>Events</dt><dd>{activeEpisode?.pulse_count ?? 0}</dd></div>
                  <div><dt>Missed</dt><dd>{activeEpisode?.missed_forecasts ?? 0}</dd></div>
                  <div><dt>Model</dt><dd>{snapshot.champion_version}</dd></div>
                </dl>
              </section>
            </aside>
          </div>
        </>
      ) : null}

      {tab === "history" ? (
        <section className="rd-history-panel">
          <div className="rd-section-intro"><p className="rd-eyebrow">{current.pairing_name}</p><h2>Correction episodes</h2></div>
          <div className="rd-history-list">
            {selectedPot?.episodes?.length ? selectedPot.episodes.map((episode) => (
              <article key={episode.id}>
                <span className="rd-history-icon"><BrainCircuit size={16} /></span>
                <div><strong>{formatTime(episode.started_at)}</strong><small>{episode.pulse_count} irrigation events</small></div>
                <span>{stateLabel(`episode_${episode.status}`)}</span>
                <dl>
                  <div><dt>Predicted</dt><dd>{episode.pulse_count - episode.missed_forecasts}</dd></div>
                  <div><dt>Eligible</dt><dd>{episode.outcome?.eligible_for_training ? "Yes" : "No"}</dd></div>
                  <div><dt>Peak complete</dt><dd>{episode.outcome == null ? "—" : episode.outcome.right_censored ? "No" : "Yes"}</dd></div>
                </dl>
              </article>
            )) : <div className="rd-empty-panel">No correction episodes for this pot.</div>}
          </div>
        </section>
      ) : null}

      {tab === "progress" ? <ProgressChart snapshot={snapshot} /> : null}
    </section>
  );
}
