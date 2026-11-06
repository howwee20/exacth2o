import { hardLimits, singlePotLimitation, validateConfig, validateSelection } from "./orchestrator";
import type {
  CommissioningConfig,
  CommissioningMode,
  ControllerStatus,
  IntakeProbe,
  ManualIntervention,
  SelectedPot,
  SensorBaseline,
} from "./types";

// Pure evaluation of preflight facts. Gathering the facts is the adapter's job;
// deciding whether a run may start is decided here so it can be tested.

export type PreflightFacts = {
  mode: CommissioningMode;
  role: string | null;
  pots: readonly SelectedPot[];
  config: CommissioningConfig;
  nowMs: number;
  controller: ControllerStatus | null;
  controllerError: string | null;
  activeWateringCommands: number | null;
  intake: IntakeProbe | null;
  baselines: readonly SensorBaseline[];
  // Selected pairings whose automatic watering could still fire during the run.
  autoWateringPairings: readonly string[];
  /** Hold-to-water sessions in the recent past (null when they could not be read). */
  manualHolds?: readonly ManualIntervention[] | null;
  /** Another autocalibration session holding this controller. */
  otherActiveSession?: { runId: string; operator: string | null; startedAt: string } | null;
};

export type PreflightStatus = "pass" | "fail" | "warn";

export type PreflightCheck = {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  // A failed check with blocks=false is reported but does not stop a dry run.
  blocks: boolean;
};

export type PreflightReport = {
  checks: PreflightCheck[];
  canStart: boolean;
  estimatedMinutes: number | null;
  /** Upper estimate if every valve needs its one retry. */
  estimatedMaxMinutes: number | null;
  worstCaseValveSeconds: number;
};

export const operatorRoles = new Set(["admin", "researcher"]);

