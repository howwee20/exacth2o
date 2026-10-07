/**
 * What a group's target VWC means, stated explicitly.
 *
 * An intentional 0 % target, a missing target, watering disabled on the
 * controller, a sensing-only experiment and a completed experiment are
 * different situations and must never share one ambiguous "0%" label.
 * Nothing here changes a stored value.
 */

/** The controller's "watering disabled" sentinel for WTCPercentLimit. */
export const wateringDisabledTarget = -999_999;

export type TargetKind =
  | "target"
  | "zero_target"
  | "unset"
  | "mixed"
  | "watering_disabled"
  | "sensing_only"
  | "completed";

export type TargetPresentation = {
  kind: TargetKind;
  /** Compact label for chart and card headers. */
  label: string;
  /** Sentence for titles and screen readers. */
  detail: string;
  /** Numeric target to draw as a reference line, when one applies. */
  lineValue: number | null;
};

export type TargetPairing = {
  wtc_percent_limit: number;
  valve_open_time_ms: number;
  measurement_interval_ms?: number;
};

/**
 * Mirrors the controller's isWateringConfigEnabled: watering runs only with a
 * 0-100 % target, a positive valve opening and a positive measurement interval.
 * The -999999 sentinel and a zero-length opening both disable it.
 */
export function pairingWateringDisabled(pairing: TargetPairing) {
  const target = pairing.wtc_percent_limit;
  const interval = pairing.measurement_interval_ms;
  return !(
    Number.isFinite(target) && target >= 0 && target <= 100 &&
    Number.isFinite(pairing.valve_open_time_ms) && pairing.valve_open_time_ms > 0 &&
    (interval == null || (Number.isFinite(interval) && interval > 0))
  );
}

export function formatVwc(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return null;
  return `${Number(value.toFixed(digits))}% VWC`;
}

export function presentTarget(input: {
  /** Target from the experiment specification, or a single shared controller target. */
  target: number | null | undefined;
  /** Distinct target values among the group's pots, when they differ. */
  distinctTargets?: readonly number[];
  experimentStatus?: string | null;
  sensingOnly?: boolean;
  /** Every pot in the group has watering disabled on the controller. */
  wateringDisabled?: boolean;
}): TargetPresentation {
  const target = input.target != null && Number.isFinite(input.target) ? input.target : null;
  const completed = input.experimentStatus === "completed" || input.experimentStatus === "archived";
  const targetText = target == null || target <= -9_999 ? null : formatVwc(target);

  if (completed) {
    return {
      kind: "completed",
      label: targetText ? `Completed · target was ${targetText}` : "Completed",
      detail: targetText
        ? `This experiment is complete. Its target was ${targetText}; no watering is scheduled.`
        : "This experiment is complete; no watering is scheduled.",
      lineValue: target != null && target > -9_999 ? target : null,
    };
  }
  if (input.sensingOnly) {
    return {
      kind: "sensing_only",
      label: "Sensing only",
      detail: "Sensing only: moisture is measured but the portal does not water these pots.",
      lineValue: null,
    };
  }
  if (input.wateringDisabled || (target != null && target <= -9_999)) {
    return {
      kind: "watering_disabled",
      label: "Watering disabled",
      detail: "Automatic watering is disabled on the controller for these pots.",
      lineValue: null,
    };
  }
  if (input.distinctTargets && input.distinctTargets.length > 1) {
    const sorted = input.distinctTargets.slice().sort((a, b) => a - b);
    return {
      kind: "mixed",
      label: `Targets ${formatVwc(sorted[0])?.replace(" VWC", "")}–${formatVwc(sorted[sorted.length - 1])}`,
      detail: `Pots in this group have different targets (${sorted.map((value) => formatVwc(value)).join(", ")}).`,
      lineValue: null,
    };
  }
  if (target == null) {
    return {
      kind: "unset",
      label: "No target set",
      detail: "No target VWC is recorded for this group.",
      lineValue: null,
    };
  }
  if (target === 0) {
    return {
      kind: "zero_target",
      label: "Target 0% VWC",
      detail: "Target 0% VWC: automatic watering would only begin if measured moisture fell to about 0%.",
      lineValue: 0,
    };
  }
  return {
    kind: "target",
    label: `Target ${targetText}`,
    detail: `Target ${targetText}: automatic watering aims to keep measured moisture at or above this level.`,
    lineValue: target,
  };
}
