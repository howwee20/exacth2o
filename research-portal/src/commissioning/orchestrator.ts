import { measureResponse, proposeTopology, summarizeBaseline } from "./analysis";
import type {
  CommandSnapshot,
  CommissioningConfig,
  CommissioningMode,
  CommissioningPorts,
  CommissioningResult,
  LogEntry,
  LogKind,
  PulseEvidence,
  Reading,
  RunOutcome,
  SelectedPot,
  SensorBaseline,
} from "./types";

// REAL HARDWARE commissioning orchestrator.
//
// Safety properties this module is responsible for (each has a test):
//  - Exactly one valve is commanded at a time, and only through ports.requestPulse.
//  - A dry run never calls ports.requestPulse.
//  - A real run cannot start without the exact typed confirmation.
//  - Interlocks are re-checked immediately before every pulse, and any command
//    failure, stale controller, conflict, silent sensor, or exhausted budget
//    stops the run. It never retries a failed command.
//  - A silent valve is escalated at most once, inside the configured limits.
//  - The run only ever produces a proposal. It has no way to change pairings.
//  - Nothing is scheduled ahead of time: if this page closes, no further pulse
//    is ever requested.

export const hardLimits = {
  minPots: 2,
  maxPots: 20,
  maxPulseSeconds: 10,
  maxEscalatedPulseSeconds: 15,
  maxTotalValveSeconds: 300,
  maxPulses: 40,
} as const;

export const defaultCommissioningConfig: CommissioningConfig = {
  pulseSeconds: 3,
  escalatedPulseSeconds: 6,
  maxTotalValveSeconds: 120,
  maxPulses: 40,
  baselineReadings: 4,
  baselineLookbackSeconds: 45 * 60,
  baselineTimeoutSeconds: 45 * 60,
  preReadings: 3,
  minPostReadings: 3,
  settleSkipSeconds: 60,
  maxObserveSeconds: 25 * 60,
  maxSettleSeconds: 30 * 60,
  quietRangeVwc: 0.25,
  dryRunObserveSeconds: 10,
  pollSeconds: 15,
  commandTimeoutSeconds: 240,
  cooldownSeconds: 65,
  sensorSilenceSeconds: 25 * 60,
  maxRunSeconds: 10 * 3600,
  minDeltaVwc: 0.5,
  minZ: 5,
  rivalZ: 3,
  ambiguousRatio: 0.7,
  saturationVwc: 45,
  overshootLimitVwc: 6,
  reviewConfidence: 0.6,
  // STOPPED pauses the controller's measurement loop, so no readings would
  // arrive. Commissioning needs RUNNING (sensing) with automatic watering
  // disabled on every selected pot, which the interlock checks separately.
  safeControllerStates: ["RUNNING"],
};

export function requiredConfirmation(pots: readonly SelectedPot[]) {
  return `OPEN ${pots.length} REAL VALVES`;
}

export function validateSelection(pots: readonly SelectedPot[]) {
  const problems: string[] = [];
  if (pots.length < hardLimits.minPots || pots.length > hardLimits.maxPots) {
    problems.push(`Select between ${hardLimits.minPots} and ${hardLimits.maxPots} pots (selected ${pots.length}).`);
  }
  const duplicates = (values: string[]) => Array.from(new Set(values.filter((value, index) => values.indexOf(value) !== index)));
  const blank = pots.filter((pot) => !pot.valveKey.trim() || !pot.sensorKey.trim() || !pot.pairingName.trim());
  if (blank.length) problems.push(`${blank.length} selected pot(s) are missing a valve, sensor, or pairing name.`);
  const valves = duplicates(pots.map((pot) => pot.valveKey));
  if (valves.length) problems.push(`Valve identities must be unique: ${valves.join(", ")}.`);
  const sensors = duplicates(pots.map((pot) => pot.sensorKey));
  if (sensors.length) problems.push(`Sensor identities must be unique: ${sensors.join(", ")}.`);
  const names = duplicates(pots.map((pot) => pot.pairingName));
  if (names.length) problems.push(`Pairing names must be unique: ${names.join(", ")}.`);
  return problems;
}

