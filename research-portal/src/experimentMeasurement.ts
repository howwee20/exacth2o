import { type ExperimentGraphGroup, type Treatment } from "./experimentPresentation";
import { isObservationOnlyExperiment, type PortalExperiment } from "./experimentRegistry";
import { type Freshness, measurementFreshness, validCadenceMs } from "./measurementFreshness";
import { formatVwc, pairingWateringDisabled, presentTarget, type TargetPresentation } from "./targetPresentation";
import { type ChartTargetLine } from "./portalTypes";
import { type PairingRow, type SensorReading } from "./types";

export function experimentIsCompleted(experiment: Pick<PortalExperiment, "status" | "endedAt">, nowMs = Date.now()) {
  if (experiment.status === "completed" || experiment.status === "archived") return true;
  const ended = experiment.endedAt ? Date.parse(experiment.endedAt) : Number.NaN;
  return Number.isFinite(ended) && ended <= nowMs;
}

/** Shortest configured cadence among the pots; the experiment is current only if its fastest reporters are. */
export function experimentCadenceMs(pairings: readonly Pick<PairingRow, "measurement_interval_ms">[]) {
  let cadence: number | null = null;
  for (const pairing of pairings) {
    const value = validCadenceMs(pairing.measurement_interval_ms);
    if (value != null && (cadence == null || value < cadence)) cadence = value;
  }
  return cadence;
}

export function experimentFreshness(input: {
  experiment: Pick<PortalExperiment, "status" | "endedAt">;
  pairings: readonly Pick<PairingRow, "measurement_interval_ms">[];
  latestMeasuredAt: string | number | null | undefined;
  controllerOffline?: boolean;
  nowMs?: number;
}): Freshness {
  return measurementFreshness({
    measuredAt: input.latestMeasuredAt,
    expectedIntervalMs: experimentCadenceMs(input.pairings),
    completed: experimentIsCompleted(input.experiment, input.nowMs),
    controllerOffline: input.controllerOffline,
    nowMs: input.nowMs,
  });
}

/** Newest measurement time (ms) per pot, keyed by pairing name. */
export function latestMeasurementByPot(readings: readonly Pick<SensorReading, "pairing_name" | "device_recorded_at">[]) {
  const latest = new Map<string, number>();
  for (const reading of readings) {
    const at = Date.parse(reading.device_recorded_at);
    if (!Number.isFinite(at)) continue;
    if (at > (latest.get(reading.pairing_name) ?? -Infinity)) latest.set(reading.pairing_name, at);
  }
  return latest;
}

/** How many pots have a current reading, each judged against its own configured cadence. */
export function reportingCoverage(
  pairings: readonly Pick<PairingRow, "name" | "measurement_interval_ms">[],
  latestByPot: ReadonlyMap<string, number>,
  nowMs = Date.now(),
) {
  let reporting = 0;
  for (const pairing of pairings) {
    const freshness = measurementFreshness({
      measuredAt: latestByPot.get(pairing.name),
      expectedIntervalMs: pairing.measurement_interval_ms,
      nowMs,
    });
    if (freshness.state === "current") reporting += 1;
  }
  return { reporting, total: pairings.length };
}

/**
 * An experiment's freshness comes from its newest reading; one live pot must not make the rest
 * look current. When only some pots are reporting, the state is "partial" and says how many.
 */
export function withReportingCoverage(freshness: Freshness, coverage: { reporting: number; total: number }): Freshness {
  if (freshness.state !== "current" || coverage.total === 0 || coverage.reporting >= coverage.total) return freshness;
  return {
    ...freshness,
    state: "partial",
    tone: "warning",
    label: `${coverage.reporting} of ${coverage.total} reporting`,
    detail: `${coverage.reporting} of ${coverage.total} pots have a current reading. ${freshness.detail}`,
  };
}

function distinctTargets(pairings: readonly PairingRow[]) {
  return Array.from(new Set(
    pairings
      .filter((pairing) => !pairingWateringDisabled(pairing))
      .map((pairing) => pairing.wtc_percent_limit),
  )).sort((a, b) => a - b);
}

export type GroupTarget = TargetPresentation & {
  /** The experiment plan and the controller disagree for at least one pot. */
  planMismatch: boolean;
};

/**
 * What a graph group's target means, from the experiment plan and the
 * controller's applied pairings. Stored values are only read, never changed.
 */
