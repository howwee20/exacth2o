import { ArrowLeft, BrainCircuit, CheckCircle2, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  RdCurvePoint,
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

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function stateLabel(value: string) {
  const labels: Record<string, string> = {
    waiting_threshold: "Waiting",
    armed_early: "Early forecast",
    armed_refresh: "Forecast armed",
    committed: "Irrigation detected",
    tracking_response: "Observing response",
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

function ResponseCurveChart({ event }: { event: RdLabEvent }) {
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
        <span><i className="is-predicted" /> Prediction</span>
        <span><i className="is-actual" /> Reality</span>
        <span><i className="is-band" /> 80% range</span>
      </div>
      <svg className="rd-curve-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`Predicted and actual VWC response for ${event.pairing_name}`}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={chartWidth - pad.right} y1={geometry.y(tick)} y2={geometry.y(tick)} className="rd-grid-line" />
            <text x={pad.left - 12} y={geometry.y(tick) + 4} textAnchor="end" className="rd-axis-label">{tick.toFixed(1)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={tick}>
            <line x1={geometry.x(tick)} x2={geometry.x(tick)} y1={pad.top} y2={chartHeight - pad.bottom} className="rd-grid-line is-vertical" />
            <text x={geometry.x(tick)} y={chartHeight - 22} textAnchor="middle" className="rd-axis-label">{tick === 0 ? "IRRIGATION" : `${tick}m`}</text>
          </g>
        ))}
        <line x1={pad.left} x2={chartWidth - pad.right} y1={geometry.y(event.target_vwc)} y2={geometry.y(event.target_vwc)} className="rd-target-line" />
        <text x={chartWidth - pad.right} y={geometry.y(event.target_vwc) - 8} textAnchor="end" className="rd-target-label">TARGET {event.target_vwc.toFixed(1)}</text>
        <polygon points={geometry.band} className="rd-confidence-band" />
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

function ScoreCard({ event }: { event: RdLabEvent }) {
  const score = event.score;
  const observed = event.curve.filter((point) => point.actual != null).length;
  return (
    <section className="rd-side-card">
      <div className="rd-card-heading"><CheckCircle2 size={16} /><span>Score</span></div>
      {score ? (
        <dl className="rd-score-grid">
          <div><dt>Curve MAE</dt><dd>{formatNumber(score.curve_mae)}</dd></div>
          <div><dt>Peak error</dt><dd>{formatNumber(score.peak_error)}</dd></div>
          <div><dt>Peak timing</dt><dd>{formatNumber(score.time_to_peak_error_minutes, 0)} min</dd></div>
          <div><dt>80% coverage</dt><dd>{score.interval_coverage == null ? "—" : `${Math.round(score.interval_coverage * 100)}%`}</dd></div>
        </dl>
      ) : (
        <div className="rd-waiting-copy">
          <span className="rd-live-dot" />
          <strong>{observed} observed horizons</strong>
          <p>Final score at 240 minutes.</p>
        </div>
      )}
    </section>
  );
}

function ProgressChart({ snapshot }: { snapshot: RdLabSnapshot }) {
  const points = snapshot.progress.filter((point) => point.curve_mae != null);
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
      <div><p className="rd-eyebrow">MODEL ERROR</p><h2>Learning progress</h2><p>Lower curve error is better.</p></div>
      {points.length ? (
        <svg viewBox={`0 0 ${width} ${height}`} className="rd-progress-chart" role="img" aria-label="Recent curve error trend">
          <line x1="34" x2={width - 34} y1={height - 36} y2={height - 36} className="rd-grid-line" />
          <path d={path} className="rd-progress-line" />
          {points.map((point, index) => {
            const x = 34 + (index / Math.max(1, points.length - 1)) * (width - 68);
            const y = 24 + (point.curve_mae! / max) * (height - 68);
            return <circle key={`${point.index}-${point.event}`} cx={x} cy={y} r="4" className="rd-progress-point"><title>{`${point.event}: ${point.curve_mae}`}</title></circle>;
          })}
        </svg>
      ) : <div className="rd-empty-panel">No completed curves yet.</div>}
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

export function ResponseCurveLab({ snapshot, onBack }: { snapshot: RdLabSnapshot; onBack?: () => void }) {
  const [tab, setTab] = useState<LabTab>("pots");
  const pots = useMemo(() => fallbackPots(snapshot), [snapshot]);
  const [selectedName, setSelectedName] = useState(snapshot.current.pairing_name);
  const selectedPot = pots.find((pot) => pot.pairing_name === selectedName) ?? pots[0];
  const current = selectedPot?.event ?? (selectedPot ? waitingEvent(selectedPot, snapshot.champion_version) : snapshot.current);
  const selectedHistory = snapshot.history.filter((event) => event.pairing_name === current.pairing_name);

  return (
    <section className="rd-lab-main" aria-label="ExactH2O response curve laboratory">
      <header className="rd-lab-header">
        {onBack ? <button type="button" className="support-back-button" onClick={onBack}><ArrowLeft size={14} /> Home</button> : null}
        <div className="rd-lab-title-row">
          <div><p className="rd-eyebrow">EXACTH2O R&amp;D · {pots.length} POTS</p><h1>Response Curve Lab</h1></div>
          <div className="rd-lab-summary"><strong>{snapshot.clean_events_learned}</strong><span>clean events</span></div>
        </div>
        <nav className="rd-tabs" aria-label="R&D views">
          {(["pots", "history", "progress"] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>
              {item === "pots" ? "Live Pots" : item === "history" ? "Event History" : "Model Learning"}
            </button>
          ))}
        </nav>
      </header>

      <section className="rd-pot-panel" aria-label="Select a pot">
        {pots.map((pot) => (
          <button key={pot.pairing_name} type="button" className={`rd-pot-button ${pot.pairing_name === current.pairing_name ? "is-active" : ""}`} onClick={() => setSelectedName(pot.pairing_name)}>
            <span><strong>{pot.pairing_name}</strong><small>{stateLabel(pot.state)}</small></span>
            <span><strong>{formatNumber(pot.current_vwc)}</strong><small>target {formatNumber(pot.target_vwc, 0)}</small></span>
          </button>
        ))}
      </section>

      {tab === "pots" ? (
        <>
          <section className="rd-event-banner">
            <div className="rd-event-icon"><BrainCircuit size={22} /></div>
            <div><p>{current.pairing_name}</p><h2>{stateLabel(current.state)}</h2></div>
            <div className="rd-event-banner-facts">
              <span>Current<strong>{formatNumber(selectedPot?.current_vwc)}%</strong></span>
              <span>Target<strong>{current.target_vwc.toFixed(1)}%</strong></span>
              <span>Distance<strong>{formatNumber(selectedPot?.distance_to_target)}%</strong></span>
              <span>Model<strong>{current.model_version}</strong></span>
            </div>
          </section>
          <div className="rd-current-grid">
            <section className="rd-chart-card">
              <div className="rd-chart-title"><div><p className="rd-eyebrow">{current.pairing_name}</p><h2>Prediction vs. reality</h2></div><span className="rd-status-chip">{stateLabel(current.state)}</span></div>
              {current.curve.length ? <ResponseCurveChart event={current} /> : (
                <div className="rd-empty-chart"><strong>Waiting for threshold</strong><span>Early forecast at target +0.3. Refresh at target +0.1.</span></div>
              )}
              <div className="rd-causal-strip">
                <Clock3 size={15} />
                <span>Reading <strong>{formatTime(current.feature_as_of_device_at)}</strong></span>
                <span>Forecast <strong>{formatTime(current.committed_at)}</strong></span>
                <span>Irrigation <strong>{formatTime(current.irrigation_opened_device_at)}</strong></span>
              </div>
            </section>
            <aside className="rd-side-stack">
              <ScoreCard event={current} />
              <section className="rd-side-card">
                <div className="rd-card-heading"><span>Model</span></div>
                <dl className="rd-model-list">
                  <div><dt>Baseline</dt><dd>{snapshot.champion_version}</dd></div>
                  <div><dt>Candidate</dt><dd>{snapshot.candidate_version ?? "None"}</dd></div>
                  <div><dt>Confidence</dt><dd>{current.confidence === "trained_range" ? "Trained range" : "Low"}</dd></div>
                </dl>
              </section>
            </aside>
          </div>
        </>
      ) : null}

      {tab === "history" ? (
        <section className="rd-history-panel">
          <div className="rd-section-intro"><p className="rd-eyebrow">{current.pairing_name}</p><h2>Event history</h2></div>
          <div className="rd-history-list">
            {selectedHistory.length ? selectedHistory.map((event) => (
              <article key={event.id}>
                <span className="rd-history-icon"><BrainCircuit size={16} /></span>
                <div><strong>{event.pairing_name}</strong><small>{formatTime(event.irrigation_opened_device_at)}</small></div>
                <span>{stateLabel(event.state)}</span>
                <dl><div><dt>Curve MAE</dt><dd>{formatNumber(event.score?.curve_mae)}</dd></div><div><dt>Coverage</dt><dd>{event.score?.interval_coverage == null ? "—" : `${Math.round(event.score.interval_coverage * 100)}%`}</dd></div></dl>
              </article>
            )) : <div className="rd-empty-panel">No completed events for this pot.</div>}
          </div>
        </section>
      ) : null}

      {tab === "progress" ? <ProgressChart snapshot={snapshot} /> : null}
    </section>
  );
}
