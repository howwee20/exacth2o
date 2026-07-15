import { ArrowLeft, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  RdCorrectionEpisode,
  RdCurvePoint,
  RdIrrigationEvent,
  RdLabEvent,
  RdLabSnapshot,
  RdModelSegment,
  RdPotSummary,
} from "./rdTypes";

type LabTab = "live" | "history" | "models";
type HistoryFilter = "all" | "training" | "excluded";

const chartWidth = 920;
const chartHeight = 360;
const pad = { left: 66, right: 28, top: 26, bottom: 54 };

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

function formatLead(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "Unavailable";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (!minutes) return `${remainder}s before pulse`;
  return `${minutes}m ${remainder}s before pulse`;
}

function stateLabel(value: string) {
  const labels: Record<string, string> = {
    waiting_threshold: "Waiting for threshold",
    awaiting_threshold: "Waiting for threshold",
    armed_early: "Forecast ready",
    armed_refresh: "Forecast locked",
    committed: "Pulse recorded",
    tracking_response: "Measuring response",
    episode_active: "Correction cycle active",
    episode_observing: "Measuring final response",
    episode_complete: "Outcome measured",
    scored: "Outcome measured",
  };
  return labels[value] ?? value.replace(/_/g, " ");
}

function modelName(version: string | null | undefined) {
  if (!version) return "None";
  const match = version.match(/(?:^|-)v(\d+(?:r\d+)?)(?:-|$)/i);
  return match ? `V${match[1]}` : version;
}

function modelRoleLabel(role: "baseline" | "candidate" | "champion") {
  if (role === "champion") return "current model";
  if (role === "candidate") return "test model";
  return "baseline";
}