export function formatDuration(minutes: number) {
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function evaluatePreflight(facts: PreflightFacts): PreflightReport {
  const real = facts.mode === "real";
  const checks: PreflightCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string, blocks = true, warnOnly = false) => {
    checks.push({ id, label, status: ok ? "pass" : warnOnly ? "warn" : "fail", detail, blocks: !ok && blocks && !warnOnly });
  };
  const nameFor = new Map(facts.pots.map((pot) => [pot.sensorKey, pot.potNumber != null ? `Pot ${pot.potNumber}` : pot.pairingName]));

  add("role", "Operator access",
    operatorRoles.has(facts.role ?? ""),
    operatorRoles.has(facts.role ?? "")
      ? `Signed in as a project ${facts.role}.`
      : "Autocalibration needs project researcher or administrator access.");

  add("session", "No other autocalibration is using this controller",
    !facts.otherActiveSession,
    facts.otherActiveSession
      ? `Run ${facts.otherActiveSession.runId}${facts.otherActiveSession.operator ? ` (${facts.otherActiveSession.operator})` : ""} started ${new Date(facts.otherActiveSession.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} and is still open. Resume, finish or abandon it first.`
      : "This controller is free.");

  const selectionProblems = validateSelection(facts.pots);
  add("selection", `Selection of ${hardLimits.minPots}–${hardLimits.maxPots} pots with unique identities`,
    selectionProblems.length === 0,
    selectionProblems.length
      ? selectionProblems.join(" ")
      : `${facts.pots.length} pots, each with one distinct valve and one distinct sensor. Every pulse is measured on all ${facts.pots.length} sensors.`);
  if (facts.pots.length === 1 && !selectionProblems.includes(singlePotLimitation)) {
    add("single_pot", "More than one pot selected", false, singlePotLimitation);
  }

  const configProblems = validateConfig(facts.config, facts.pots.length);
  const worstCaseValveSeconds = facts.pots.length * (facts.config.pulseSeconds + facts.config.escalatedPulseSeconds);
  add("limits", "Pulse and water budget within limits",
    configProblems.length === 0,
    configProblems.length
      ? configProblems.join(" ")
      : `${facts.config.pulseSeconds}s pulses, at most one ${facts.config.escalatedPulseSeconds}s retry per valve; budget ${facts.config.maxTotalValveSeconds} valve-seconds and ${facts.config.maxPulses} pulses.`);
  add("budget_covers", "Budget covers the planned pulses",
    facts.config.maxTotalValveSeconds >= facts.pots.length * facts.config.pulseSeconds,
    facts.config.maxTotalValveSeconds >= worstCaseValveSeconds
      ? `Worst case is ${worstCaseValveSeconds} valve-seconds (${facts.pots.length} × ${facts.config.pulseSeconds + facts.config.escalatedPulseSeconds}s), inside the budget.`
      : facts.config.maxTotalValveSeconds >= facts.pots.length * facts.config.pulseSeconds
        ? `The budget covers one pulse per valve but not every possible retry (worst case ${worstCaseValveSeconds}). The run stops safely if it runs out.`
        : `The budget is smaller than one pulse per valve (${facts.pots.length * facts.config.pulseSeconds} valve-seconds needed).`);

  const controller = facts.controller;
  const fresh = controller?.freshUntilMs != null && controller.freshUntilMs > facts.nowMs;
  add("controller_fresh", "Controller reachable and reporting",
    Boolean(fresh),
    facts.controllerError
      ? `Could not read the controller status: ${facts.controllerError}`
      : fresh
        ? "The controller status is current."
        : controller?.observedAtMs
          ? `The controller was last seen ${Math.round((facts.nowMs - controller.observedAtMs) / 60000)} min ago. It looks offline.`
          : "The controller has never reported to the portal.");

  const state = (controller?.controllerState ?? "").trim().toUpperCase();
  const safe = fresh && facts.config.safeControllerStates.includes(state);
  add("controller_state", `Controller in a safe commissioning state (${facts.config.safeControllerStates.join(" or ")})`,
    Boolean(safe),
    safe
      ? `The controller reports ${state}, so its sensors keep reporting during the run.`
      : state === "STOPPED"
        ? "The controller is STOPPED, which pauses sensing, so no response could be measured. Resume it with automatic watering disabled on the selected pots."
        : `The controller reports ${state || "no state"}.`);

  add("auto_watering", "Automatic watering disabled on every selected pot",
    facts.autoWateringPairings.length === 0,
    facts.autoWateringPairings.length
      ? `${facts.autoWateringPairings.length} selected pot(s) still have an active target, so the controller could water them on its own mid-run. Use “Prepare the pots”.`
      : "No selected pot can be watered automatically during the run.");

  add("queue_clear", "No conflicting watering command",
    facts.activeWateringCommands === 0,
    facts.activeWateringCommands == null
      ? "Could not read the command queue."
      : facts.activeWateringCommands === 0
        ? "No watering command is queued or running."
        : `${facts.activeWateringCommands} watering command(s) are queued or running.`);

  if (facts.manualHolds !== undefined) {
    const holds = facts.manualHolds;
    const open = holds?.find((hold) => hold.endedAtMs == null) ?? null;
    const recent = holds?.filter((hold) => hold.endedAtMs != null && hold.endedAtMs + facts.config.manualSettleSeconds * 1000 > facts.nowMs) ?? [];
    add("manual_hold", "No manual watering in progress",
      holds != null && !open,
      holds == null
        ? "Could not read manual watering records, so manual watering cannot be ruled out."
        : open
          ? `${open.label} is being watered by hand now. Autocalibration starts after it ends and the pots settle.`
          : recent.length
            ? `Manual watering ended ${Math.round((facts.nowMs - Math.max(...recent.map((hold) => hold.endedAtMs ?? 0))) / 60000)} min ago; baselines will use readings from after the pots settle.`
            : "No manual watering in the last half hour.");
  }

  const unusable = facts.baselines.filter((item) => !item.valid);
  const missing = facts.pots.filter((pot) => !facts.baselines.some((item) => item.sensorKey === pot.sensorKey));
  const describe = (sensorKey: string, why: string) => `${nameFor.get(sensorKey) ?? sensorKey} (${sensorKey}): ${why}`;
  add("sensors", "Selected sensors reporting plausible values",
    facts.baselines.length > 0 && unusable.length === 0 && missing.length === 0,
    facts.baselines.length === 0
      ? "No recent readings were found for the selected sensors."
      : unusable.length || missing.length
        ? [...unusable.map((item) => describe(item.sensorKey, item.reason ?? "not usable")), ...missing.map((pot) => describe(pot.sensorKey, "no readings."))].slice(0, 12).join(" ") +
          (unusable.length + missing.length > 12 ? ` …and ${unusable.length + missing.length - 12} more.` : "")
        : `All ${facts.baselines.length} sensors have recent, plausible readings.`);

  const cadences = facts.baselines.map((item) => item.cadenceSeconds).filter((value): value is number => value != null);
  const cadence = cadences.length ? Math.max(...cadences) : null;
  const perValveSeconds = cadence == null ? null : facts.config.cooldownSeconds + facts.config.settleSkipSeconds + cadence * (facts.config.minPostReadings + 1);
  const cadenceOk = cadence != null && perValveSeconds != null && perValveSeconds <= facts.config.maxObserveSeconds;
  const estimatedMinutes = perValveSeconds == null ? null : Math.round((facts.pots.length * perValveSeconds) / 60);
  const estimatedMaxMinutes = perValveSeconds == null ? null : Math.round((2 * facts.pots.length * perValveSeconds) / 60);
  add("cadence", "Sensors report often enough to see a response",
    cadenceOk,
    cadence == null
      ? "Not enough readings to work out how often the sensors report."
      : cadenceOk
        ? `Sensors report about every ${Math.round(cadence)}s, so each valve needs roughly ${Math.round((perValveSeconds as number) / 60)} min.`
        : `Sensors report about every ${Math.round(cadence)}s, too slow for the ${Math.round(facts.config.maxObserveSeconds / 60)} min observation window. If the pots were just prepared, wait a few minutes for readings at the new interval and check again; otherwise shorten their measurement interval first.`,
    true,
    cadence != null && !cadenceOk ? false : cadence == null);

  if (estimatedMinutes != null) {
    const limitMinutes = facts.config.maxRunSeconds / 60;
    add("duration", "Run fits its time limit",
      (estimatedMaxMinutes ?? 0) <= limitMinutes,
      `About ${formatDuration(estimatedMinutes)} (up to ${formatDuration(estimatedMaxMinutes ?? estimatedMinutes)} if every valve needs its retry). The run stops itself after ${formatDuration(limitMinutes)}. Keep this screen open: closing it stops further pulses, and the run can be resumed later from its recorded evidence.`,
      true,
      true);
  }

  if (facts.intake) {
    add("intake", "Server accepts watering commands (physical fail-safe recorded)",
      facts.intake.open,
      facts.intake.open
        ? "The command service is accepting bounded watering commands."
        : `The command service refused: ${facts.intake.detail} This gate is opened by the platform owner only after the valve fail-safe bench check.`,
      real);
  } else {
    add("intake", "Server accepts watering commands (physical fail-safe recorded)", false, "The watering-command gate has not been checked yet.", real);
  }

  checks.push({
    id: "executor_gate",
    label: "Controller executor allows timed pulses",
    status: "warn",
    detail: "The portal cannot read the controller's own manual-water gate. If it is closed, the first pulse is refused, nothing is watered, and the run stops.",
    blocks: false,
  });

  return {
    checks,
    canStart: checks.every((check) => !check.blocks),
    estimatedMinutes,
    estimatedMaxMinutes,
    worstCaseValveSeconds,
  };
}
