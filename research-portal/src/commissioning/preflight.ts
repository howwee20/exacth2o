import { hardLimits, validateConfig, validateSelection } from "./orchestrator";
import type {
  CommissioningConfig,
  CommissioningMode,
  ControllerStatus,
  IntakeProbe,
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
  worstCaseValveSeconds: number;
};

export function evaluatePreflight(facts: PreflightFacts): PreflightReport {
  const real = facts.mode === "real";
  const checks: PreflightCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string, blocks = true, warnOnly = false) => {
    checks.push({ id, label, status: ok ? "pass" : warnOnly ? "warn" : "fail", detail, blocks: !ok && blocks && !warnOnly });
  };

  add("role", "Administrator access",
    facts.role === "admin",
    facts.role === "admin"
      ? "Signed in as a project administrator."
      : "Hardware commissioning is limited to project administrators.");

  const selectionProblems = validateSelection(facts.pots);
  add("selection", `Selection of ${hardLimits.minPots}–${hardLimits.maxPots} pots with unique identities`,
    selectionProblems.length === 0,
    selectionProblems.length ? selectionProblems.join(" ") : `${facts.pots.length} pots, each with one distinct valve and one distinct sensor.`);

  const configProblems = validateConfig(facts.config);
  const worstCaseValveSeconds = facts.pots.length * (facts.config.pulseSeconds + facts.config.escalatedPulseSeconds);
  add("limits", "Pulse and water budget within limits",
    configProblems.length === 0,
    configProblems.length
      ? configProblems.join(" ")
      : `${facts.config.pulseSeconds}s pulses, one ${facts.config.escalatedPulseSeconds}s retry at most, budget ${facts.config.maxTotalValveSeconds} valve-seconds and ${facts.config.maxPulses} pulses.`);
  add("budget_covers", "Budget covers the planned pulses",
    facts.config.maxTotalValveSeconds >= facts.pots.length * facts.config.pulseSeconds,
    facts.config.maxTotalValveSeconds >= worstCaseValveSeconds
      ? `Worst case is ${worstCaseValveSeconds} valve-seconds, inside the budget.`
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
      ? `${facts.autoWateringPairings.join(", ")} still ${facts.autoWateringPairings.length === 1 ? "has" : "have"} an active target, so the controller could water ${facts.autoWateringPairings.length === 1 ? "it" : "them"} on its own mid-run. Use “Prepare pots” below.`
      : "No selected pot can be watered automatically during the run.");

  add("queue_clear", "No conflicting watering command",
    facts.activeWateringCommands === 0,
    facts.activeWateringCommands == null
      ? "Could not read the command queue."
      : facts.activeWateringCommands === 0
        ? "No watering command is queued or running."
        : `${facts.activeWateringCommands} watering command(s) are queued or running.`);

  const unusable = facts.baselines.filter((item) => !item.valid);
  const missing = facts.pots.filter((pot) => !facts.baselines.some((item) => item.sensorKey === pot.sensorKey));
  add("sensors", "Selected sensors reporting plausible values",
    facts.baselines.length > 0 && unusable.length === 0 && missing.length === 0,
    facts.baselines.length === 0
      ? "No recent readings were found for the selected sensors."
      : unusable.length || missing.length
        ? [...unusable.map((item) => `${item.sensorKey}: ${item.reason}`), ...missing.map((pot) => `${pot.sensorKey}: no readings.`)].join(" ")
        : `All ${facts.baselines.length} sensors have recent, plausible readings.`);

  const cadences = facts.baselines.map((item) => item.cadenceSeconds).filter((value): value is number => value != null);
  const cadence = cadences.length ? Math.max(...cadences) : null;
  const perValveSeconds = cadence == null ? null : facts.config.cooldownSeconds + facts.config.settleSkipSeconds + cadence * (facts.config.minPostReadings + 1);
  const cadenceOk = cadence != null && perValveSeconds != null && perValveSeconds <= facts.config.maxObserveSeconds;
  add("cadence", "Sensors report often enough to see a response",
    cadenceOk,
    cadence == null
      ? "Not enough readings to work out how often the sensors report."
      : cadenceOk
        ? `Sensors report about every ${Math.round(cadence)}s, so each valve needs roughly ${Math.round(perValveSeconds / 60)} min.`
        : `Sensors report about every ${Math.round(cadence)}s, too slow for the ${Math.round(facts.config.maxObserveSeconds / 60)} min observation window. Shorten the measurement interval for these pots first.`,
    true,
    cadence != null && !cadenceOk ? false : cadence == null);

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
    estimatedMinutes: perValveSeconds == null ? null : Math.round((facts.pots.length * perValveSeconds) / 60),
    worstCaseValveSeconds,
  };
}
