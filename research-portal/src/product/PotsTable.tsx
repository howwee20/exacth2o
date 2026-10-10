import { useMemo } from "react";
import { defaultGrouping, experimentFactors, levelLabel, potGroups } from "../experimentFactors";
import { experimentIsCompleted } from "../experimentMeasurement";
import { isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { formatMeasurementTime, measurementFreshness } from "../measurementFreshness";
import { pairingWateringDisabled } from "../targetPresentation";
import type { PairingRow, SensorReading } from "../types";
import { potTraces } from "../waterline";
import { PortalLink } from "./PortalLink";
import { GroupGlyph } from "./WaterlineOverview";
import { vwcQuality } from "../readingQuality";
import "./product.css";

/** Every pot of the experiment, in plan order, each linking to its own pot page. */
export function PotsTable({
  experiment,
  pairings,
  readings,
  nowMs,
  asOfMs,
}: {
  experiment: PortalExperiment;
  pairings: readonly PairingRow[];
  readings: readonly SensorReading[];
  nowMs: number;
  asOfMs: number | null;
}) {
  const grouping = useMemo(() => defaultGrouping(experimentFactors(experiment)), [experiment]);
  const groups = useMemo(() => potGroups(experiment, grouping), [experiment, grouping]);
  const traces = useMemo(() => potTraces(readings, pairings, "vwc"), [pairings, readings]);
  const byName = useMemo(() => new Map(pairings.map((pairing) => [pairing.name, pairing])), [pairings]);
  const sensing = isObservationOnlyExperiment(experiment);
  const completed = experimentIsCompleted(experiment, nowMs);
  return (
    <section className="px-card" style={{ padding: "12px 14px" }} aria-label="All pots">
      <div className="px-toolbar" style={{ marginBottom: 8 }}>
        <h2 className="px-section-label">All pots</h2>
        <span className="px-spacer" />
        <span className="px-muted px-small">Open a pot for its history, notes and hardware.</span>
      </div>
      <div className="px-table-wrap">
        <table className="px-table">
          <thead>
            <tr>
              <th scope="col">Pot</th>
              <th scope="col">Group</th>
              <th scope="col">Latest VWC</th>
              <th scope="col">Reporting</th>
              {!sensing ? <th scope="col">Target</th> : null}
              <th scope="col">Calibration</th>
            </tr>
          </thead>
          <tbody>
            {groups.flatMap((group) => group.pairingNames.map((name) => {
              const pairing = byName.get(name);
              const trace = traces.get(name);
              const last = trace?.points.length ? trace.points[trace.points.length - 1] : null;
              const freshness = measurementFreshness({ measuredAt: last?.timestampMs, expectedIntervalMs: pairing?.measurement_interval_ms, completed, nowMs: asOfMs ?? nowMs });
              const assignment = experiment.assignments?.find((item) => item.pairing_name === name);
              const plan = assignment?.target_vwc_percent ?? null;
              const target = !pairing
                ? "Not on the controller"
                : pairingWateringDisabled(pairing)
                  ? "Watering disabled"
                  : `${pairing.wtc_percent_limit}%${plan != null && Math.abs(plan - pairing.wtc_percent_limit) > 0.001 ? ` (plan ${plan}%)` : ""}`;
              return (
                <tr key={name}>
                  <td>
                    <PortalLink to={{ view: "experiment", experiment: experiment.id, tab: "pots", pot: name }}>
                      <b className="px-mono">{pairing?.pot_number ?? trace?.potNumber ?? name}</b>
                    </PortalLink>
                    <span className="px-muted px-small"> {name}</span>
                  </td>
                  <td><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><GroupGlyph group={group} />{group.label === "All pots" ? (assignment?.crop ? levelLabel(assignment.crop) : "—") : group.label}</span></td>
                  <td className="px-num">{last ? `${last.value.toFixed(1)}%` : "—"}{vwcQuality(last?.value) ? <span className="px-quality-note">Review calibration</span> : null}</td>
                  <td className={freshness.state === "current" || freshness.state === "historical" ? "" : "px-num"} style={freshness.state === "stale" || freshness.state === "unknown" ? { color: "var(--px-amber)" } : undefined}>
                    {freshness.state === "current" ? "Yes" : last ? `Last ${formatMeasurementTime(last.timestampMs)}` : "No readings loaded"}
                  </td>
                  {!sensing ? <td className="px-num">{target}</td> : null}
                  <td>{pairing?.calibration_name || "Not recorded"}</td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