export function validateConfig(config: CommissioningConfig) {
  const problems: string[] = [];
  const within = (value: number, min: number, max: number, label: string) => {
    if (!Number.isFinite(value) || value < min || value > max) problems.push(`${label} must be between ${min} and ${max}.`);
  };
  within(config.pulseSeconds, 1, hardLimits.maxPulseSeconds, "Diagnostic pulse (sec)");
  within(config.escalatedPulseSeconds, config.pulseSeconds, hardLimits.maxEscalatedPulseSeconds, "Escalated pulse (sec)");
  within(config.maxTotalValveSeconds, config.pulseSeconds, hardLimits.maxTotalValveSeconds, "Water budget (valve-seconds)");
  within(config.maxPulses, 1, hardLimits.maxPulses, "Pulse budget");
  return problems;
}

export type RunPhase = "idle" | "baseline" | "discovery" | "analysis" | "done";

class StopRun extends Error {
  constructor(readonly outcome: RunOutcome, message: string) {
    super(message);
  }
}

const terminalStates = new Set(["succeeded", "failed", "canceled", "expired"]);

export class CommissioningRun {
  readonly runId: string;
  readonly mode: CommissioningMode;
  readonly pots: SelectedPot[];
  readonly config: CommissioningConfig;
  readonly log: LogEntry[] = [];
  readonly evidence: PulseEvidence[] = [];
  baselines: SensorBaseline[] = [];
  phase: RunPhase = "idle";
  activeValveKey: string | null = null;
  pulsesRequested = 0;
  valveSecondsRequested = 0;
  result: CommissioningResult | null = null;

  private readonly ports: CommissioningPorts;
  private readonly onUpdate: () => void;
  private readonly controller = new AbortController();
  private abortReason: string | null = null;
  private readings: Reading[] = [];
  private startedAtMs = 0;
  private lastPulseEndMs = 0;
  private commandInFlight = false;
  // Sensors that rose on the previous pulse are held to a stricter settle test.
  private recentResponders = new Set<string>();

  constructor(input: {
    runId: string;
    mode: CommissioningMode;
    pots: readonly SelectedPot[];
    ports: CommissioningPorts;
    config?: Partial<CommissioningConfig>;
    onUpdate?: () => void;
  }) {
    this.runId = input.runId;
    this.mode = input.mode;
    this.pots = input.pots.map((pot) => ({ ...pot }));
    this.ports = input.ports;
    this.config = { ...defaultCommissioningConfig, ...input.config };
    this.onUpdate = input.onUpdate ?? (() => undefined);
  }

  get running() {
    return this.phase !== "idle" && this.phase !== "done";
  }

  // Stops the run. No further pulse is requested after this returns. A pulse the
  // controller has already accepted still ends on the controller's own deadline.
  abort(reason = "Stopped by the operator.") {
    if (this.abortReason || this.phase === "done") return;
    this.abortReason = reason;
    this.write("abort", reason, { commandInFlight: this.commandInFlight });
    this.controller.abort();
    this.onUpdate();
  }

