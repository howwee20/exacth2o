import { type ReactNode, useMemo } from "react";
import { levelLabel } from "../experimentFactors";
import { experimentIsCompleted, pairingTargetText } from "../experimentMeasurement";
import { isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { formatCadence, formatMeasurementTime, measurementFreshness } from "../measurementFreshness";
import { setPortalQuery, usePortalQueryValue } from "../portalRoute";
import type { PotMatch } from "../potIdentity";
import { decimateForDisplay } from "../seriesStatistics";
import { pairingWateringDisabled } from "../targetPresentation";
import type { SensorReading, ValveEvent } from "../types";
import { availableMeasures, measures, potTraces, type Measure } from "../waterline";
import { PortalLink, useCopyRoute } from "./PortalLink";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { formatMeasureValue } from "./WaterlineOverview";
import "./product.css";

const hour = 3_600_000;

export function potReadingSentence(input: {
  potNumber: number;
  value: number | null;
  measuredAt: number | null;
  freshnessState: string;
  freshnessDetail: string;
  target: string | null;
}) {
  if (input.value == null || input.measuredAt == null) return `Pot ${input.potNumber} has no reading in the loaded window.`;
  if (input.value < 0 || input.value > 100) return `Pot ${input.potNumber}: invalid VWC reading ${input.value.toFixed(1)}%, outside 0–100%.${input.target ? ` ${input.target}.` : ""}`;
  const reading = `${input.value.toFixed(1)}% VWC at ${formatMeasurementTime(input.measuredAt)}`;
  const state = input.freshnessState === "current" ? "current" : input.freshnessDetail.replace(/\.$/, "").toLowerCase();
  return `Pot ${input.potNumber}: ${reading} (${state}).${input.target ? ` ${input.target}.` : ""}`;
}

export function PotPage({
  match,
  readings,
  valveEvents,
  nowMs,
  asOfMs,
  loadedWindowMs,
  backTo,
  children,
}: {
  match: PotMatch;
  /** Readings for this pot (any experiment). */
  readings: readonly SensorReading[];
  valveEvents: readonly ValveEvent[];
  nowMs: number;
  asOfMs: number | null;
  loadedWindowMs: number;
  backTo: { label: string; route: Parameters<typeof PortalLink>[0]["to"] };
  /** Extra sections (notes, physical identity) supplied by the caller. */
  children?: ReactNode;
}) {
  const { pairing, current: experiment, assignment } = match;
  const { copied, copy } = useCopyRoute();
  const measureParam = usePortalQueryValue("measure") as Measure | null;
  const available = useMemo(() => availableMeasures(readings), [readings]);
  const measure: Measure = measureParam && available.includes(measureParam) ? measureParam : available[0] ?? "vwc";
  const trace = useMemo(() => potTraces(readings, [pairing], measure).get(pairing.name), [measure, pairing, readings]);
  const vwcTrace = useMemo(() => potTraces(readings, [pairing], "vwc").get(pairing.name), [pairing, readings]);
  const window = { startMs: nowMs - loadedWindowMs, endMs: nowMs };
  const latestVwc = vwcTrace?.points.length ? vwcTrace.points[vwcTrace.points.length - 1] : null;
  const completed = experiment ? experimentIsCompleted(experiment, nowMs) : false;
  const freshness = measurementFreshness({
    measuredAt: latestVwc?.timestampMs,
    expectedIntervalMs: pairing.measurement_interval_ms,
    completed,
    nowMs: asOfMs ?? nowMs,
  });
  const disabled = pairingWateringDisabled(pairing);
  const sensingPlan = experiment ? isObservationOnlyExperiment(experiment) : false;
  const sensing = sensingPlan && disabled;
  const plan = assignment?.target_vwc_percent ?? null;
  const targetText = completed
    ? `Experiment complete${plan != null ? ` · recorded target ${plan}% VWC` : ""}`
    : disabled ? "Watering disabled on the controller"
      : `${experiment ? pairingTargetText(pairing, experiment) : `Controller target ${pairing.wtc_percent_limit}% VWC`}${!sensingPlan && plan != null && Math.abs(plan - pairing.wtc_percent_limit) > 0.001 ? ` · plan ${plan}%` : ""}`;
  const invalidVwc = latestVwc != null && (latestVwc.value < 0 || latestVwc.value > 100);
  const opens = valveEvents
    .filter((event) => event.action === "open")
    .map((event) => Date.parse(event.device_recorded_at ?? event.server_received_at))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b);
  const opens24 = opens.filter((at) => at >= nowMs - 24 * hour).length;
  const lastOpen = opens.length ? opens[opens.length - 1] : null;
  const info = measures[measure];
  const points = (trace?.points ?? []).filter((point) => point.timestampMs >= window.startMs);
  const values = points.map((point) => point.value);
  const showTarget = measure === "vwc" && !disabled && !completed;
  const lo = Math.min(...values, ...(showTarget ? [pairing.wtc_percent_limit] : []));
  const hi = Math.max(...values, ...(showTarget ? [pairing.wtc_percent_limit] : []));
  const yDomain: [number, number] = Number.isFinite(lo) && Number.isFinite(hi)
    ? [Math.floor(lo - Math.max(1, (hi - lo) * 0.1)), Math.ceil(hi + Math.max(1, (hi - lo) * 0.1))]
    : [0, 50];
  const segments = decimateForDisplay(points, { startMs: window.startMs, endMs: window.endMs, buckets: 600, gapMs: trace?.gapMs ?? 30 * 60_000 });
  const levels = assignment
    ? (["treatment", "crop", "substrate", "block"] as const).filter((key) => assignment[key]).map((key) => `${key.charAt(0).toUpperCase()}${key.slice(1)}: ${levelLabel(assignment[key] as string)}`)
    : [];
  const potRoute = experiment
    ? { view: "experiment" as const, experiment: experiment.id, tab: "pots" as const, pot: pairing.name }
    : { view: "pot" as const, pot: pairing.name };

  return (
    <section className="px-page" aria-label={`Pot ${pairing.pot_number}`}>
      <PortalLink className="px-crumb" to={backTo.route}>← {backTo.label}</PortalLink>
      <div className="px-exp-head">
        <div className="px-exp-head-row">
          <h1 className="px-title">Pot {pairing.pot_number}</h1>
          <button type="button" className="px-button is-small" onClick={() => void copy(potRoute)}>{copied ?? "Copy link"}</button>
        </div>
        <p className="px-subtitle">
          <span className="px-mono">{pairing.name}</span>
          {experiment ? <PortalLink to={{ view: "experiment", experiment: experiment.id, tab: "overview", pot: null }}>{experiment.name}</PortalLink> : <span>Not in a current experiment</span>}
          {levels.map((level) => <span key={level}>{level}</span>)}
        </p>
      </div>

      <div className="px-pot-grid">
        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <div className={`px-card px-reading ${latestVwc && freshness.state !== "stale" && freshness.state !== "unknown" ? "" : "is-silent"}`}>
            {latestVwc ? (
              invalidVwc ? (
                <strong>Invalid VWC reading</strong>
              ) : freshness.state === "stale" ? (
                <strong>No current reading</strong>
              ) : (
                <strong>{latestVwc.value.toFixed(1)}<small>% VWC</small></strong>
              )
            ) : <strong>No reading in the loaded {Math.round(loadedWindowMs / hour)} h</strong>}
            <span className="px-muted">
              {latestVwc ? `Measured ${formatMeasurementTime(latestVwc.timestampMs)} · ${freshness.detail}` : "The controller has not reported this pot in the loaded window."}
            </span>
            {invalidVwc && latestVwc ? <span className="px-notice is-bad">Reported {latestVwc.value.toFixed(1)}% VWC, outside 0–100%. This reading cannot be used for automatic watering.</span> : null}
            {latestVwc && freshness.state === "stale" ? (
              <span className="px-muted">Last value {latestVwc.value.toFixed(1)}% VWC — kept for reference, not a current reading.</span>
            ) : null}
            <span>{targetText}</span>
          </div>

          <div className="px-card" style={{ padding: "12px 14px", display: "grid", gap: 10 }}>
            <div className="px-toolbar">
              <h2 className="px-section-label">Last {Math.round(loadedWindowMs / hour)} hours</h2>
              <span className="px-spacer" />
              {available.length > 1 ? (
                <div className="px-segmented" role="group" aria-label="Measure">
                  {available.map((item) => (
                    <button key={item} type="button" aria-pressed={item === measure} onClick={() => setPortalQuery({ measure: item === "vwc" ? null : item })}>{measures[item].label}</button>
                  ))}
                </div>
              ) : null}
            </div>
            <TimeSeriesChart
              lines={[{ id: pairing.name, label: `Pot ${pairing.pot_number}`, color: "#1a6b4a", width: 1.8, segments }]}
              targets={showTarget ? [{ value: pairing.wtc_percent_limit, label: `Target ${pairing.wtc_percent_limit}%`, color: "#0e1a14" }] : []}
              ticks={!sensing && measure === "vwc" ? opens.filter((at) => at >= window.startMs).map((timestampMs) => ({ timestampMs })) : []}
              domain={window}
              yDomain={yDomain}
              height={220}
              ariaLabel={`Pot ${pairing.pot_number} ${info.label}, last ${Math.round(loadedWindowMs / hour)} hours.`}
              description={potReadingSentence({
                potNumber: pairing.pot_number,
                value: latestVwc?.value ?? null,
                measuredAt: latestVwc?.timestampMs ?? null,
                freshnessState: freshness.state,
                freshnessDetail: freshness.detail,
                target: sensing ? null : targetText,
              })}
              readout={(t) => {
                if (!points.length) return null;
                let best = points[0];
                for (const point of points) if (Math.abs(point.timestampMs - t) < Math.abs(best.timestampMs - t)) best = point;
                if (Math.abs(best.timestampMs - t) > (trace?.gapMs ?? 30 * 60_000)) return { title: formatMeasurementTime(t) ?? "", rows: [{ label: "Reading", value: "none here" }] };
                return { title: formatMeasurementTime(best.timestampMs) ?? "", rows: [{ label: info.label, value: `${formatMeasureValue(best.value, measure)}${measure === "vwc" ? " VWC" : ""}` }] };
              }}
            />
            {!sensing && measure === "vwc" ? <p className="px-muted px-small">Ticks along the bottom are valve openings recorded by the controller, not measured water.</p> : null}
          </div>
          {children}
        </div>

        <aside className="px-card" style={{ padding: "4px 16px 10px" }} aria-label="Pot details">
          <dl className="px-facts">
            <div><dt>Experiment</dt><dd>{experiment ? experiment.name : "None current"}</dd></div>
            {match.experiments.length > 1 ? (
              <div><dt>Also in</dt><dd>{match.experiments.filter((item) => item.id !== experiment?.id).map((item: PortalExperiment) => item.name).join(", ")}</dd></div>
            ) : null}
            <div><dt>Target</dt><dd>{targetText}</dd></div>
            <div><dt>Sensor</dt><dd className="px-mono">{pairing.sensor_key || "—"}</dd></div>
            <div><dt>Valve</dt><dd className="px-mono">{pairing.valve_key || "—"}</dd></div>
            <div><dt>Calibration</dt><dd>{pairing.calibration_name || pairing.calibration_label || pairing.calibration || "Not recorded"}</dd></div>
            <div><dt>Reports</dt><dd>{formatCadence(pairing.measurement_interval_ms) ?? "Cadence not reported"}</dd></div>
            {!sensing ? (
              <>
                <div><dt>Valve openings, 24 h</dt><dd>{opens24} (controller records)</dd></div>
                <div><dt>Last opening</dt><dd>{lastOpen ? formatMeasurementTime(lastOpen) : "None loaded"}</dd></div>
              </>
            ) : null}
          </dl>
        </aside>
      </div>
    </section>
  );
}
