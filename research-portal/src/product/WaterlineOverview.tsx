import { useMemo } from "react";
import { experimentFactors, groupingLabel, parseGrouping, potGroups, type FactorKey, type PotGroup } from "../experimentFactors";
import { experimentIsCompleted } from "../experimentMeasurement";
import { isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { formatCadence, formatMeasurementTime } from "../measurementFreshness";
import { setPortalQuery, usePortalQueryValue } from "../portalRoute";
import { decimateForDisplay } from "../seriesStatistics";
import { pairingWateringDisabled } from "../targetPresentation";
import type { PairingRow, SensorReading, ValveEvent } from "../types";
import {
  availableMeasures,
  bucketSizeMs,
  groupWaterline,
  measures,
  potTraces,
  waterlineDomain,
  waterlineSegments,
  type GroupWaterline,
  type Measure,
  type PotTrace,
} from "../waterline";
import { PortalLink } from "./PortalLink";
import { TimeSeriesChart, type ChartBand, type ChartLine, type ChartTarget } from "./TimeSeriesChart";
import "./product.css";

export function formatMeasureValue(value: number | null | undefined, measure: Measure) {
  if (value == null || !Number.isFinite(value)) return "—";
  const info = measures[measure];
  return `${value.toFixed(info.digits)}${info.shortUnit}`;
}

type AppliedTarget = { line: ChartTarget | null; text: string | null; planMismatch: boolean };

/** What the controller is applying to a group, with the plan beside it when they differ. */
export function appliedGroupTarget(group: PotGroup, pairings: readonly PairingRow[], experiment: PortalExperiment, nowMs: number): AppliedTarget {
  if (experimentIsCompleted(experiment, nowMs)) return { line: null, text: null, planMismatch: false };
  const sensingPlan = isObservationOnlyExperiment(experiment);
  const names = new Set(group.pairingNames);
  const groupPairings = pairings.filter((pairing) => names.has(pairing.name));
  const active = groupPairings.filter((pairing) => !pairingWateringDisabled(pairing));
  if (!groupPairings.length) return { line: null, text: sensingPlan ? "Sensing-only plan" : null, planMismatch: false };
  if (!active.length) return { line: null, text: "Watering disabled", planMismatch: false };
  const applied = Array.from(new Set(active.map((pairing) => Number(pairing.wtc_percent_limit.toFixed(2)))));
  const planMismatch = sensingPlan || (group.plannedTargets.length > 0 && applied.some((value) => !group.plannedTargets.some((plan) => Math.abs(plan - value) < 0.001)));
  const disabled = groupPairings.length - active.length;
  const disabledText = disabled ? ` · ${disabled} ${disabled === 1 ? "pot" : "pots"} unwatered` : "";
  if (applied.length !== 1) {
    return { line: null, text: `Mixed targets ${applied.map((value) => `${value}%`).join(" / ")}${disabledText}`, planMismatch };
  }
  const plan = sensingPlan ? " · plan sensing only" : planMismatch ? ` · plan ${group.plannedTargets.map((value) => `${value}%`).join(" / ")}` : "";
  return {
    line: { value: applied[0], label: `Target ${applied[0]}%${plan}`, color: group.pattern.color, dash: "1 0" },
    text: `${sensingPlan ? "Controller target" : "Target"} ${applied[0]}% VWC${plan}${disabledText}`,
    planMismatch,
  };
}

function lineFromWaterline(line: GroupWaterline): { median: ChartLine; band: ChartBand } {
  const segments = waterlineSegments(line.buckets);
  const mid = (bucket: { startMs: number; endMs: number }) => (bucket.startMs + bucket.endMs) / 2;
  return {
    median: {
      id: `${line.group.id}-median`,
      label: `${line.group.label} median`,
      color: line.group.pattern.color,
      dash: line.group.pattern.dash,
      width: 2,
      segments: segments.map((segment) => segment.map((bucket) => ({ timestampMs: mid(bucket), value: bucket.median as number }))),
    },
    band: {
      id: `${line.group.id}-band`,
      color: line.group.pattern.color,
      opacity: 0.15,
      segments: segments.map((segment) => segment.map((bucket) => ({ timestampMs: mid(bucket), low: bucket.low as number, high: bucket.high as number }))),
    },
  };
}

function potLines(group: PotGroup, traces: ReadonlyMap<string, PotTrace>, window: { startMs: number; endMs: number }, width = 700): ChartLine[] {
  return group.pairingNames.map((name) => {
    const trace = traces.get(name);
    const inWindow = (trace?.points ?? []).filter((point) => point.timestampMs >= window.startMs && point.timestampMs <= window.endMs);
    return {
      id: `${group.id}-${name}`,
      label: name,
      color: group.pattern.color,
      width: 0.8,
      opacity: 0.35,
      segments: decimateForDisplay(inWindow, { startMs: window.startMs, endMs: window.endMs, buckets: width, gapMs: trace?.gapMs ?? 30 * 60_000 }),
    };
  });
}

export function GroupGlyph({ group }: { group: PotGroup }) {
  const { color, dash, marker } = group.pattern;
  return (
    <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
      <line x1="1" x2="21" y1="7" y2="7" stroke={color} strokeWidth="2" strokeDasharray={dash ?? undefined} />
      {marker === "circle" ? <circle cx="28" cy="7" r="4.5" fill={color} /> : null}
      {marker === "square" ? <rect x="23.5" y="2.5" width="9" height="9" fill={color} /> : null}
      {marker === "triangle" ? <path d="M28 2 L33 12 L23 12 Z" fill={color} /> : null}
      {marker === "diamond" ? <path d="M28 1.5 L33.5 7 L28 12.5 L22.5 7 Z" fill={color} /> : null}
      {marker === "ring" ? <circle cx="28" cy="7" r="4" fill="none" stroke={color} strokeWidth="2" /> : null}
      {marker === "bar" ? <rect x="26" y="1" width="4" height="12" fill={color} /> : null}
    </svg>
  );
}

const windowChoices = [
  { id: "24h", label: "24 h", ms: 24 * 3_600_000 },
  { id: "72h", label: "72 h", ms: 72 * 3_600_000 },
];

/**
 * Experiment overview in Waterline form: per group, a target hairline, the treatment median and
 * the lowest–highest pot range, with coverage and every pot one tap away.
 */
export function WaterlineOverview({
  experiment,
  pairings,
  readings,
  valveEvents,
  nowMs,
  asOfMs,
  loadedWindowMs,
  dataSourceLabel,
}: {
  experiment: PortalExperiment;
  /** The experiment's pairings (controller configuration). */
  pairings: readonly PairingRow[];
  /** The experiment's readings (already limited to its pots and run dates). */
  readings: readonly SensorReading[];
  valveEvents: readonly ValveEvent[];
  nowMs: number;
  /** Time of the last successful check; coverage is judged as of then. */
  asOfMs: number | null;
  loadedWindowMs: number;
  dataSourceLabel: string;
}) {
  const factors = useMemo(() => experimentFactors(experiment), [experiment]);
  const groupParam = usePortalQueryValue("group");
  const measureParam = usePortalQueryValue("measure") as Measure | null;
  const spanParam = usePortalQueryValue("span");
  const showPots = usePortalQueryValue("pots") === "1";
  const grouping: FactorKey[] = useMemo(() => parseGrouping(groupParam, factors), [factors, groupParam]);
  const groups = useMemo(() => potGroups(experiment, grouping), [experiment, grouping]);
  const available = useMemo(() => availableMeasures(readings), [readings]);
  const measure: Measure = measureParam && available.includes(measureParam) ? measureParam : available[0] ?? "vwc";
  const info = measures[measure];
  const span = windowChoices.find((choice) => choice.id === spanParam) ?? windowChoices[1];
  const completed = experimentIsCompleted(experiment, nowMs);
  const endedMs = experiment.endedAt ? Date.parse(experiment.endedAt) : Number.NaN;
  const endMs = completed && Number.isFinite(endedMs) ? Math.min(endedMs, nowMs) : nowMs;
  const window = useMemo(() => ({ startMs: Math.max(endMs - span.ms, nowMs - loadedWindowMs), endMs }), [endMs, loadedWindowMs, nowMs, span.ms]);
  const traces = useMemo(() => potTraces(readings, pairings, measure), [measure, pairings, readings]);
  const bucketMs = bucketSizeMs(window.endMs - window.startMs);
  const asOf = asOfMs ?? nowMs;
  const lines = useMemo(
    () => groups.map((group) => groupWaterline(group, traces, window, { bucketMs, asOfMs: asOf })),
    [asOf, bucketMs, groups, traces, window],
  );
  const targets = useMemo(
    () => new Map(groups.map((group) => [group.id, info.hasTargets ? appliedGroupTarget(group, pairings, experiment, nowMs) : { line: null, text: null, planMismatch: false }])),
    [experiment, groups, info.hasTargets, nowMs, pairings],
  );
  const yDomain = useMemo(
    () => waterlineDomain(lines, Array.from(targets.values()).map((target) => target.line?.value).filter((value): value is number => value != null), measure === "vwc" ? 4 : 1),
    [lines, measure, targets],
  );
  const opensByPot = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const event of valveEvents) {
      if (event.action !== "open") continue;
      const at = Date.parse(event.device_recorded_at ?? event.server_received_at);
      if (!Number.isFinite(at) || at < window.startMs || at > window.endMs) continue;
      map.set(event.pairing_name, [...(map.get(event.pairing_name) ?? []), at]);
    }
    return map;
  }, [valveEvents, window]);
  const calibrations = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const pairing of pairings) {
      const name = pairing.calibration_name || pairing.calibration_label || pairing.calibration || "Not recorded";
      names.set(name, [...(names.get(name) ?? []), pairing.name]);
    }
    return names;
  }, [pairings]);
  const totalPots = experiment.pairingNames.length;
  const reportingTotal = lines.reduce((sum, line) => sum + line.reporting, 0);
  const invalidTotal = lines.reduce((sum, line) => sum + line.silent.filter((pot) => pot.invalid).length, 0);
  const cadences = Array.from(new Set(pairings.map((pairing) => formatCadence(pairing.measurement_interval_ms)).filter(Boolean)));
  const readout = (line: GroupWaterline) => (t: number) => {
    const bucket = line.buckets.find((item) => t >= item.startMs && t < item.endMs);
    if (!bucket) return null;
    return {
      title: formatMeasurementTime(t) ?? "",
      rows: bucket.median == null
        ? [{ label: "Pots reporting", value: `${bucket.potCount} of ${line.potTotal}` }, { label: "Group line", value: bucket.potCount ? "too few pots" : "no readings" }]
        : [
          { label: "Median", value: formatMeasureValue(bucket.median, measure) },
          { label: "Range", value: `${formatMeasureValue(bucket.low, measure)} – ${formatMeasureValue(bucket.high, measure)}` },
          { label: "Pots in bucket", value: `${bucket.potCount} of ${line.potTotal}` },
        ],
    };
  };

  return (
    <section className="px-waterline" aria-label="Overview">
      <div className="px-toolbar">
        {factors.length ? (
          <label className="px-select">
            Group by
            <select value={grouping.length ? grouping.join(",") : "none"} onChange={(event) => setPortalQuery({ group: event.target.value })}>
              {factors.length > 1 && factors.some((f) => f.key === "treatment") && factors.some((f) => f.key === "crop") ? <option value="treatment,crop">Treatment × crop</option> : null}
              {factors.map((factor) => <option key={factor.key} value={factor.key}>{factor.label}</option>)}
              <option value="none">All pots together</option>
            </select>
          </label>
        ) : null}
        {available.length > 1 ? (
          <div className="px-segmented" role="group" aria-label="Measure">
            {available.map((item) => (
              <button key={item} type="button" aria-pressed={item === measure} onClick={() => setPortalQuery({ measure: item === "vwc" ? null : item })}>
                {measures[item].label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="px-segmented" role="group" aria-label="Time window">
          {windowChoices.map((choice) => (
            <button key={choice.id} type="button" aria-pressed={choice.id === span.id} onClick={() => setPortalQuery({ span: choice.id === "72h" ? null : choice.id })}>
              {choice.label}
            </button>
          ))}
        </div>
        <label className="px-select">
          <input type="checkbox" checked={showPots} onChange={(event) => setPortalQuery({ pots: event.target.checked ? "1" : null })} />
          Show individual pots
        </label>
        <span className="px-spacer" />
        <span className="px-muted px-small">{reportingTotal} of {totalPots} {measure === "vwc" ? "pots with valid VWC" : "pots reporting"}{invalidTotal ? ` · ${invalidTotal} invalid` : ""}{asOfMs ? ` · checked ${formatMeasurementTime(asOfMs)}` : ""}</span>
      </div>

      {lines.map((line) => {
        const target = targets.get(line.group.id);
        const { median, band } = lineFromWaterline(line);
        const pots = showPots ? potLines(line.group, traces, window) : [];
        const ticks = measure !== "vwc"
          ? []
          : line.group.pairingNames.flatMap((name) => (opensByPot.get(name) ?? []).map((timestampMs) => ({ timestampMs })));
        const coverageWarn = line.reporting < line.potTotal;
        const silentSince = line.silent.filter((pot) => pot.lastAt != null);
        return (
          <article key={line.group.id} className="px-wl-group" aria-label={line.group.label}>
            <header className="px-wl-head">
              <h2 className="px-wl-name"><GroupGlyph group={line.group} />{line.group.label}</h2>
              <span className="px-wl-caps">{line.potTotal} {line.potTotal === 1 ? "pot" : "pots"}</span>
              <span className={`px-wl-caps ${coverageWarn ? "is-warn" : ""}`}>{line.reporting} reporting</span>
              {target?.text ? <span className={`px-wl-caps ${target.planMismatch ? "is-warn" : ""}`}>{target.text}</span> : null}
              <span className="px-wl-now">
                {line.latest ? (
                  <>
                    <strong>{formatMeasureValue(line.latest.median, measure)}</strong>
                    <span>median now{line.latest.pots > 1 ? ` · range ${formatMeasureValue(line.latest.low, measure)}–${formatMeasureValue(line.latest.high, measure)}` : ""}</span>
                  </>
                ) : (
                  <span>{line.lastObservationMs ? `No current reading · last ${formatMeasurementTime(line.lastObservationMs)}` : "No readings in this window"}</span>
                )}
              </span>
            </header>
            <TimeSeriesChart
              lines={[...pots, median]}
              bands={[band]}
              targets={target?.line ? [target.line] : []}
              ticks={ticks}
              domain={window}
              yDomain={yDomain}
              height={190}
              stepMs={line.bucketMs}
              ariaLabel={`${line.group.label}: ${info.label} over the last ${span.label}.`}
              description={line.latest
                ? `Median now ${formatMeasureValue(line.latest.median, measure)} across ${line.latest.pots} reporting pots, range ${formatMeasureValue(line.latest.low, measure)} to ${formatMeasureValue(line.latest.high, measure)}. ${line.reporting} of ${line.potTotal} pots reporting.${target?.text ? ` ${target.text}.` : ""}`
                : `No current reading for this group. ${line.reporting} of ${line.potTotal} pots reporting.`}
              readout={readout(line)}
            />
            <div className="px-pots" aria-label={`Pots in ${line.group.label}`}>
              {line.group.pairingNames.map((name) => {
                const trace = traces.get(name);
                const silent = line.silent.find((pot) => pot.name === name);
                const last = trace?.points.length ? trace.points[trace.points.length - 1] : null;
                const readingLabel = silent?.invalid
                  ? `invalid VWC reading ${formatMeasureValue(last?.value, measure)}`
                  : silent ? (silent.lastAt ? `no current reading, last at ${formatMeasurementTime(silent.lastAt)}` : "no readings in this window") : formatMeasureValue(last?.value, measure);
                return (
                  <PortalLink
                    key={name}
                    className={`px-pot-chip ${silent ? "is-silent" : ""}`}
                    to={{ view: "experiment", experiment: experiment.id, tab: "pots", pot: name }}
                    aria-label={`Pot ${trace?.potNumber ?? name}: ${readingLabel}`}
                  >
                    <b>{trace?.potNumber ?? name}</b>
                    <span>{silent?.invalid ? "invalid VWC" : silent ? (silent.lastAt ? "silent" : "no data") : formatMeasureValue(last?.value, measure)}</span>
                  </PortalLink>
                );
              })}
            </div>
            {silentSince.length && silentSince.length === line.silent.length && line.silent.length === line.potTotal ? (
              <p className="px-notice" role="status">No pot in this group has a current reading; the line ends at the last observation.</p>
            ) : null}
          </article>
        );
      })}

      <div className="px-legend" aria-label="How to read the overview">
        <span className="px-legend-item"><span className="px-swatch-line" style={{ color: "#1d2a24" }} /> median of pots</span>
        <span className="px-legend-item"><span className="px-swatch-band" style={{ background: "rgba(29,42,36,0.16)" }} /> lowest–highest pot (a range, not a confidence interval)</span>
        {info.hasTargets && Array.from(targets.values()).some((target) => target.line) ? <span className="px-legend-item"><span className="px-swatch-line" style={{ color: "#1d2a24", borderTopWidth: 1 }} /> controller target</span> : null}
        {measure === "vwc" ? <span className="px-legend-item"><span className="px-swatch-line" style={{ color: "#1f5f8b", width: 2, height: 8, borderTop: 0, borderLeft: "2px solid #1f5f8b" }} /> valve opening (controller record, not measured water)</span> : null}
        <span className="px-legend-item">Line breaks where fewer than half of a group's pots reported.</span>
      </div>

      <details className="px-definition">
        <summary>How these numbers are made</summary>
        <dl>
          <dt>Measure</dt><dd>{info.label} — {info.definition} Unit: {info.unit}.</dd>
          <dt>Grouping</dt><dd>{groupingLabel(grouping)}, from the experiment plan{experiment.currentVersion ? ` (revision ${experiment.currentVersion})` : ""}. {factors.length ? `Factors in this plan: ${factors.map((factor) => `${factor.label} (${factor.levels.map((level) => level.label).join(", ")})`).join("; ")}.` : "The plan has no varying factor, so all pots form one group."}</dd>
          <dt>Pot value</dt><dd>Each pot contributes one value per {Math.round(bucketMs / 60_000)}-minute bucket: the mean of its own readings in that bucket. The pot is the experimental unit; a pot that reports more often does not count more.</dd>
          <dt>Group line</dt><dd>Median of the pot values in each bucket. The shaded band is the lowest to highest pot value — a range, not a confidence interval. Where fewer than half of the group's pots reported, the line breaks instead of being drawn from too few pots.</dd>
          <dt>Reporting</dt><dd>A pot is reporting when its newest reading is within two of its own reporting intervals (at least 5 minutes) plus 2 minutes for upload{asOfMs ? `, judged as of the last successful check (${formatMeasurementTime(asOfMs)})` : ""}. VWC outside 0–100% is marked invalid and excluded from group summaries; its sensor output remains available on the pot page.</dd>
          <dt>Targets</dt><dd>{info.hasTargets ? "The hairline is the target the controller is applying (what watering follows). When the experiment plan differs, the label says so." : "Targets apply to calibrated VWC only, so none are drawn for this measure."}</dd>
          <dt>Calibration</dt><dd>{Array.from(calibrations.entries()).map(([name, pots]) => `${name} (${pots.length} ${pots.length === 1 ? "pot" : "pots"})`).join("; ")}.</dd>
          <dt>Cadence</dt><dd>{cadences.length ? cadences.join(", ") : "Not reported by the controller; gaps use the observed spacing."}</dd>
          <dt>Window</dt><dd>{formatMeasurementTime(window.startMs)} – {formatMeasurementTime(window.endMs)} ({dataSourceLabel}). Longer histories and exports are in Workbench.</dd>
        </dl>
      </details>
    </section>
  );
}