  async run(input: { confirmation?: string } = {}): Promise<CommissioningResult> {
    if (this.phase !== "idle") throw new Error("This commissioning run has already been started.");
    const selectionProblems = [...validateSelection(this.pots), ...validateConfig(this.config)];
    if (selectionProblems.length) throw new Error(selectionProblems.join(" "));
    if (this.mode === "real" && input.confirmation !== requiredConfirmation(this.pots)) {
      throw new Error("The typed confirmation does not match. No valve was commanded.");
    }

    this.startedAtMs = this.ports.now();
    this.write("run", this.mode === "real"
      ? "REAL HARDWARE commissioning run started."
      : "Dry run started. No valve command will be sent.", {
      mode: this.mode,
      pots: this.pots,
      config: this.config,
    });
    if (this.mode === "real") this.write("operator", "Operator typed the hardware confirmation.", { confirmation: input.confirmation });

    let outcome: RunOutcome = "failed";
    let stopReason: string | null = null;
    try {
      await this.collectBaselines();
      await this.discover();
      outcome = this.mode === "dry_run" ? "dry_run_completed" : "completed";
    } catch (error) {
      if (error instanceof StopRun) {
        outcome = error.outcome;
        stopReason = error.message;
      } else {
        outcome = this.abortReason ? "aborted" : "failed";
        stopReason = this.abortReason ?? (error instanceof Error ? error.message : String(error));
        if (!this.abortReason) this.write("error", `Unexpected error: ${stopReason}`);
      }
    }

    this.phase = "analysis";
    this.activeValveKey = null;
    const { proposals, unresolved } = proposeTopology(this.pots, this.evidence, this.config);
    // Only a run that pulsed every selected valve yields a mapping. A partial
    // matrix cannot rule out rival valves, so a dry run, an aborted run, or a run
    // stopped by an interlock keeps its evidence but proposes nothing.
    const keepProposals = outcome === "completed";
    if (outcome === "completed" && (unresolved.length || proposals.some((item) => item.status === "needs_review"))) {
      outcome = "completed_with_findings";
    }
    this.write("decision", keepProposals
      ? `Proposed ${proposals.length} mapping(s); ${unresolved.length} valve(s) unresolved. Active pairings are unchanged.`
      : "No mapping is proposed for this run. Active pairings are unchanged.", {
      proposals: keepProposals ? proposals : [],
      unresolved,
    });
    this.write("run", `Run ended: ${outcome}.`, { stopReason, pulsesRequested: this.pulsesRequested, valveSecondsRequested: this.valveSecondsRequested });

    this.phase = "done";
    this.result = {
      runId: this.runId,
      mode: this.mode,
      outcome,
      stopReason,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt: new Date(this.ports.now()).toISOString(),
      pots: this.pots,
      baselines: this.baselines,
      evidence: this.evidence,
      proposals: keepProposals ? proposals : [],
      unresolved,
      pulsesRequested: this.pulsesRequested,
      valveSecondsRequested: this.valveSecondsRequested,
      log: this.log,
    };
    this.onUpdate();
    return this.result;
  }

  private write(kind: LogKind, message: string, data?: Record<string, unknown>) {
    this.log.push({ seq: this.log.length + 1, at: new Date(this.ports.now()).toISOString(), kind, message, data });
  }

  private ensureNotAborted() {
    if (this.abortReason) throw new StopRun("aborted", this.abortReason);
  }

  private async pause(seconds: number) {
    this.ensureNotAborted();
    try {
      await this.ports.sleep(seconds * 1000, this.controller.signal);
    } catch {
      // An aborted sleep rejects; fall through to the abort check.
    }
    this.ensureNotAborted();
  }

  private async refreshReadings(sinceMs: number) {
    const incoming = await this.ports.readReadings(this.pots.map((pot) => pot.sensorKey), sinceMs);
    const seen = new Set(this.readings.map((reading) => `${reading.sensorKey}|${reading.atMs}`));
    incoming.forEach((reading) => {
      const key = `${reading.sensorKey}|${reading.atMs}`;
      if (!seen.has(key) && Number.isFinite(reading.vwc)) {
        seen.add(key);
        this.readings.push(reading);
      }
    });
  }

  private async collectBaselines() {
    this.phase = "baseline";
    this.onUpdate();
    const since = this.startedAtMs - this.config.baselineLookbackSeconds * 1000;
    const deadline = this.startedAtMs + this.config.baselineTimeoutSeconds * 1000;
    for (;;) {
      this.ensureNotAborted();
      await this.refreshReadings(since);
      this.baselines = this.pots.map((pot) => summarizeBaseline(pot.sensorKey, this.readings, this.config));
      this.onUpdate();
      const waiting = this.baselines.filter((item) => item.count < this.config.baselineReadings);
      if (waiting.length === 0 || this.ports.now() >= deadline || this.mode === "dry_run") break;
      await this.pause(this.config.pollSeconds);
    }

    this.baselines.forEach((item) => this.write("baseline", item.valid
      ? `Sensor ${item.sensorKey}: baseline ${item.medianVwc?.toFixed(1)}% VWC, noise ±${item.noiseSigma?.toFixed(2)}.`
      : `Sensor ${item.sensorKey}: not usable. ${item.reason}`, { ...item }));
    const unusable = this.baselines.filter((item) => !item.valid);
    if (unusable.length && this.mode === "real") {
      // Every selected sensor must be trustworthy, or a watered pot could go unseen.
      throw new StopRun("stopped_by_interlock", `Sensor check failed for ${unusable.map((item) => item.sensorKey).join(", ")}. No valve was commanded.`);
    }
  }