export function groupTarget(
  group: Pick<ExperimentGraphGroup, "target" | "pairingNames">,
  experiment: Pick<PortalExperiment, "status" | "wateringState" | "mode" | "endedAt">,
  pairings: readonly PairingRow[],
): GroupTarget {
  const names = new Set(group.pairingNames);
  const groupPairings = pairings.filter((pairing) => names.has(pairing.name));
  const applied = distinctTargets(groupPairings);
  const allDisabled = groupPairings.length > 0 && groupPairings.every(pairingWateringDisabled);
  // The controller's applied target is what watering actually follows; the plan is shown beside it
  // when they differ, never instead of it.
  const target = applied.length === 1 ? applied[0] : group.target ?? null;
  const presentation = presentTarget({
    target,
    distinctTargets: applied.length > 1 ? applied : undefined,
    experimentStatus: experimentIsCompleted(experiment) ? "completed" : experiment.status,
    sensingOnly: isObservationOnlyExperiment(experiment as PortalExperiment),
    wateringDisabled: allDisabled,
  });
  const planMismatch = group.target != null &&
    applied.some((value) => Math.abs(value - (group.target as number)) > 0.001);
  let label = presentation.label;
  let detail = presentation.detail;
  if (planMismatch && presentation.kind !== "sensing_only" && presentation.kind !== "completed") {
    const plan = formatVwc(group.target);
    label = `${label} · plan ${plan?.replace(" VWC", "")}`;
    detail = `${detail} The experiment plan says ${plan}, but the controller is applying ${applied.map((value) => formatVwc(value)).join(", ")}.`;
  }
  const unwatered = groupPairings.filter(pairingWateringDisabled).length;
  if (unwatered > 0 && !allDisabled && presentation.kind !== "sensing_only" && presentation.kind !== "completed") {
    label = `${label} · ${unwatered} ${unwatered === 1 ? "pot" : "pots"} unwatered`;
    detail = `${detail} Automatic watering is disabled for ${unwatered} of ${groupPairings.length} pots in this group.`;
  }
  return { ...presentation, label, detail, planMismatch };
}

const treatmentTone: Record<Treatment, ChartTargetLine["tone"]> = {
  control: "control",
  drought: "drought",
  unknown: "neutral",
};

/**
 * Reference lines for the pots on a chart: one per treatment whose pots share
 * one applied target. Mixed or disabled targets draw no line rather than a
 * misleading one.
 */
export function targetLinesForPairings(
  pairings: readonly PairingRow[],
  treatmentOf: (pairing: PairingRow) => Treatment,
  experiment: Pick<PortalExperiment, "status" | "wateringState" | "mode" | "endedAt">,
): ChartTargetLine[] {
  if (isObservationOnlyExperiment(experiment as PortalExperiment) || experimentIsCompleted(experiment)) return [];
  const byTreatment = new Map<Treatment, PairingRow[]>();
  for (const pairing of pairings) {
    const treatment = treatmentOf(pairing);
    byTreatment.set(treatment, [...(byTreatment.get(treatment) ?? []), pairing]);
  }
  const named = byTreatment.size > 1;
  const lines: ChartTargetLine[] = [];
  for (const [treatment, group] of byTreatment) {
    const targets = distinctTargets(group);
    if (targets.length !== 1 || group.some(pairingWateringDisabled)) continue;
    const value = targets[0];
    // The portal knows each pot's current target, not its history, so lines say "current".
    const prefix = named && treatment !== "unknown" ? `Current ${treatment === "control" ? "control" : "drought"} target` : "Current target";
    lines.push({ value, label: `${prefix} ${formatVwc(value)?.replace(" VWC", "")}`, tone: treatmentTone[treatment] });
  }
  // Two treatments with the same target share one line.
  if (lines.length === 2 && lines[0].value === lines[1].value) {
    return [{ value: lines[0].value, label: `Current target ${formatVwc(lines[0].value)?.replace(" VWC", "")}`, tone: "neutral" }];
  }
  return lines;
}

/** Tooltip text for one pot's target. */
export function pairingTargetText(pairing: PairingRow | undefined, experiment: Pick<PortalExperiment, "status" | "wateringState" | "mode" | "endedAt">) {
  if (!pairing) return null;
  if (isObservationOnlyExperiment(experiment as PortalExperiment)) return "Sensing only";
  if (pairingWateringDisabled(pairing)) return "Watering disabled";
  return `Target ${formatVwc(pairing.wtc_percent_limit)}`;
}

/** "Day 6", "Day 6 of 14", or "Completed after 14 days", from the recorded start and end. */
export function experimentProgressText(experiment: Pick<PortalExperiment, "startedAt" | "endedAt" | "status">, nowMs = Date.now()) {
  const started = experiment.startedAt ? Date.parse(experiment.startedAt) : Number.NaN;
  if (!Number.isFinite(started) || started > nowMs) return null;
  const ended = experiment.endedAt ? Date.parse(experiment.endedAt) : Number.NaN;
  const dayMs = 86_400_000;
  if (Number.isFinite(ended) && ended <= nowMs) {
    return `Completed after ${Math.max(1, Math.round((ended - started) / dayMs))} days`;
  }
  const day = Math.floor((nowMs - started) / dayMs) + 1;
  if (Number.isFinite(ended)) return `Day ${day} of ${Math.max(day, Math.ceil((ended - started) / dayMs))}`;
  return `Day ${day}`;
}