function qualityReason(reason: string) {
  const labels: Record<string, string> = {
    insufficient_horizons: "Not enough response readings",
    right_censored: "Response window ended early",
    missing_duration: "Actual pulse duration unavailable",
    configured_duration_only: "Only configured pulse duration is known",
    missing_prediction: "A pulse did not have a frozen forecast",
    stale_sensor_reading: "Sensor evidence was stale",
  };
  return labels[reason] ?? reason.replace(/_/g, " ");
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

function relativeCurve(event: RdLabEvent): RdCurvePoint[] {
  const forecastBaseline = event.curve.find((point) => point.predicted != null)?.predicted ?? event.trigger_vwc;
  const measuredBaseline = event.curve.find((point) => point.actual != null)?.actual ?? event.trigger_vwc;
  return event.curve.map((point) => ({
    ...point,
    p10: point.p10 == null ? null : point.p10 - forecastBaseline,
    predicted: point.predicted == null ? null : point.predicted - forecastBaseline,
    p90: point.p90 == null ? null : point.p90 - forecastBaseline,
    actual: point.actual == null ? null : point.actual - measuredBaseline,
  }));
}

function ResponseCurveChart({ event }: { event: RdLabEvent }) {
  const curve = useMemo(() => relativeCurve(event), [event]);
  const hasRange = curve.some((point) => point.p10 != null && point.p90 != null);
  const geometry = useMemo(() => {
    const values = curve.flatMap((point) => [point.p10, point.p90, point.actual, point.predicted])
      .filter((value): value is number => value != null && Number.isFinite(value));
    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    const span = Math.max(0.5, maximum - minimum);
    const minY = Math.floor((minimum - span * 0.12) * 4) / 4;
    const maxY = Math.ceil((maximum + span * 0.12) * 4) / 4;
    const maxMinute = Math.max(...curve.map((point) => point.minute), 1);
    const x = (minute: number) => pad.left + (minute / maxMinute) * (chartWidth - pad.left - pad.right);
    const y = (value: number) => pad.top + ((maxY - value) / (maxY - minY)) * (chartHeight - pad.top - pad.bottom);
    const bandTop = curve.filter((point) => point.p90 != null).map((point) => `${x(point.minute)},${y(point.p90!)}`);
    const bandBottom = curve.filter((point) => point.p10 != null).reverse().map((point) => `${x(point.minute)},${y(point.p10!)}`);
    return { minY, maxY, maxMinute, x, y, band: [...bandTop, ...bandBottom].join(" ") };
  }, [curve]);

  const yTicks = Array.from({ length: 5 }, (_, index) => geometry.minY + (geometry.maxY - geometry.minY) * (index / 4));
  const xTicks = [0, 30, 60, 120, 180, 240].filter((minute) => minute <= geometry.maxMinute);
  const predictedPath = linePath(curve, (point) => point.predicted, geometry.x, geometry.y);
  const actualPath = linePath(curve, (point) => point.actual, geometry.x, geometry.y);

  return (
    <div className="rd-chart-wrap">
      <div className="rd-chart-legend" aria-label="Chart legend">
        <span><i className="is-predicted" /> Forecast</span>
        <span><i className="is-actual" /> Measured</span>
        {hasRange ? <span><i className="is-band" /> Forecast range</span> : null}
      </div>
      <svg className="rd-curve-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`Forecast and measured moisture response for ${event.pairing_name}`}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={chartWidth - pad.right} y1={geometry.y(tick)} y2={geometry.y(tick)} className="rd-grid-line" />
            <text x={pad.left - 12} y={geometry.y(tick) + 4} textAnchor="end" className="rd-axis-label">{tick > 0 ? "+" : ""}{tick.toFixed(2)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={tick}>
            <line x1={geometry.x(tick)} x2={geometry.x(tick)} y1={pad.top} y2={chartHeight - pad.bottom} className="rd-grid-line is-vertical" />
            <text x={geometry.x(tick)} y={chartHeight - 22} textAnchor="middle" className="rd-axis-label">{tick === 0 ? "START" : `${tick}m`}</text>
          </g>
        ))}
        <line x1={pad.left} x2={chartWidth - pad.right} y1={geometry.y(0)} y2={geometry.y(0)} className="rd-zero-line" />
        {hasRange ? <polygon points={geometry.band} className="rd-confidence-band" /> : null}
        <path d={predictedPath} className="rd-prediction-line" />
        <path d={actualPath} className="rd-actual-line" />
        {curve.map((point) => point.actual == null ? null : (
          <circle key={`actual-${point.minute}`} cx={geometry.x(point.minute)} cy={geometry.y(point.actual)} r="4" className="rd-actual-point">
            <title>{`${point.minute} min: ${point.actual >= 0 ? "+" : ""}${point.actual.toFixed(2)} VWC`}</title>
          </circle>
        ))}
        <text x="18" y="24" className="rd-axis-title">Δ VWC</text>
        <text x={chartWidth - pad.right} y={chartHeight - 7} textAnchor="end" className="rd-axis-title">MINUTES AFTER PULSE</text>
      </svg>
    </div>
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

function episodeAsEvent(pot: RdPotSummary, episode: RdCorrectionEpisode, modelVersion: string): RdLabEvent {
  const predictedPulse = [...episode.pulses].reverse().find((pulse) => pulse.prediction)?.prediction;
  return {
    id: episode.id,
    pairing_name: pot.pairing_name,
    state: `episode_${episode.status}`,
    target_vwc: episode.target_vwc,
    trigger_vwc: predictedPulse?.trigger_vwc ?? pot.current_vwc,
    committed_at: predictedPulse?.committed_at ?? episode.started_at,
    feature_as_of_device_at: predictedPulse?.feature_as_of_device_at ?? episode.started_at,
    irrigation_opened_device_at: episode.started_at,
    model_version: predictedPulse?.model_version ?? modelVersion,
    prediction_lead_seconds: predictedPulse?.prediction_lead_seconds ?? 0,
    curve: predictedPulse?.curve ?? [],
    score: null,
    censored: episode.outcome?.right_censored ?? false,
    confidence: predictedPulse?.confidence ?? "low_confidence",
  };
}

function pulseDuration(pulse: RdIrrigationEvent | null) {
  if (!pulse) return "No pulse selected";
  if (pulse.duration_ms != null) return `${(pulse.duration_ms / 1_000).toFixed(1)}s observed`;
  if (pulse.duration_source === "configured_snapshot") return "Expected duration only";
  return "Actual duration unavailable";
}

function latestMatchedCurvePoint(event: RdLabEvent) {
  return [...event.curve].reverse().find((point) => point.predicted != null && point.actual != null) ?? null;
}

function MiniResponseChart({ event }: { event: RdLabEvent }) {
  const width = 320;
  const height = 132;
  const curve = useMemo(() => relativeCurve(event), [event]);
  const geometry = useMemo(() => {
    const values = curve.flatMap((point) => [point.p10, point.p90, point.predicted, point.actual])
      .filter((value): value is number => value != null && Number.isFinite(value));
    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    const span = Math.max(0.4, maximum - minimum);
    const minY = minimum - span * 0.12;
    const maxY = maximum + span * 0.12;
    const maxMinute = Math.max(...curve.map((point) => point.minute), 1);
    const x = (minute: number) => 10 + (minute / maxMinute) * (width - 20);
    const y = (value: number) => 9 + ((maxY - value) / (maxY - minY)) * (height - 18);
    const bandTop = curve.filter((point) => point.p90 != null).map((point) => `${x(point.minute)},${y(point.p90!)}`);
    const bandBottom = curve.filter((point) => point.p10 != null).reverse().map((point) => `${x(point.minute)},${y(point.p10!)}`);
    return { x, y, band: [...bandTop, ...bandBottom].join(" ") };
  }, [curve]);
  const predictedPath = linePath(curve, (point) => point.predicted, geometry.x, geometry.y);
  const actualPath = linePath(curve, (point) => point.actual, geometry.x, geometry.y);
  const hasBand = curve.some((point) => point.p10 != null && point.p90 != null);

  return (
    <svg className="rd-mini-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Current forecast and measurement for ${event.pairing_name}`}>
      <line x1="10" x2={width - 10} y1={geometry.y(0)} y2={geometry.y(0)} className="rd-mini-zero" />
      {hasBand ? <polygon points={geometry.band} className="rd-confidence-band" /> : null}
      <path d={predictedPath} className="rd-mini-prediction" />
      <path d={actualPath} className="rd-mini-actual" />
    </svg>
  );
}

function potOverviewEvent(pot: RdPotSummary, modelVersion: string) {
  if (pot.active_episode) {
    const latestPrediction = [...pot.active_episode.pulses].reverse().find((pulse) => pulse.prediction)?.prediction;
    return latestPrediction ?? episodeAsEvent(pot, pot.active_episode, modelVersion);
  }
  return pot.next_forecast ?? pot.event ?? waitingEvent(pot, modelVersion);
}

function PotResponseCard({ pot, modelVersion }: { pot: RdPotSummary; modelVersion: string }) {
  const event = potOverviewEvent(pot, modelVersion);
  const latestPulse = pot.active_episode?.pulses.at(-1) ?? null;
  const matched = latestMatchedCurvePoint(event);
  const difference = matched?.predicted == null || matched.actual == null ? null : matched.actual - matched.predicted;
  const note = difference == null
    ? event.curve.length
      ? "Forecast ready · waiting for measurement"
      : "Waiting for forecast"
    : `Measured ${Math.abs(difference).toFixed(2)} points ${difference >= 0 ? "above" : "below"} forecast at ${matched!.minute}m`;

  return (
    <article className="rd-pot-response-card">
      <header>
        <div><strong>{pot.pairing_name}</strong><small>{latestPulse ? `Pulse ${latestPulse.sequence}` : "Next pulse"}</small></div>
        <span>{stateLabel(pot.state)}</span>
      </header>
      <div className="rd-pot-response-values"><span>Current <strong>{formatNumber(pot.current_vwc)}%</strong></span><span>Target <strong>{formatNumber(pot.target_vwc)}%</strong></span></div>
      {event.curve.length ? <MiniResponseChart event={event} /> : <div className="rd-mini-empty">No curve yet</div>}
      <footer><i className="is-predicted" /> Forecast <i className="is-actual" /> Measured</footer>
      <p>{note}</p>
    </article>
  );
}

function LiveResponse({
  pots,
  selectedPot,
  current,
  activeEpisode,
  nextForecast,
  selectedPulse,
  onSelectPulse,
  championVersion,
}: {
  pots: RdPotSummary[];
  selectedPot: RdPotSummary;
  current: RdLabEvent;
  activeEpisode: RdCorrectionEpisode | null;
  nextForecast: RdLabEvent | null;
  selectedPulse: RdIrrigationEvent | null;
  onSelectPulse: (id: string) => void;
  championVersion: string;
}) {
  const chartEvent = selectedPulse?.prediction ?? nextForecast ?? current;
  const distance = selectedPot.current_vwc - selectedPot.target_vwc;
  const distanceWords = Math.abs(distance) < 0.05
    ? "at target"
    : `${Math.abs(distance).toFixed(2)} points ${distance < 0 ? "below" : "above"} target`;
  const matchedPoint = latestMatchedCurvePoint(chartEvent);
  const responseDifference = matchedPoint?.predicted == null || matchedPoint.actual == null
    ? null
    : matchedPoint.predicted - matchedPoint.actual;
  const pulseNumber = selectedPulse?.sequence ?? activeEpisode?.pulse_count ?? 0;
  const responseState = activeEpisode?.status === "observing"
    ? "Final response is still being measured."
    : activeEpisode?.status === "complete"
      ? "The outcome is ready."
      : activeEpisode
        ? "The correction cycle is still active."
        : nextForecast
          ? "The next forecast is ready."
          : "The pot is waiting for its forecast threshold.";
  const modelRead = responseDifference == null
    ? ""
    : ` At the latest shared ${matchedPoint!.minute}-minute checkpoint, forecast VWC is ${Math.abs(responseDifference).toFixed(2)} percentage points ${responseDifference > 0 ? "above" : "below"} measured VWC.`;

  return (
    <>
      <section className="rd-takeaway" aria-label="Plain language status">
        <span>What is happening</span>
        <strong>{selectedPot.pairing_name} is {distanceWords}.</strong>
        <p>{pulseNumber ? `Pulse ${pulseNumber} is recorded. ` : ""}{responseState}{modelRead}</p>
      </section>

      <div className="rd-current-grid">
        <section className="rd-chart-card">
          <div className="rd-chart-title">
            <div>
              <p className="rd-eyebrow">{selectedPulse ? `PULSE ${selectedPulse.sequence}` : nextForecast ? "NEXT PULSE" : "CURRENT POT"}</p>
              <h2>{selectedPulse ? "Forecast vs. measured response" : nextForecast ? "Forecasted response" : "Waiting for a forecast"}</h2>
              <p className="rd-chart-description">Moisture change after one water pulse. Each line starts from its own first available forecast or measurement.</p>
            </div>
            <span className="rd-status-chip">{stateLabel(selectedPot.state)}</span>
          </div>

          {activeEpisode?.pulses.length ? (
            <div className="rd-pulse-rail" aria-label="Choose a water pulse">
              {activeEpisode.pulses.slice(-10).map((pulse) => (
                <button key={pulse.id} type="button" className={selectedPulse?.id === pulse.id ? "is-active" : ""} onClick={() => onSelectPulse(pulse.id)}>
                  <strong>P{pulse.sequence}</strong>
                  <small>{pulse.prediction ? "Forecast frozen" : "Forecast missed"}</small>
                </button>
              ))}
            </div>
          ) : null}

          {chartEvent.curve.length ? (
            <ResponseCurveChart event={chartEvent} />
          ) : (
            <div className="rd-empty-chart">
              <strong>No response curve yet</strong>
              <span>The model will freeze a forecast before the next pulse.</span>
            </div>
          )}

          <div className="rd-causal-strip">
            <Clock3 size={15} />
            <span>Latest reading <strong>{formatTime(selectedPot.last_reading_at)}</strong></span>
            <span>Selected pulse <strong>{formatTime(selectedPulse?.opened_at)}</strong></span>
            <span>Response window <strong>{activeEpisode ? formatTime(activeEpisode.observation_ends_at) : "Not open"}</strong></span>
          </div>
        </section>

        <aside className="rd-side-stack">
          <section className="rd-side-card">
            <div className="rd-card-heading"><span>Selected pulse</span></div>
            <dl className="rd-model-list">
              <div><dt>Water pulse</dt><dd>{selectedPulse ? `#${selectedPulse.sequence}` : "None yet"}</dd></div>
              <div><dt>Forecast</dt><dd>{selectedPulse?.prediction ? "Frozen before pulse" : selectedPulse ? "Missed" : "Not applicable"}</dd></div>
              <div><dt>Freeze lead</dt><dd>{formatLead(selectedPulse?.prediction_lead_seconds)}</dd></div>
              <div><dt>Pulse duration</dt><dd>{pulseDuration(selectedPulse)}</dd></div>
            </dl>
          </section>
          <section className="rd-side-card">
            <div className="rd-card-heading"><span>Correction cycle</span></div>
            <dl className="rd-model-list">
              <div><dt>Status</dt><dd>{activeEpisode ? stateLabel(`episode_${activeEpisode.status}`) : "No active cycle"}</dd></div>
              <div><dt>Water pulses</dt><dd>{activeEpisode?.pulse_count ?? 0}</dd></div>
              <div><dt>Frozen forecasts</dt><dd>{activeEpisode ? `${activeEpisode.pulse_count - activeEpisode.missed_forecasts}/${activeEpisode.pulse_count}` : "—"}</dd></div>
              <div><dt>Model role</dt><dd>{modelName(championVersion)} current model</dd></div>
            </dl>
          </section>
          <details className="rd-technical-details">
            <summary>Technical details</summary>
            <dl className="rd-model-list">
              <div><dt>Raw state</dt><dd>{selectedPot.state}</dd></div>
              <div><dt>Model artifact</dt><dd title={chartEvent.model_version}>{chartEvent.model_version}</dd></div>
              <div><dt>Prediction ID</dt><dd title={chartEvent.id}>{chartEvent.id}</dd></div>
            </dl>
          </details>
        </aside>
      </div>

      <section className="rd-live-overview">
        <div className="rd-live-overview-heading"><div><p className="rd-eyebrow">ALL POTS</p><h2>Current forecasts and measurements</h2></div><span>Purple = forecast · Green = measured</span></div>
        <div className="rd-live-overview-grid">
          {pots.map((pot) => <PotResponseCard key={pot.pairing_name} pot={pot} modelVersion={championVersion} />)}
        </div>
      </section>
    </>
  );
}

function HistoryView({ pot }: { pot: RdPotSummary }) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const episodes = (pot.episodes ?? []).filter((episode) => {
    if (filter === "training") return episode.outcome?.eligible_for_training === true;
    if (filter === "excluded") return episode.outcome != null && episode.outcome.eligible_for_training !== true;
    return true;
  });

  return (
    <section className="rd-history-panel">
      <div className="rd-section-heading">
        <div><p className="rd-eyebrow">{pot.pairing_name}</p><h2>Past correction cycles</h2><p>Each row explains what happened and whether the outcome passed training-quality gates.</p></div>
        <div className="rd-filter-group" aria-label="Filter past cycles">
          {(["all", "training", "excluded"] as const).map((item) => (
            <button key={item} type="button" className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>
              {item === "all" ? "All" : item === "training" ? "Training eligible" : "Excluded"}
            </button>
          ))}
        </div>
      </div>

      <div className="rd-history-table" role="table" aria-label="Past correction cycles">
        <div className="rd-history-head" role="row">
          <span>Started</span><span>Water pulses</span><span>Status</span><span>Forecasts</span><span>Training eligibility</span>
        </div>
        {episodes.length ? episodes.map((episode) => {
          const forecasts = episode.pulse_count - episode.missed_forecasts;
          const outcome = episode.outcome;
          const reasons = outcome?.quality_reasons.map(qualityReason) ?? [];
          const trainingText = !outcome
            ? "Outcome not ready"
            : outcome.eligible_for_training
              ? "Eligible"
              : `Excluded — ${reasons[0] ?? "quality gate not passed"}`;
          const trainingDetail = !outcome
            ? "Outcome not finalized"
            : outcome.eligible_for_training
              ? "Passed quality gates"
              : "Reason shown below";
          return (
            <details key={episode.id} className="rd-history-row">
              <summary>
                <span><strong>{formatTime(episode.started_at)}</strong><small>{episode.pairing_name}</small></span>
                <span><strong>{episode.pulse_count}</strong><small>pulses</small></span>
                <span><strong>{stateLabel(`episode_${episode.status}`)}</strong><small>{episode.completed_at ? `Ended ${formatTime(episode.completed_at)}` : "Still open"}</small></span>
                <span><strong>{forecasts}/{episode.pulse_count}</strong><small>frozen in time</small></span>
                <span className={outcome?.eligible_for_training ? "is-included" : "is-excluded"}><strong>{trainingText}</strong><small>{trainingDetail}</small></span>
              </summary>
              <div className="rd-history-detail">
                <span>Full response captured?<strong>{outcome == null ? "Not yet" : outcome.right_censored ? "No" : "Yes"}</strong></span>
                <span>Observed horizons<strong>{outcome?.observed_horizons ?? "—"}</strong></span>
                <span>Scored by<strong>{episode.score ? `${modelName(episode.score.model_version)} ${modelRoleLabel(episode.score.model_role)}` : "Not scored"}</strong></span>
                <span>Measured error<strong>{episode.score?.curve_mae == null ? "—" : `${episode.score.curve_mae.toFixed(3)} MAE`}</strong></span>
                {reasons.length ? <p><strong>Why excluded:</strong> {reasons.join("; ")}.</p> : null}
              </div>
            </details>
          );
        }) : <div className="rd-empty-panel">No cycles match this filter for {pot.pairing_name}.</div>}
      </div>
    </section>
  );
}