  // Re-evaluated immediately before every single pulse.
  private async interlock(nextPulseSeconds: number): Promise<string | null> {
    const now = this.ports.now();
    if (now - this.startedAtMs > this.config.maxRunSeconds * 1000) return "Run time limit reached.";
    if (this.pulsesRequested + 1 > this.config.maxPulses) return `Pulse budget of ${this.config.maxPulses} reached.`;
    if (this.valveSecondsRequested + nextPulseSeconds > this.config.maxTotalValveSeconds) {
      return `Water budget of ${this.config.maxTotalValveSeconds} valve-seconds would be exceeded.`;
    }

    let status;
    try {
      status = await this.ports.readControllerStatus();
    } catch (error) {
      return `Lost contact with the portal database while checking the controller (${error instanceof Error ? error.message : String(error)}).`;
    }
    if (status.freshUntilMs == null || status.freshUntilMs <= now) return "The controller status is stale. The controller may be offline.";
    const state = (status.controllerState ?? "").trim().toUpperCase();
    if (!this.config.safeControllerStates.includes(state)) {
      return `The controller is ${state || "in an unknown state"}, not in a safe commissioning state (${this.config.safeControllerStates.join(" or ")}).`;
    }

    let active;
    try {
      active = await this.ports.countActiveWateringCommands();
    } catch (error) {
      return `Could not confirm the watering queue is empty (${error instanceof Error ? error.message : String(error)}).`;
    }
    if (active > 0) return `${active} other watering command(s) are queued or running.`;

    let automatic;
    try {
      automatic = await this.ports.readAutoWateringPairings(this.pots.map((pot) => pot.pairingName));
    } catch (error) {
      return `Could not confirm automatic watering is disabled (${error instanceof Error ? error.message : String(error)}).`;
    }
    if (automatic.length) return `Automatic watering is still enabled on ${automatic.join(", ")}. The controller could water these pots on its own during the run.`;

    const silent = this.baselines
      .filter((item) => item.valid)
      .filter((item) => {
        const last = Math.max(0, ...this.readings.filter((reading) => reading.sensorKey === item.sensorKey).map((reading) => reading.atMs));
        return now - last > this.config.sensorSilenceSeconds * 1000;
      });
    if (silent.length) return `Sensor(s) stopped reporting: ${silent.map((item) => item.sensorKey).join(", ")}.`;
    return null;
  }

  private async discover() {
    this.phase = "discovery";
    for (const pot of this.pots) {
      const first = await this.pulseAndObserve(pot, this.config.pulseSeconds, false);
      if (first.responses.some((response) => response.detected)) continue;
      // One bounded escalation, then flag and move on. Never an open-ended retry.
      this.write("decision", `Valve ${pot.valveKey}: no selected sensor rose after ${this.config.pulseSeconds}s. Escalating once to ${this.config.escalatedPulseSeconds}s.`);
      const second = await this.pulseAndObserve(pot, this.config.escalatedPulseSeconds, true);
      if (!second.responses.some((response) => response.detected)) {
        this.write("decision", `Valve ${pot.valveKey}: still no response after the escalated pulse. Flagged as unresolved; it will not be pulsed again.`);
      }
    }
    this.activeValveKey = null;
  }

