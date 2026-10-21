import type { AerialPotState } from "../product/AerialBench";
import type { CommissioningConfig, CommissioningResult, PulseEvidence, RunOutcome, SelectedPot } from "../commissioning/types";
import type { StatusTone } from "../settingsPresentation";
import type { PairingRow } from "../types";
import type { PotAvailability } from "./selection";

// Words and per-pot states for Settings → Autocalibrate. Pure, so every state the
// aerial view can show is tested without a browser.

export const outcomeText: Record<RunOutcome, { tone: StatusTone; label: string }> = {
  completed: { tone: "ok", label: "Completed" },
  completed_with_findings: { tone: "warning", label: "Completed with findings to review" },
  dry_run_completed: { tone: "info", label: "Rehearsal completed: no valve was opened" },
  aborted: { tone: "bad", label: "Stopped" },
  interrupted: { tone: "warning", label: "Interrupted" },
  stopped_by_interlock: { tone: "bad", label: "Stopped by a safety check" },
  failed: { tone: "bad", label: "Failed" },
};

export const faultText: Record<string, string> = {
  no_response: "No sensor rose",
  multiple_responses: "Several sensors rose about equally",
  cross_talk: "A second sensor also rose",
  duplicate_claim: "Another valve raised the same sensor",
  overshoot: "Rise larger than a short pulse should cause",
  low_confidence: "Weak evidence",
  reference_conflict: "Contradicts a known-correct reference pot",
  not_reached: "Not tested before the run stopped",
  command_failed: "Controller did not confirm the pulse",
  invalidated: "Evidence set aside",
};

export const faultAdvice: Record<string, string> = {
  no_response: "The hose may be disconnected or blocked, the valve may water a pot outside this selection, or the pot was too wet to respond. Check the outlet, or include its neighbours or its whole zone and run again.",
  multiple_responses: "Two pots responded about equally: a split or shared hose, or two hoses crossed at the same outlet. Check at the bench.",
  cross_talk: "Water reached a second pot (runoff, a shared tray or a leak). The strongest response is proposed but needs review.",
  duplicate_claim: "Two valves both raised this sensor. One of them is miswired or shares a line; check both at the bench.",
  overshoot: "The pot rose far more than a short pulse should cause. Check the outlet for a stuck or leaking valve.",
  low_confidence: "The rise was small compared with the sensor's noise. Re-run with a longer pulse or check the sensor.",
  reference_conflict: "A pot the researchers confirmed at the bench came out differently. Treat this run's other results with suspicion until it is explained.",
  not_reached: "Resume the run to test it.",
  command_failed: "The controller did not acknowledge the pulse, so nothing was measured. Check the controller and resume.",
  invalidated: "Manual watering or a stop overlapped this observation; it is measured again on resume.",
};

export function potName(potNumber: number | null | undefined, pairingName: string) {
  return potNumber != null ? `Pot ${potNumber}` : pairingName;
}

export function formatDuration(minutes: number) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatClock(value: string | number | null | undefined) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatWhen(value: string | number | null | undefined) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Per valve: cooldown, settle skip, then enough readings at the prepared 60 s cadence. */
export function minutesPerValve(config: Pick<CommissioningConfig, "cooldownSeconds" | "settleSkipSeconds" | "minPostReadings">, cadenceSeconds = 60) {
  return (config.cooldownSeconds + config.settleSkipSeconds + cadenceSeconds * (config.minPostReadings + 1)) / 60;
}

export function estimateRun(count: number, config: Pick<CommissioningConfig, "cooldownSeconds" | "settleSkipSeconds" | "minPostReadings" | "baselineTimeoutSeconds">) {
  const perValve = minutesPerValve(config);
  return { typicalMinutes: count * perValve + 10, worstMinutes: 2 * count * perValve + config.baselineTimeoutSeconds / 60 };
}

/** Selection stage: availability, selection and references. */
export function selectionStates(pairings: readonly PairingRow[], availability: ReadonlyMap<string, PotAvailability>, references: ReadonlySet<string>) {
  const states = new Map<string, AerialPotState>();
  for (const pairing of pairings) {
    const item = availability.get(pairing.name);
    states.set(pairing.name, {
      available: item?.available !== false,
      reason: item?.reason,
      reference: references.has(pairing.name),
      // Each pot's notes are in its details (I or a long press); the name stays short for 100 pots.
    });
  }
  return states;
}

function finalEvidence(evidence: readonly PulseEvidence[]) {
  const byValve = new Map<string, PulseEvidence>();
  for (const item of evidence) if (!item.invalidated) byValve.set(item.valveKey, item);
  return byValve;
}

function strongest(item: PulseEvidence) {
  return item.responses.filter((response) => response.detected).sort((a, b) => b.deltaVwc - a.deltaVwc)[0] ?? null;
}

/**
 * While a run is going: which pot is being tested, which are still queued, and a
 * preliminary reading of the ones already measured. Preliminary because only the
 * complete matrix can rule out a rival valve.
 */