function MetricValue({ value }: { value: number | null }) {
  return <>{value == null ? "—" : value.toFixed(3)}</>;
}

function ComparisonSegment({ title, subtitle, segment }: { title: string; subtitle: string; segment: RdModelSegment }) {
  const candidateWins = segment.candidate_mae != null && segment.champion_mae != null && segment.candidate_mae < segment.champion_mae;
  return (
    <article className="rd-comparison-segment">
      <div className="rd-comparison-segment-title">
        <div><strong>{title}</strong><small>{subtitle} · {segment.event_count} events</small></div>
        <span className={candidateWins ? "is-pass" : "is-fail"}>{candidateWins ? "Test model ahead" : "Current model ahead"}</span>
      </div>
      <div className="rd-score-compare">
        <span>Test model MAE<strong><MetricValue value={segment.candidate_mae} /></strong></span>
        <span>Current model MAE<strong><MetricValue value={segment.champion_mae} /></strong></span>
        <span>Do-nothing MAE<strong><MetricValue value={segment.zero_mae} /></strong></span>
      </div>
      <div className="rd-score-foot">
        <span>Signed bias <strong>{segment.candidate_signed_bias == null ? "—" : `${segment.candidate_signed_bias > 0 ? "+" : ""}${segment.candidate_signed_bias.toFixed(3)}`}</strong></span>
        <span>80% range coverage <strong>{segment.interval_coverage == null ? "—" : `${Math.round(segment.interval_coverage * 100)}%`}</strong></span>
      </div>
    </article>
  );
}

