import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  FlaskConical,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { RdCurvePoint, RdLabEvent, RdLabSnapshot } from "./rdTypes";

type LabTab = "current" | "history" | "progress";

const chartWidth = 980;
const chartHeight = 430;
const pad = { left: 64, right: 28, top: 32, bottom: 52 };

function formatNumber(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatTime(value: string | null) {
  if (!value) return "Awaiting event";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function stateLabel(value: string) {
  return value.replace(/_/g, " ").toUpperCase();
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
  return (
    <section className="rd-side-card">
      <div className="rd-card-heading"><CheckCircle2 size={16} /><span>Prediction score</span></div>
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
          <strong>Waiting for the complete response</strong>
          <p>The committed forecast is locked. Scores appear as observed horizons arrive.</p>
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
      <div>
        <p className="rd-eyebrow">HELD-OUT EVENT ERROR</p>
        <h2>Model improvement</h2>
        <p>Lower curve error is better. Censored and incomplete events are excluded.</p>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="rd-progress-chart" role="img" aria-label="Recent curve error trend">
        <line x1="34" x2={width - 34} y1={height - 36} y2={height - 36} className="rd-grid-line" />
        <path d={path} className="rd-progress-line" />
        {points.map((point, index) => {
          const x = 34 + (index / Math.max(1, points.length - 1)) * (width - 68);
          const y = 24 + (point.curve_mae! / max) * (height - 68);
          return <circle key={`${point.index}-${point.event}`} cx={x} cy={y} r="4" className="rd-progress-point"><title>{`${point.event}: ${point.curve_mae}`}</title></circle>;
        })}
      </svg>
    </section>
  );
}

export function ResponseCurveLab({ snapshot, onBack }: { snapshot: RdLabSnapshot; onBack?: () => void }) {
  const [tab, setTab] = useState<LabTab>("current");
  const current = snapshot.current;
  return (
    <section className="rd-lab-main" aria-label="ExactH2O response curve laboratory">
      <header className="rd-lab-header">
        <div className="rd-lab-heading-row">
          <div>
            {onBack ? <button type="button" className="support-back-button" onClick={onBack}><ArrowLeft size={14} /> Home</button> : null}
            <p className="rd-eyebrow"><FlaskConical size={14} /> EXACTH2O R&amp;D</p>
            <h1>Response Curve Lab</h1>
            <p>Watch the shadow model predict, observe, score, and learn from eligible irrigation episodes.</p>
          </div>
          <div className="rd-shadow-badge"><ShieldCheck size={16} /><span><strong>SHADOW MODE</strong>No irrigation control</span></div>
        </div>
        <nav className="rd-tabs" aria-label="R&D views">
          {(["current", "history", "progress"] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>
              {item === "current" ? "Current Event" : item === "history" ? "Event History" : "Model Progress"}
            </button>
          ))}
        </nav>
      </header>

      {tab === "current" ? (
        <>
          <section className="rd-event-banner">
            <div className="rd-event-icon"><BrainCircuit size={22} /></div>
            <div><p>{current.pairing_name}</p><h2>{stateLabel(current.state)}</h2></div>
            <div className="rd-event-banner-facts">
              <span>Target<strong>{current.target_vwc.toFixed(1)}%</strong></span>
              <span>Armed at<strong>{current.trigger_vwc.toFixed(2)}%</strong></span>
              <span>Lead time<strong>{current.irrigation_opened_device_at ? `${Math.round(current.prediction_lead_seconds / 60)} min` : "Pending"}</strong></span>
              <span>Model<strong>{current.model_version}</strong></span>
            </div>
          </section>
          <div className="rd-current-grid">
            <section className="rd-chart-card">
              <div className="rd-chart-title"><div><p className="rd-eyebrow">IRRIGATION RESPONSE</p><h2>Prediction vs. reality</h2></div><span className="rd-status-chip"><span className="rd-live-dot" /> SHADOW OBSERVER</span></div>
              <ResponseCurveChart event={current} />
              <div className="rd-causal-strip">
                <Clock3 size={15} />
                <span>Features frozen <strong>{formatTime(current.feature_as_of_device_at)}</strong></span>
                <span>Prediction committed <strong>{formatTime(current.committed_at)}</strong></span>
                <span>Irrigation opened <strong>{formatTime(current.irrigation_opened_device_at)}</strong></span>
              </div>
            </section>
            <aside className="rd-side-stack">
              <ScoreCard event={current} />
              <section className="rd-side-card">
                <div className="rd-card-heading"><Sparkles size={16} /><span>Learning state</span></div>
                <div className="rd-learning-count"><strong>{snapshot.clean_events_learned}</strong><span>clean events learned</span></div>
                <dl className="rd-model-list">
                  <div><dt>Champion</dt><dd>{snapshot.champion_version}</dd></div>
                  <div><dt>Candidate</dt><dd>{snapshot.candidate_version ?? "None"}</dd></div>
                  <div><dt>Confidence</dt><dd>{current.confidence === "trained_range" ? "Within trained range" : "Low confidence"}</dd></div>
                </dl>
              </section>
            </aside>
          </div>
        </>
      ) : null}

      {tab === "history" ? (
        <section className="rd-history-panel">
          <div className="rd-section-intro"><p className="rd-eyebrow">IMMUTABLE FORECAST RECORD</p><h2>Recent irrigation responses</h2><p>Each score comes from a prediction committed before its valve-open timestamp.</p></div>
          <div className="rd-history-list">
            {snapshot.history.map((event) => (
              <article key={event.id}>
                <span className="rd-history-icon"><BrainCircuit size={16} /></span>
                <div><strong>{event.pairing_name}</strong><small>{formatTime(event.irrigation_opened_device_at)}</small></div>
                <span>{event.censored ? "CENSORED" : "COMPLETE"}</span>
                <dl><div><dt>Curve MAE</dt><dd>{formatNumber(event.score?.curve_mae)}</dd></div><div><dt>Coverage</dt><dd>{event.score?.interval_coverage == null ? "—" : `${Math.round(event.score.interval_coverage * 100)}%`}</dd></div></dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "progress" ? <ProgressChart snapshot={snapshot} /> : null}
    </section>
  );
}