export function liveStates(input: {
  pots: readonly SelectedPot[];
  evidence: readonly PulseEvidence[];
  completedValves: readonly string[];
  activeValveKey: string | null;
  potForSensor: ReadonlyMap<string, number | null>;
}) {
  const states = new Map<string, AerialPotState>();
  const final = finalEvidence(input.evidence);
  const completed = new Set(input.completedValves);
  for (const pot of input.pots) {
    const item = final.get(pot.valveKey);
    let state: AerialPotState = { available: true, status: "queued", reference: pot.reference, detail: "waiting to be tested" };
    if (input.activeValveKey === pot.valveKey) state = { available: true, status: "active", reference: pot.reference, detail: "its valve is being tested now" };
    else if (item && item.acknowledgement.status !== "succeeded" && item.acknowledgement.status !== "not_sent") {
      state = { available: true, status: "failed", reference: pot.reference, detail: "the controller did not confirm its pulse" };
    } else if (item && completed.has(pot.valveKey)) {
      const top = strongest(item);
      if (!top) state = { available: true, status: "unresolved", reference: pot.reference, detail: "its valve raised no selected sensor (preliminary)" };
      else if (top.sensorKey === pot.sensorKey) state = { available: true, status: "matched", reference: pot.reference, detail: "its valve raised its own sensor (preliminary)" };
      else {
        const other = input.potForSensor.get(top.sensorKey);
        state = { available: true, status: "changed", reference: pot.reference, detail: `its valve raised ${other != null ? `pot ${other}` : top.sensorKey} instead (preliminary)` };
      }
    }
    states.set(pot.pairingName, state);
  }
  return states;
}

/**
 * After a run: what was found for each pot. A pot is "changed" when its recorded valve
 * waters another pot, or another valve waters it.
 */
export function resultStates(result: CommissioningResult, potForSensor: ReadonlyMap<string, number | null>) {
  const states = new Map<string, AerialPotState>();
  const byValve = new Map(result.proposals.map((proposal) => [proposal.valveKey, proposal]));
  const bySensor = new Map(result.proposals.map((proposal) => [proposal.proposedSensorKey, proposal]));
  const unresolved = new Map(result.unresolved.map((item) => [item.valveKey, item]));
  const unclaimed = new Set(result.unclaimed.map((item) => item.sensorKey));
  const complete = result.outcome === "completed" || result.outcome === "completed_with_findings";
  const done = new Set(result.completedValves);
  for (const pot of result.pots) {
    const own = byValve.get(pot.valveKey);
    const into = bySensor.get(pot.sensorKey);
    const missing = unresolved.get(pot.valveKey);
    let state: AerialPotState;
    if (!complete) {
      state = done.has(pot.valveKey)
        ? { available: true, status: "interrupted", reference: pot.reference, detail: "measured before the run stopped; no mapping is proposed from an incomplete run" }
        : { available: true, status: "queued", reference: pot.reference, detail: "not yet measured" };
    } else if (missing?.reason === "command_failed") {
      state = { available: true, status: "failed", reference: pot.reference, detail: faultText.command_failed };
    } else if (missing) {
      state = { available: true, status: "unresolved", reference: pot.reference, detail: `${faultText[missing.reason] ?? missing.reason}` };
    } else if (unclaimed.has(pot.sensorKey)) {
      state = { available: true, status: "unclaimed", reference: pot.reference, detail: "no selected valve raised its sensor" };
    } else if ((own && !own.matchesRecord) || (into && into.valveKey !== pot.valveKey)) {
      const waters = own ? potForSensor.get(own.proposedSensorKey) : null;
      state = {
        available: true,
        status: "changed",
        reference: pot.reference,
        detail: [
          own && !own.matchesRecord ? `its recorded valve waters ${waters != null ? `pot ${waters}` : own.proposedSensorKey}` : null,
          into && into.valveKey !== pot.valveKey ? `valve ${into.valveKey} waters it` : null,
          (own?.status === "needs_review" || into?.status === "needs_review") ? "needs review" : null,
        ].filter(Boolean).join("; "),
      };
    } else {
      state = { available: true, status: "matched", reference: pot.reference, detail: own?.status === "needs_review" ? "matches its recorded valve; needs review" : "its recorded valve waters it" };
    }
    states.set(pot.pairingName, state);
  }
  return states;
}

/** Valve-level summary counts for the results header. */
export function resultCounts(result: CommissioningResult) {
  const matched = result.proposals.filter((proposal) => proposal.matchesRecord).length;
  const different = result.proposals.filter((proposal) => !proposal.matchesRecord).length;
  const review = result.proposals.filter((proposal) => proposal.status === "needs_review").length;
  const byReason = new Map<string, number>();
  result.unresolved.forEach((item) => byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1));
  return { tested: result.completedValves.length, total: result.pots.length, matched, different, review, unresolved: result.unresolved.length, unclaimed: result.unclaimed.length, byReason };
}
