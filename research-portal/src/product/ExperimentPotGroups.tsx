import { describeVwcReading, formatVwcReading, latestPoint } from "../charts/chartSeries";
import { experimentIsCompleted } from "../experimentMeasurement";
import { levelLabel } from "../experimentFactors";
import type { PortalExperiment } from "../experimentRegistry";
import { formatMeasurementTime, measurementFreshness } from "../measurementFreshness";
import { colorForPairing } from "../portalPresentation";
import type { ChartSeries } from "../portalTypes";
import type { PairingRow } from "../types";
import { PortalLink } from "./PortalLink";

type Props = {
  groupedPairings: { id: string; label: string; pairings: PairingRow[] }[];
  hiddenPots: Set<string>;
  selectedExperiment: PortalExperiment;
  seriesByName: Map<string, ChartSeries>;
  clockNowMs: number;
  affectedPots: ReadonlySet<string>;
  selectedSeriesName: string | null;
  setGroupVisibility: (pairings: PairingRow[], visible: boolean) => void;
  togglePot: (name: string) => void;
};

/** Trace visibility and inspection only; watering remains owned by the parent. */
export function ExperimentPotGroups({ groupedPairings, hiddenPots, selectedExperiment,
  seriesByName, clockNowMs, affectedPots, selectedSeriesName, setGroupVisibility, togglePot }: Props) {
  return <>{groupedPairings.map(({ id, label, pairings: groupPairings }) => {
            const allVisible = groupPairings.every((pairing) => !hiddenPots.has(pairing.name));
            const treatments = new Set(groupPairings.map((pairing) =>
              selectedExperiment.assignments?.find((item) => item.pairing_name === pairing.name)?.treatment?.trim(),
            ).filter((treatment): treatment is string => Boolean(treatment)));
            const treatment = treatments.size === 1 ? levelLabel([...treatments][0]) : null;
            return (
              <section className="pot-group" key={id}>
                <div className="pot-group-head">
                  <div className="pot-group-title">
                    <h3>{label}</h3>
                    <span className="pot-group-treatment">{groupPairings.length} pots{treatment && treatment.toLowerCase() !== "observation" ? ` · ${treatment}` : ""}</span>
                  </div>
                  <button
                    type="button"
                    className={`group-toggle ${allVisible ? "is-on" : ""}`}
                    aria-pressed={allVisible}
                    aria-label={`${allVisible ? "Hide" : "Show"} all ${label} pots`}
                    title={allVisible ? "Hide all" : "Show all"}
                    onClick={() => setGroupVisibility(groupPairings, !allVisible)}
                  >
                    <span />
                  </button>
                </div>
                <div>
                  {groupPairings.map((pairing) => {
                    const visible = !hiddenPots.has(pairing.name);
                    const potTreatment = selectedExperiment.assignments?.find((item) => item.pairing_name === pairing.name)?.treatment?.trim();
                    const potSeries = seriesByName.get(pairing.name);
                    const latest = latestPoint(potSeries);
                    const latestValue = latest?.value ?? null;
                    const potFreshness = measurementFreshness({
                      measuredAt: latest?.timestampMs,
                      expectedIntervalMs: potSeries?.expectedIntervalMs,
                      completed: experimentIsCompleted(selectedExperiment, clockNowMs),
                      nowMs: clockNowMs,
                    });
                    return (
                      <div className="px-trace-row" key={pairing.name}>
                      <button
                        type="button"
                        className={`pot-toggle ${affectedPots.has(pairing.name) ? "is-target-selected" : ""} ${visible ? "is-on" : ""} ${selectedSeriesName === pairing.name ? "is-selected-pot" : ""}`}
                        onClick={() => togglePot(pairing.name)}
                        aria-pressed={visible}
                        aria-label={`Pot ${pairing.pot_number}${potTreatment ? `, ${levelLabel(potTreatment)}` : ""}, ${describeVwcReading(latestValue)}${latest ? `, ${potFreshness.detail}` : ", no readings available"}`}
                        title={`${potTreatment ? `${levelLabel(potTreatment)} · ` : ""}${latest ? `${formatMeasurementTime(latest.timestampMs)} · ${potFreshness.detail}` : "No readings available"}`}
                      >
                        <span className="color-dot" style={{ background: colorForPairing(pairing) }} />
                        <span className="pot-reading">
                          <b>{pairing.pot_number}</b>
                          <strong>{formatVwcReading(latestValue)}</strong>
                          {!treatment && potTreatment ? <span className="pot-treatment">{levelLabel(potTreatment)}</span> : null}
                        </span>
                      </button>
                      <PortalLink className="px-trace-detail" to={{view: "experiment", experiment: selectedExperiment.id, tab: "pots", pot: pairing.name}} aria-label={`Inspect Pot ${pairing.pot_number}`} title={`Open Pot ${pairing.pot_number} details`}>↗</PortalLink>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}</>;
}