function CandidateTrend({ snapshot }: { snapshot: RdLabSnapshot }) {
  const points = snapshot.progress.filter((point) => point.curve_mae != null);
  if (!points.length) return <div className="rd-empty-panel">No test-model scores yet.</div>;
  const width = 820;
  const height = 190;
  const max = Math.max(...points.map((point) => point.curve_mae!), 0.25);
  const path = points.map((point, index) => {
    const x = 46 + (index / Math.max(1, points.length - 1)) * (width - 72);
    const y = 22 + (1 - point.curve_mae! / max) * (height - 58);
    return `${index ? "L" : "M"}${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="rd-progress-chart" role="img" aria-label="Test-model error in chronological order">
      <line x1="46" x2={width - 26} y1={height - 36} y2={height - 36} className="rd-grid-line" />
      <line x1="46" x2={width - 26} y1="22" y2="22" className="rd-grid-line" />
      <text x="38" y="26" textAnchor="end" className="rd-axis-label">{max.toFixed(2)}</text>
      <text x="38" y={height - 32} textAnchor="end" className="rd-axis-label">0</text>
      <text x="46" y={height - 12} className="rd-axis-label">OLDEST</text>
      <text x={width - 26} y={height - 12} textAnchor="end" className="rd-axis-label">NEWEST</text>
      <path d={path} className="rd-progress-line" />
    </svg>
  );
}

function ModelComparison({ snapshot }: { snapshot: RdLabSnapshot }) {
  const learning = snapshot.learning;
  const comparison = snapshot.model_comparison;
  const correctionLosing = comparison?.correction_pulses?.candidate_mae != null &&
    comparison.correction_pulses.champion_mae != null &&
    comparison.correction_pulses.candidate_mae > comparison.correction_pulses.champion_mae;
  const candidate = comparison?.evaluation_candidate_version ?? snapshot.candidate_version;
  const challenger = comparison?.latest_challenger_version ?? null;
  const summary = `${modelName(snapshot.champion_version)} is the current model.`;
  const decisionDetail = !candidate
    ? "No test model is active."
    : correctionLosing
      ? `${modelName(candidate)} loses on correction pulses${challenger && challenger !== candidate ? ` · ${modelName(challenger)} needs fresh data` : ""}`
      : `${modelName(candidate)} is still being tested.`;

  return (
    <section className="rd-model-panel">
      <div className="rd-model-verdict">
        <h2>{summary}</h2>
        <p>{decisionDetail}</p>
      </div>

      <div className="rd-role-grid">
        <article className="is-champion"><span>Current model</span><strong>{modelName(snapshot.champion_version)}</strong><p>Best verified model</p><details><summary>Full ID</summary><code>{snapshot.champion_version}</code></details></article>
        <article className="is-candidate"><span>Test model</span><strong>{modelName(candidate)}</strong><p>{candidate ? correctionLosing ? "Worse on correction pulses" : "Still being tested" : "None"}</p>{candidate ? <details><summary>Full ID</summary><code>{candidate}</code></details> : null}</article>
        <article><span>Next test model</span><strong>{modelName(challenger)}</strong><p>{challenger ? "Needs fresh data" : "None"}</p>{challenger ? <details><summary>Full ID</summary><code>{challenger}</code></details> : null}</article>
      </div>

      <div className="rd-model-section-heading"><div><p className="rd-eyebrow">MODEL EVIDENCE</p><h2>Does the test model beat the current model?</h2></div><p>Lower mean absolute error (MAE) is better.</p></div>
      {comparison ? (
        <div className="rd-comparison-grid">
          {comparison.overall ? <ComparisonSegment title="All pulses" subtitle="Whole evaluation" segment={comparison.overall} /> : null}
          {comparison.first_pulses ? <ComparisonSegment title="First pulses" subtitle="Initial response" segment={comparison.first_pulses} /> : null}
          {comparison.correction_pulses ? <ComparisonSegment title="Correction pulses" subtitle="Repeated watering" segment={comparison.correction_pulses} /> : null}
        </div>
      ) : (
        <div className="rd-data-notice"><strong>Comparison scores are not in this snapshot yet.</strong><span>The current API sends test-model error but not matched current-model and do-nothing scores. The UI will not guess.</span></div>
      )}

      <div className="rd-readiness-grid">
        <section>
          <div className="rd-card-heading"><span>Ready to replace current model</span></div>
          <div className="rd-gate-list">
            <span><i className={(comparison?.qualified_windows ?? learning?.qualified_chronological_windows ?? 0) >= (comparison?.required_windows ?? learning?.required_chronological_windows ?? 2) ? "is-pass" : "is-fail"} />Evaluation windows<strong>{comparison?.qualified_windows ?? learning?.qualified_chronological_windows ?? 0}/{comparison?.required_windows ?? learning?.required_chronological_windows ?? 2}</strong></span>
            <span><i className={(comparison?.first_pulse_pot_count ?? 0) >= (comparison?.required_first_pulse_pots ?? 8) ? "is-pass" : "is-wait"} />First-pulse pot coverage<strong>{comparison ? `${comparison.first_pulse_pot_count}/${comparison.required_first_pulse_pots}` : "Awaiting API"}</strong></span>
            <span><i className={learning?.interval_calibrated ? "is-pass" : "is-wait"} />Uncertainty range<strong>{learning?.current_interval_coverage == null ? "Not calibrated" : `${Math.round(learning.current_interval_coverage * 100)}% coverage`}</strong></span>
          </div>
        </section>
        <section>
          <div className="rd-card-heading"><span>Training readiness</span></div>
          <div className="rd-gate-list">
            <span><i className="is-pass" />Outcomes measured<strong>{learning?.eligible_episode_totals ?? snapshot.clean_events_learned}</strong></span>
            <span><i className={(learning?.represented_control_pots ?? 0) >= (learning?.required_control_pots ?? 8) ? "is-pass" : "is-wait"} />Control pots represented<strong>{learning?.represented_control_pots ?? 0}/{learning?.required_control_pots ?? 8}</strong></span>
            <span><i className={(learning?.multi_pulse_episodes ?? 0) >= (learning?.required_multi_pulse_episodes ?? 10) ? "is-pass" : "is-wait"} />Correction-pulse evidence<strong>{learning?.multi_pulse_episodes ?? 0}/{learning?.required_multi_pulse_episodes ?? 10}</strong></span>
            <span><i className={(learning?.calendar_span_days ?? 0) >= (learning?.required_calendar_span_days ?? 3) ? "is-pass" : "is-wait"} />Calendar span<strong>{formatNumber(learning?.calendar_span_days, 1)}/{learning?.required_calendar_span_days ?? 3} days</strong></span>
          </div>
        </section>
      </div>

      <details className="rd-trend-details">
        <summary>Show test-model error over time</summary>
        <div><p>Each point is one measured outcome in time order. This is diagnostic evidence, not a promotion decision by itself.</p><CandidateTrend snapshot={snapshot} /></div>
      </details>
    </section>
  );
}

export function ResponseCurveLab({ snapshot, onBack }: { snapshot: RdLabSnapshot; onBack?: () => void }) {
  const [tab, setTab] = useState<LabTab>("live");
  const pots = useMemo(() => fallbackPots(snapshot), [snapshot]);
  const [selectedName, setSelectedName] = useState(snapshot.current.pairing_name);
  const [selectedPulseId, setSelectedPulseId] = useState<string | null>(null);
  const selectedPot = pots.find((pot) => pot.pairing_name === selectedName) ?? pots[0];
  const activeEpisode = selectedPot?.active_episode ?? null;
  const nextForecast = selectedPot?.next_forecast ?? null;
  const current = activeEpisode && selectedPot
    ? episodeAsEvent(selectedPot, activeEpisode, snapshot.champion_version)
    : nextForecast ?? selectedPot?.event ?? (selectedPot ? waitingEvent(selectedPot, snapshot.champion_version) : snapshot.current);
  const selectedPulse = activeEpisode?.pulses.find((pulse) => pulse.id === selectedPulseId) ?? activeEpisode?.pulses.at(-1) ?? null;
  const measuringCount = pots.filter((pot) => ["episode_active", "episode_observing", "tracking_response"].includes(pot.state)).length;
  const readyCount = pots.filter((pot) => ["armed_early", "armed_refresh"].includes(pot.state)).length;

  if (!selectedPot) return <section className="rd-empty-panel">No control pots are available.</section>;

  return (
    <section className="rd-lab-main" aria-label="ExactH2O shadow response model">
      <header className="rd-lab-header">
        {onBack ? <button type="button" className="support-back-button" onClick={onBack}><ArrowLeft size={14} /> Home</button> : null}
        <div className="rd-lab-title-row">
          <div><h1>Response Curve</h1></div>
          <div className="rd-lab-summary"><span><strong>{measuringCount}</strong> measuring</span><span><strong>{readyCount}</strong> forecasts ready</span><span><strong>{pots.length}</strong> control pots</span></div>
        </div>
        <nav className="rd-tabs" aria-label="Response model views">
          {(["live", "history", "models"] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>
              {item === "live" ? "Live response" : item === "history" ? "Past cycles" : "Model comparison"}
            </button>
          ))}
        </nav>
      </header>

      {tab !== "models" ? (
        <section className="rd-pot-toolbar" aria-label="Choose a pot">
          <label><span>Pot</span><select value={selectedPot.pairing_name} onChange={(event) => { setSelectedName(event.target.value); setSelectedPulseId(null); }}>{pots.map((pot) => <option key={pot.pairing_name} value={pot.pairing_name}>{pot.pairing_name}</option>)}</select></label>
          <span>Current<strong>{formatNumber(selectedPot.current_vwc)}%</strong></span>
          <span>Target<strong>{formatNumber(selectedPot.target_vwc)}%</strong></span>
          <span>Status<strong>{stateLabel(selectedPot.state)}</strong></span>
        </section>
      ) : null}

      {tab === "live" ? <LiveResponse pots={pots} selectedPot={selectedPot} current={current} activeEpisode={activeEpisode} nextForecast={nextForecast} selectedPulse={selectedPulse} onSelectPulse={setSelectedPulseId} championVersion={snapshot.champion_version} /> : null}
      {tab === "history" ? <HistoryView key={selectedPot.pairing_name} pot={selectedPot} /> : null}
      {tab === "models" ? <ModelComparison snapshot={snapshot} /> : null}
    </section>
  );
}