  private async pulseAndObserve(pot: SelectedPot, seconds: number, escalated: boolean): Promise<PulseEvidence> {
    const step = `${pot.valveKey}${escalated ? ":escalated" : ""}`;
    this.ensureNotAborted();

    if (this.mode === "real") {
      // Respect the server's manual-water cooldown instead of tripping it.
      const wait = this.lastPulseEndMs + this.config.cooldownSeconds * 1000 - this.ports.now();
      if (wait > 0) await this.pause(wait / 1000);
    }
    await this.refreshReadings(this.startedAtMs - this.config.baselineLookbackSeconds * 1000);
    if (this.mode === "real") await this.waitUntilQuiet(pot);

    const blocked = await this.interlock(seconds);
    if (blocked) {
      this.write("interlock", `Interlock before valve ${pot.valveKey}: ${blocked}`, { step });
      throw new StopRun("stopped_by_interlock", blocked);
    }
    this.ensureNotAborted();
    if (this.commandInFlight) throw new StopRun("failed", "Internal guard: a valve command is already in flight.");

    this.activeValveKey = pot.valveKey;
    const requestedAtMs = this.ports.now();
    const evidence: PulseEvidence = {
      valveKey: pot.valveKey,
      pairingName: pot.pairingName,
      step,
      escalated,
      requestedSeconds: seconds,
      requestedAt: new Date(requestedAtMs).toISOString(),
      commandId: null,
      operationId: null,
      acknowledgement: { status: "not_sent", at: null, error: null, controllerResult: null },
      responses: [],
      observedSeconds: 0,
      physicalDeliveryVerified: false,
    };
    this.evidence.push(evidence);
    this.onUpdate();

    if (this.mode === "dry_run") {
      this.write("command_request", `DRY RUN: would request a ${seconds}s pulse on valve ${pot.valveKey} (pairing ${pot.pairingName}). Nothing was sent.`, { step, seconds });
    } else {
      this.commandInFlight = true;
      this.pulsesRequested += 1;
      this.valveSecondsRequested += seconds;
      this.write("command_request", `Requested a ${seconds}s pulse on valve ${pot.valveKey} (pairing ${pot.pairingName}) through the control-command queue.`, { step, seconds });
      try {
        const ticket = await this.ports.requestPulse({ pairingName: pot.pairingName, seconds, runId: this.runId, step });
        evidence.commandId = ticket.commandId;
        evidence.operationId = ticket.operationId;
        const final = await this.awaitCommand(ticket.commandId);
        evidence.acknowledgement = {
          status: final.status,
          at: new Date(this.ports.now()).toISOString(),
          error: final.error,
          controllerResult: final.result,
        };
      } catch (error) {
        const message = error instanceof StopRun ? error.message : error instanceof Error ? error.message : String(error);
        evidence.acknowledgement = { status: "failed", at: new Date(this.ports.now()).toISOString(), error: message, controllerResult: null };
        this.write("error", `Valve ${pot.valveKey}: the pulse command did not complete. ${message}`, { step, commandId: evidence.commandId });
        // Fail closed: an unconfirmed command is never retried and ends the run.
        throw new StopRun(this.abortReason ? "aborted" : "stopped_by_interlock", this.abortReason ?? `Command failure on valve ${pot.valveKey}: ${message}`);
      } finally {
        this.commandInFlight = false;
        this.lastPulseEndMs = this.ports.now();
      }

      if (evidence.acknowledgement.status !== "succeeded") {
        const detail = evidence.acknowledgement.error ?? evidence.acknowledgement.status;
        this.write("command_ack", `Valve ${pot.valveKey}: the controller reported ${evidence.acknowledgement.status}. ${detail}`, { step, commandId: evidence.commandId });
        throw new StopRun("stopped_by_interlock", `Command failure on valve ${pot.valveKey}: ${detail}`);
      }
      this.write("command_ack", `Valve ${pot.valveKey}: the controller acknowledged the pulse. This confirms the command, not that water reached a pot.`, {
        step,
        commandId: evidence.commandId,
        controllerResult: evidence.acknowledgement.controllerResult,
      });
    }

    await this.observe(pot, evidence, requestedAtMs);
    return evidence;
  }

  // A pot that is still rising from the previous pulse would be misread as a
  // response to this valve. Wait (bounded) until every sensor has levelled off.
  private unsettledSensors() {
    return this.baselines.filter((item) => item.valid).filter((item) => {
      const recent = this.readings
        .filter((reading) => reading.sensorKey === item.sensorKey)
        .sort((a, b) => a.atMs - b.atMs)
        .slice(-3)
        .map((reading) => reading.vwc);
      if (recent.length < 3) return false;
      const sigma = item.noiseSigma ?? 0;
      // A pot that just responded is the one most likely to still be creeping up,
      // so it must be flatter than the rest before the next valve is pulsed.
      const allowed = this.recentResponders.has(item.sensorKey)
        ? Math.max(0.6 * this.config.quietRangeVwc, 2.5 * sigma)
        : Math.max(this.config.quietRangeVwc, 4 * sigma);
      return Math.max(...recent) - Math.min(...recent) > allowed;
    });
  }

