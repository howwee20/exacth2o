import { useMemo } from "react";
import { defaultGrouping, experimentFactors, groupingLabel, potGroups } from "../experimentFactors";
import { experimentIsCompleted } from "../experimentMeasurement";
import { readingsForExperiment, type PortalExperiment } from "../experimentRegistry";
import { formatMeasurementTime } from "../measurementFreshness";
import type { PairingRow, SensorReading } from "../types";
import { bucketSizeMs, groupWaterline, potTraces, waterlineDomain, waterlineSegments } from "../waterline";
import { PortalLink } from "./PortalLink";
import { TimeSeriesChart, type ChartBand, type ChartLine } from "./TimeSeriesChart";
import { GroupGlyph, formatMeasureValue } from "./WaterlineOverview";
import "./product.css";

/** Installation trends: every running experiment's groups in Waterline form, on one time axis. */
export function TrendsView({
  experiments,
  pairings,
  readings,
  nowMs,
  asOfMs,
  loadedWindowMs,
}: {
  experiments: readonly PortalExperiment[];
  pairings: readonly PairingRow[];
  readings: readonly SensorReading[];
  nowMs: number;
  asOfMs: number | null;
  loadedWindowMs: number;
}) {
  const window = useMemo(() => ({ startMs: nowMs - loadedWindowMs, endMs: nowMs }), [loadedWindowMs, nowMs]);
  const running = experiments.filter((experiment) => !experimentIsCompleted(experiment, nowMs));
  const blocks = useMemo(() => running.map((experiment) => {
    const names = new Set(experiment.pairingNames);
    const experimentPairings = pairings.filter((pairing) => names.has(pairing.name));
    const traces = potTraces(readingsForExperiment([...readings], experiment), experimentPairings, "vwc");
    const grouping = defaultGrouping(experimentFactors(experiment));
    const groups = potGroups(experiment, grouping);
    const bucketMs = bucketSizeMs(window.endMs - window.startMs, 96);
    const lines = groups.map((group) => groupWaterline(group, traces, window, { bucketMs, asOfMs: asOfMs ?? nowMs }));
    return { experiment, grouping, lines };
  }), [asOfMs, nowMs, pairings, readings, running, window]);

  return (
    <section className="px-page is-wide" aria-label="Trends">
      <PortalLink className="px-crumb" to={{ view: "home" }}>← Experiments</PortalLink>
      <h1 className="px-title">Trends</h1>
      <p className="px-lede">Calibrated VWC for every running experiment over the last {Math.round(loadedWindowMs / 3_600_000)} hours. Lines are group medians of pots; bands are the lowest to highest pot. Open an experiment for its targets, pots and record.</p>
      {blocks.length ? blocks.map(({ experiment, grouping, lines }) => {
        const domain = waterlineDomain(lines);
        const chartLines: ChartLine[] = lines.map((line) => ({
          id: line.group.id,
          label: line.group.label,
          color: line.group.pattern.color,
          dash: line.group.pattern.dash,
          width: 1.8,
          segments: waterlineSegments(line.buckets).map((segment) => segment.map((bucket) => ({ timestampMs: (bucket.startMs + bucket.endMs) / 2, value: bucket.median as number }))),
        }));
        const bands: ChartBand[] = lines.map((line) => ({
          id: `${line.group.id}-band`,
          color: line.group.pattern.color,
          opacity: 0.1,
          segments: waterlineSegments(line.buckets).map((segment) => segment.map((bucket) => ({ timestampMs: (bucket.startMs + bucket.endMs) / 2, low: bucket.low as number, high: bucket.high as number }))),
        }));
        const reporting = lines.reduce((sum, line) => sum + line.reporting, 0);
        return (
          <article key={experiment.id} className="px-card" style={{ padding: "14px 16px", display: "grid", gap: 8 }}>
            <div className="px-toolbar">
              <PortalLink className="px-wl-name" to={{ view: "experiment", experiment: experiment.id, tab: "overview", pot: null }}>{experiment.name}</PortalLink>
              <span className="px-wl-caps">{groupingLabel(grouping)}</span>
              <span className="px-spacer" />
              <span className="px-muted px-small">{reporting} of {experiment.pairingNames.length} pots reporting</span>
            </div>
            <div className="px-legend">
              {lines.map((line) => (
                <span key={line.group.id} className="px-legend-item">
                  <GroupGlyph group={line.group} /> {line.group.label}
                  {line.latest ? <span className="px-mono"> {formatMeasureValue(line.latest.median, "vwc")}</span> : <span> no current reading</span>}
                </span>
              ))}
            </div>
            <TimeSeriesChart
              lines={chartLines}
              bands={bands}
              domain={window}
              yDomain={domain}
              height={170}
              ariaLabel={`${experiment.name}: group medians of calibrated VWC, last ${Math.round(loadedWindowMs / 3_600_000)} hours.`}
              readout={(t) => ({
                title: formatMeasurementTime(t) ?? "",
                rows: lines.map((line) => {
                  const bucket = line.buckets.find((item) => t >= item.startMs && t < item.endMs);
                  return { label: line.group.label, value: bucket?.median != null ? formatMeasureValue(bucket.median, "vwc") : "—" };
                }),
              })}
            />
          </article>
        );
      }) : <p className="px-empty">No running experiments.</p>}
    </section>
  );
}
