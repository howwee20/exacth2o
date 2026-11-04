import { useEffect, useMemo } from "react";
import { experimentIsCompleted } from "../experimentMeasurement";
import { isObservationOnlyExperiment } from "../experimentRegistry";
import { formatMeasurementTime, measurementFreshness } from "../measurementFreshness";
import { setPortalQuery, usePortalQueryValue } from "../portalRoute";
import type { PotMatch } from "../potIdentity";
import { decimateForDisplay } from "../seriesStatistics";
import { pairingWateringDisabled } from "../targetPresentation";
import type { SensorReading } from "../types";
import { availableMeasures, measures, potTraces, type Measure } from "../waterline";
import { PortalLink } from "./PortalLink";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { formatMeasureValue } from "./WaterlineOverview";
import { vwcQuality } from "../readingQuality";
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
  const reading = `${input.value.toFixed(1)}% VWC at ${formatMeasurementTime(input.measuredAt)}`;
  const state = input.freshnessState === "current" ? "current" : input.freshnessDetail.replace(/\.$/, "").toLowerCase();
  return `Pot ${input.potNumber}: ${reading} (${state}).${input.target ? ` ${input.target}.` : ""}`;
}

export function PotPage({
  match,
  readings,
  nowMs,
  asOfMs,
  loadedWindowMs,
  backTo,
}: {
  match: PotMatch;
  /** Readings for this pot (any experiment). */
  readings: readonly SensorReading[];
  nowMs: number;
  asOfMs: number | null;
  loadedWindowMs: number;
  backTo: { label: string; route: Parameters<typeof PortalLink>[0]["to"] };
}) {
  const { pairing, current: experiment, assignment } = match;
  const measureParam = usePortalQueryValue("measure") as Measure | null;
  const available = useMemo(() => availableMeasures(readings), [readings]);
  const measure: Measure = measureParam && available.includes(measureParam) ? measureParam : available[0] ?? "vwc";
  const trace = useMemo(() => potTraces(readings, [pairing], measure).get(pairing.name), [measure, pairing, readings]);
  const vwcTrace = useMemo(() => potTraces(readings, [pairing], "vwc").get(pairing.name), [pairing, readings]);
  const window = { startMs: nowMs - loadedWindowMs, endMs: nowMs };
  const latestVwc = vwcTrace?.points.length ? vwcTrace.points[vwcTrace.points.length - 1] : null;
  const latestReading = readings.slice().sort((a, b) => Date.parse(b.device_recorded_at) - Date.parse(a.device_recorded_at))[0] ?? null;
  const quality = vwcQuality(latestReading?.calibrated_value);
  const completed = experiment ? experimentIsCompleted(experiment, nowMs) : false;
  const freshness = measurementFreshness({
    measuredAt: latestVwc?.timestampMs,
    expectedIntervalMs: pairing.measurement_interval_ms,
    completed,
    nowMs: asOfMs ?? nowMs,
  });
  const sensing = experiment ? isObservationOnlyExperiment(experiment) : true;
  const disabled = pairingWateringDisabled(pairing);
  const plan = assignment?.target_vwc_percent ?? null;
  const targetText = experiment && sensing
    ? "Sensing only"
    : disabled
      ? `Watering off${plan != null ? ` · plan target ${plan}% VWC` : ""}`
      : `${experiment ? "Target" : "Controller target"} ${pairing.wtc_percent_limit}% VWC${plan != null && Math.abs(plan - pairing.wtc_percent_limit) > 0.001 ? ` · plan ${plan}%` : ""}`;
  const info = measures[measure];
  const points = (trace?.points ?? []).filter((point) => point.timestampMs >= window.startMs);
  const values = points.map((point) => point.value);
  const showTarget = measure === "vwc" && !sensing && !disabled && !completed;
  const lo = Math.min(...values, ...(showTarget ? [pairing.wtc_percent_limit] : []));
  const hi = Math.max(...values, ...(showTarget ? [pairing.wtc_percent_limit] : []));
  const yDomain: [number, number] = Number.isFinite(lo) && Number.isFinite(hi)
    ? [Math.floor(lo - Math.max(1, (hi - lo) * 0.1)), Math.ceil(hi + Math.max(1, (hi - lo) * 0.1))]
    : [0, 50];
  const segments = decimateForDisplay(points, { startMs: window.startMs, endMs: window.endMs, buckets: 600, gapMs: trace?.gapMs ?? 30 * 60_000 });
  useEffect(() => { const previous = document.title; document.title = `Pot ${pairing.pot_number}${experiment ? ` · ${experiment.name}` : ""} · ExactH2O`; return () => { document.title = previous; }; }, [pairing.pot_number, experiment]);

  return (
    <section className="px-page is-wide px-pot-page" aria-label={`Pot ${pairing.pot_number}`}>
      <PortalLink className="px-crumb" to={backTo.route}>← {backTo.label}</PortalLink>
      <h1 className="px-title">Pot {pairing.pot_number}</h1>
      <div className="px-pot-grid is-reading-only">
        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <div className={`px-card px-reading ${latestVwc && freshness.state !== "stale" && freshness.state !== "unknown" ? "" : "is-silent"}`}>
            {latestVwc ? (
              freshness.state === "stale" ? (
                <strong>No current reading</strong>
              ) : (
                <strong>{latestVwc.value.toFixed(1)}<small>% VWC</small></strong>
              )
            ) : <strong>No reading in the loaded {Math.round(loadedWindowMs / hour)} h</strong>}
            <span className="px-muted">
              {latestVwc ? `Measured ${formatMeasurementTime(latestVwc.timestampMs)} · ${freshness.detail}` : "The controller has not reported this pot in the loaded window."}
            </span>
            {latestVwc && freshness.state === "stale" ? (
              <span className="px-muted">Last value {latestVwc.value.toFixed(1)}% VWC — kept for reference, not a current reading.</span>
            ) : null}
            <span>{targetText}</span>
            {quality ? <span className="px-quality-link">{quality}</span> : null}
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
              domain={window}
              yDomain={yDomain}
              height={300}
              responsive
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
          </div>
        </div>


      </div>
    </section>
  );
}
