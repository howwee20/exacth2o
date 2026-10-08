import { potRangeText } from "./experimentFactors";
import { experimentIsCompleted } from "./experimentMeasurement";
import { isObservationOnlyExperiment, type PortalExperiment } from "./experimentRegistry";
import { freshnessThresholds } from "./measurementFreshness";
import { pairingWateringDisabled } from "./targetPresentation";
import type { PairingRow, SensorReading } from "./types";

/**
 * The home is quiet when everything is healthy. Only these conditions speak, and they are kept
 * distinct because each needs a different person to do something different:
 *
 * - refresh-failed: this browser could not check for new readings. Says nothing about the
 *   controller; the last good data and when it was loaded stay on screen.
 * - controller-offline: controller presence lapsed (state_fresh_until), stated once for the
 *   installation instead of once per experiment.
 * - missing-observations: specific pots stopped reporting while the controller is present.
 * - configuration-discrepancy: the experiment plan and the controller's applied target differ.
 * - activation-failed: the experiment's controller activation needs review.
 */
export type HomeException =
  | { kind: "refresh-failed"; scope: "portal"; failedAt: number; lastSuccessAt: number | null; sentence: string }
  | { kind: "controller-offline"; scope: "installation"; lastSeenAt: number | null; sentence: string }
  | {
    kind: "missing-observations" | "configuration-discrepancy" | "activation-failed";
    scope: "experiment";
    experimentId: string;
    pairingNames: string[];
    short: string;
    sentence: string;
  };

export type ExperimentException = Extract<HomeException, { scope: "experiment" }>;

export type HomeExceptionInput = {
  experiments: readonly PortalExperiment[];
  pairings: readonly PairingRow[];
  readings: readonly Pick<SensorReading, "pairing_name" | "device_recorded_at">[];
  nowMs: number;
  /** Whether a successful readings check has completed in this session. */
  checked: boolean;
  refresh: { failedAt: number | null; lastSuccessAt: number | null };
  controller: { offline: boolean; lastSeenAt: number | null } | null;
  formatTime: (ms: number) => string;
};

function boardOf(sensorKey: string | null | undefined) {
  const board = typeof sensorKey === "string" ? sensorKey.split(":")[0]?.trim() : "";
  return board || null;
}

function latestByPot(readings: HomeExceptionInput["readings"]) {
  const latest = new Map<string, number>();
  for (const reading of readings) {
    const at = Date.parse(reading.device_recorded_at);
    if (Number.isFinite(at) && at > (latest.get(reading.pairing_name) ?? -Infinity)) latest.set(reading.pairing_name, at);
  }
  return latest;
}

/** Pots in an experiment with no current reading, judged against each pot's own cadence. */
export function silentExperimentPots(
  experiment: PortalExperiment,
  pairings: readonly PairingRow[],
  latest: ReadonlyMap<string, number>,
  asOfMs: number,
) {
  const byName = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  const silent: { name: string; potNumber: number | null; board: string | null; lastAt: number | null }[] = [];
  for (const name of experiment.pairingNames) {
    const pairing = byName.get(name);
    const lastAt = latest.get(name) ?? null;
    // "Stale" (beyond six missed reports), not merely late, so one slow upload stays quiet.
    const { delayedMs } = freshnessThresholds(pairing?.measurement_interval_ms ?? null);
    if (lastAt == null || asOfMs - lastAt > delayedMs) {
      silent.push({ name, potNumber: pairing?.pot_number ?? null, board: boardOf(pairing?.sensor_key), lastAt });
    }
  }
  return silent;
}

/** Pots whose experiment plan target differs from the target the controller is applying. */
export function targetDiscrepancies(experiment: PortalExperiment, pairings: readonly PairingRow[]) {
  if (isObservationOnlyExperiment(experiment) || experiment.wateringState !== "controller_managed") return [];
  const byName = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  const differing: { name: string; potNumber: number; plan: number; applied: number }[] = [];
  for (const assignment of experiment.assignments ?? []) {
    const pairing = byName.get(assignment.pairing_name);
    const plan = assignment.target_vwc_percent;
    if (!pairing || plan == null || !Number.isFinite(plan) || pairingWateringDisabled(pairing)) continue;
    if (Math.abs(pairing.wtc_percent_limit - plan) > 0.001) {
      differing.push({ name: pairing.name, potNumber: pairing.pot_number, plan, applied: pairing.wtc_percent_limit });
    }
  }
  return differing;
}

const trimNumber = (value: number) => Number(value.toFixed(1));

