/** Display-only measurement and applied-controller target descriptions. */
import type { PotGroup } from "./experimentFactors";
import { experimentIsCompleted } from "./experimentMeasurement";
import { isObservationOnlyExperiment, type PortalExperiment } from "./experimentRegistry";
import { pairingWateringDisabled } from "./targetPresentation";
import type { PairingRow } from "./types";
import { measures, type Measure } from "./waterline";
import type { ChartTarget } from "./product/TimeSeriesChart";

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
  if (!active.length) return { line: null, text: `Watering off${group.plannedTargets.length ? ` · plan ${group.plannedTargets.map((target) => `${target}%`).join(" / ")}` : ""}`, planMismatch: false };
  const applied = Array.from(new Set(active.map((pairing) => Number(pairing.wtc_percent_limit.toFixed(2)))));
  const planMismatch = sensingPlan || (group.plannedTargets.length > 0 && applied.some((value) => !group.plannedTargets.some((plan) => Math.abs(plan - value) < 0.001)));
  const disabled = groupPairings.length - active.length;
  const disabledText = disabled ? ` · ${disabled} ${disabled === 1 ? "pot" : "pots"} with watering off` : "";
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