  private async waitUntilQuiet(pot: SelectedPot) {
    const deadline = this.ports.now() + this.config.maxSettleSeconds * 1000;
    let announced = false;
    for (;;) {
      const moving = this.unsettledSensors();
      if (moving.length === 0) return;
      if (!announced) {
        announced = true;
        this.write("decision", `Waiting for ${moving.map((item) => item.sensorKey).join(", ")} to level off before pulsing valve ${pot.valveKey}.`);
        this.onUpdate();
      }
      if (this.ports.now() >= deadline) {
        const reason = `Sensor(s) ${moving.map((item) => item.sensorKey).join(", ")} were still changing after ${Math.round(this.config.maxSettleSeconds / 60)} min. Pulsing now would give unreliable evidence.`;
        this.write("interlock", `Settle timeout before valve ${pot.valveKey}: ${reason}`);
        throw new StopRun("stopped_by_interlock", reason);
      }
      await this.pause(this.config.pollSeconds);
      await this.refreshReadings(this.startedAtMs - this.config.baselineLookbackSeconds * 1000);
    }
  }

  private async awaitCommand(commandId: string): Promise<CommandSnapshot> {
    const deadline = this.ports.now() + this.config.commandTimeoutSeconds * 1000;
    for (;;) {
      const snapshot = await this.ports.readCommand(commandId);
      if (snapshot && terminalStates.has(snapshot.status)) return snapshot;
      if (this.ports.now() >= deadline) {
        throw new StopRun("stopped_by_interlock", `No final status within ${this.config.commandTimeoutSeconds}s. The outcome is unknown; verify the valve is closed before doing anything else.`);
      }
      // Deliberately not abortable: once a pulse is queued we keep watching it so
      // the log records how it ended, even if the operator has pressed Stop.
      await this.ports.sleep(Math.min(5, this.config.pollSeconds) * 1000, new AbortController().signal);
    }
  }

  private async observe(pot: SelectedPot, evidence: PulseEvidence, requestedAtMs: number) {
    const pulseEndMs = this.mode === "real" ? this.ports.now() : requestedAtMs;
    const window = this.mode === "real" ? this.config.maxObserveSeconds : this.config.dryRunObserveSeconds;
    const deadline = pulseEndMs + window * 1000;
    const sigma = new Map(this.baselines.map((item) => [item.sensorKey, item.noiseSigma ?? 0]));
    const measure = () => this.pots
      .filter((candidate) => this.baselines.find((item) => item.sensorKey === candidate.sensorKey)?.valid)
      .map((candidate) => measureResponse({
        sensorKey: candidate.sensorKey,
        readings: this.readings,
        requestedAtMs,
        pulseEndMs,
        noiseSigma: sigma.get(candidate.sensorKey) ?? 0,
        config: this.config,
      }))
      .filter((response): response is NonNullable<typeof response> => response != null);

    for (;;) {
      await this.refreshReadings(requestedAtMs - this.config.baselineLookbackSeconds * 1000);
      evidence.responses = measure();
      evidence.observedSeconds = Math.round((this.ports.now() - pulseEndMs) / 1000);
      this.onUpdate();
      const expected = this.baselines.filter((item) => item.valid).length;
      const complete = evidence.responses.length === expected
        && evidence.responses.every((response) => response.postCount >= this.config.minPostReadings);
      if (complete || this.ports.now() >= deadline) break;
      await this.pause(this.config.pollSeconds);
    }

    const responders = evidence.responses.filter((response) => response.detected);
    this.recentResponders = new Set(responders.map((response) => response.sensorKey));
    this.write("observation", responders.length
      ? `Valve ${pot.valveKey}: measured a rise on ${responders.map((response) => `${response.sensorKey} (+${response.deltaVwc.toFixed(1)}%)`).join(", ")} over ${evidence.observedSeconds}s.`
      : `Valve ${pot.valveKey}: no selected sensor rose within ${evidence.observedSeconds}s.`, {
      step: evidence.step,
      responses: evidence.responses,
    });
  }
}