export function homeExceptions(input: HomeExceptionInput): HomeException[] {
  const out: HomeException[] = [];
  const { refresh, controller, formatTime } = input;
  const refreshFailed = refresh.failedAt != null && (refresh.lastSuccessAt == null || refresh.failedAt > refresh.lastSuccessAt);
  if (refreshFailed && refresh.failedAt != null) {
    out.push({
      kind: "refresh-failed",
      scope: "portal",
      failedAt: refresh.failedAt,
      lastSuccessAt: refresh.lastSuccessAt,
      sentence: refresh.lastSuccessAt
        ? `Couldn't check for new readings at ${formatTime(refresh.failedAt)}. Showing what was loaded at ${formatTime(refresh.lastSuccessAt)}; this is the portal's connection, not a controller report.`
        : `Couldn't load readings at ${formatTime(refresh.failedAt)}. Nothing below reflects the controller yet.`,
    });
  }
  const controllerOffline = controller?.offline === true;
  if (controllerOffline) {
    out.push({
      kind: "controller-offline",
      scope: "installation",
      lastSeenAt: controller?.lastSeenAt ?? null,
      sentence: controller?.lastSeenAt != null
        ? `Controller offline since ${formatTime(controller.lastSeenAt)}: it has not reported; readings and watering status are unconfirmed.`
        : "Controller offline: it has not reported its state recently; readings and watering status are unconfirmed.",
    });
  }

  // Missing observations are judged as of the last successful check, never against a clock the
  // portal could not confirm; with no successful check there is nothing to judge.
  const asOfMs = refreshFailed ? refresh.lastSuccessAt : input.checked ? input.nowMs : null;
  const latest = latestByPot(input.readings);

  for (const experiment of input.experiments) {
    if (experiment.status === "activation_failed") {
      out.push({
        kind: "activation-failed",
        scope: "experiment",
        experimentId: experiment.id,
        pairingNames: [...experiment.pairingNames],
        short: "Activation needs review",
        sentence: `${experiment.name}: the controller activation did not complete. Open the experiment to review it.`,
      });
      continue;
    }
    if (experimentIsCompleted(experiment, input.nowMs)) continue;

    if (asOfMs != null && !controllerOffline) {
      const silent = silentExperimentPots(experiment, input.pairings, latest, asOfMs);
      if (silent.length) {
        const numbers = silent.map((pot) => pot.potNumber).filter((value): value is number => value != null);
        const boards = Array.from(new Set(silent.map((pot) => pot.board).filter(Boolean)));
        const allBoard = boards.length === 1 && silent.every((pot) => pot.board === boards[0]);
        const lastAt = silent.reduce<number | null>((max, pot) => (pot.lastAt != null && (max == null || pot.lastAt > max) ? pot.lastAt : max), null);
        const neverInWindow = silent.every((pot) => pot.lastAt == null);
        const since = neverInWindow ? "in the loaded 72 hours" : `since ${formatTime(lastAt as number)}`;
        const potText = numbers.length === silent.length ? potRangeText(numbers) : `${silent.length} pots`;
        out.push({
          kind: "missing-observations",
          scope: "experiment",
          experimentId: experiment.id,
          pairingNames: silent.map((pot) => pot.name),
          short: `${silent.length} ${silent.length === 1 ? "pot" : "pots"} without readings ${since}`,
          sentence: `${potText}${allBoard ? ` (sensor board ${boards[0]})` : ""} ${silent.length === 1 ? "has" : "have"} no readings ${since}; the controller is reporting.`,
        });
      }
    }

    const differing = targetDiscrepancies(experiment, input.pairings);
    if (differing.length) {
      const plans = Array.from(new Set(differing.map((pot) => trimNumber(pot.plan))));
      const applied = Array.from(new Set(differing.map((pot) => trimNumber(pot.applied))));
      const pots = potRangeText(differing.map((pot) => pot.potNumber));
      out.push({
        kind: "configuration-discrepancy",
        scope: "experiment",
        experimentId: experiment.id,
        pairingNames: differing.map((pot) => pot.name),
        short: plans.length === 1 && applied.length === 1
          ? `Plan ${plans[0]}% · controller ${applied[0]}% on ${differing.length} ${differing.length === 1 ? "pot" : "pots"}`
          : `Plan and controller targets differ on ${differing.length} ${differing.length === 1 ? "pot" : "pots"}`,
        sentence: `${pots}: the experiment plan says ${plans.map((value) => `${value}%`).join(" / ")} VWC, but the controller is applying ${applied.map((value) => `${value}%`).join(" / ")}. Watering follows the controller.`,
      });
    }
  }
  return out;
}

/** The one line shown on an experiment card: the most actionable condition, plus how many more. */
export function primaryExperimentException(exceptions: readonly HomeException[], experimentId: string) {
  const order: ExperimentException["kind"][] = ["activation-failed", "missing-observations", "configuration-discrepancy"];
  const own = exceptions.filter((item): item is ExperimentException => item.scope === "experiment" && item.experimentId === experimentId);
  own.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return own.length ? { primary: own[0], more: own.length - 1 } : null;
}
