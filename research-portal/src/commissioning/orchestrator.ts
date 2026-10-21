import { findUnclaimedSensors, measureResponse, proposeTopology, summarizeBaseline } from "./analysis";
import { ReadingStore } from "./readingStore";
import type {
  CommandSnapshot,
  CommissioningConfig,
  CommissioningMode,
  CommissioningPorts,
  CommissioningResult,
  LogEntry,
  LogKind,
  ManualIntervention,
  PulseEvidence,
  RunInterruption,
  RunOutcome,
  SelectedPot,
  SensorBaseline,
} from "./types";

// REAL HARDWARE commissioning orchestrator.
//
// Safety properties this module is responsible for (each has a test):
//  - Exactly one valve is commanded at a time, and only through ports.requestPulse.
//  - A dry run never calls ports.requestPulse.
//  - A real run cannot start without the exact confirmation phrase.
//  - Interlocks are re-checked immediately before every pulse, and any command
//    failure, stale controller, conflict, silent sensor, manual watering, or
//    exhausted budget stops the run. It never retries a failed command.
//  - A silent valve is escalated at most once, inside the configured limits.
//  - The run only ever produces a proposal. It has no way to change pairings.
//  - Nothing is scheduled ahead of time: if this page closes, no further pulse
//    is ever requested. A later session can resume from the recorded evidence;
//    it collects fresh baselines first and never reuses contaminated evidence.
//
// Full scale: every pulse observes every selected sensor, so the response matrix
// covers the whole selection (a swap across zones is found like any other). The
// valve-time budget defaults to the selection's worst case, n x (pulse + retry).

export const hardLimits = {
  minPots: 2,
  maxPots: 200,
  maxPulseSeconds: 10,
  maxEscalatedPulseSeconds: 15,
  /** Per selected valve: one pulse and one retry at the longest allowed lengths. */
  maxValveSecondsPerPot: 25,
  maxPulsesPerPot: 2,
  /** A browser-owned run never runs longer than this, whatever its size. */
  maxRunSeconds: 48 * 3600,
  /** Run-time allowance per selected valve (settling, observation, one retry). */
  runSecondsPerPot: 15 * 60,
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
  readingRetentionSeconds: 2 * 3600,
  manualSettleSeconds: 30 * 60,
};

/** Budgets sized to the selection: every valve can get its pulse and one retry. */
export function configForSelection(potCount: number, overrides: Partial<CommissioningConfig> = {}): CommissioningConfig {
  const base = { ...defaultCommissioningConfig, ...overrides };
  const count = Math.max(1, potCount);
  return {
    ...base,
    maxTotalValveSeconds: overrides.maxTotalValveSeconds ?? count * (base.pulseSeconds + base.escalatedPulseSeconds),
    maxPulses: overrides.maxPulses ?? count * hardLimits.maxPulsesPerPot,
    maxRunSeconds: overrides.maxRunSeconds ?? Math.min(hardLimits.maxRunSeconds, Math.max(2 * 3600, count * hardLimits.runSecondsPerPot)),
  };
}

export function requiredConfirmation(pots: readonly SelectedPot[]) {
  return `OPEN ${pots.length} REAL VALVES`;
}

export const singlePotLimitation =
  "One pot cannot reveal a crossed pairing: only its own sensor would be watched, so a hose that waters a different pot would go unseen. Select at least two pots; a whole zone or the whole installation is better.";

export function validateSelection(pots: readonly SelectedPot[]) {
  const problems: string[] = [];
  if (pots.length === 1) problems.push(singlePotLimitation);
  else if (pots.length < hardLimits.minPots) problems.push(`Select at least ${hardLimits.minPots} pots.`);
  else if (pots.length > hardLimits.maxPots) problems.push(`At most ${hardLimits.maxPots} pots can be checked in one run (selected ${pots.length}).`);
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

export function validateConfig(config: CommissioningConfig, potCount = 1) {
  const problems: string[] = [];
  const within = (value: number, min: number, max: number, label: string) => {
    if (!Number.isFinite(value) || value < min || value > max) problems.push(`${label} must be between ${min} and ${max}.`);
  };
  const count = Math.max(1, potCount);
  within(config.pulseSeconds, 1, hardLimits.maxPulseSeconds, "Diagnostic pulse (sec)");
  within(config.escalatedPulseSeconds, config.pulseSeconds, hardLimits.maxEscalatedPulseSeconds, "Escalated pulse (sec)");
  // Budgets scale with the selection; small selections keep the long-standing 300 s / 40 pulse ceilings.
  within(config.maxTotalValveSeconds, config.pulseSeconds, Math.max(300, count * hardLimits.maxValveSecondsPerPot), "Water budget (valve-seconds)");
  within(config.maxPulses, 1, Math.max(40, count * hardLimits.maxPulsesPerPot), "Pulse budget");
  within(config.maxRunSeconds, 60, hardLimits.maxRunSeconds, "Run time limit (sec)");
  return problems;
}

export type RunPhase = "idle" | "baseline" | "discovery" | "analysis" | "done";

export type RunProgress = {
  phase: RunPhase;
  activeValveKey: string | null;
  activePairingName: string | null;
  activeStep: "settling" | "pulsing" | "observing" | "cooldown" | null;
  total: number;
  completed: number;
  remaining: number;
  pulsesRequested: number;
  valveSecondsRequested: number;
  maxPulses: number;
  maxTotalValveSeconds: number;
  elapsedSeconds: number;
  maxRunSeconds: number;
  usableBaselines: number;
  segment: number;
};

class StopRun extends Error {
  constructor(readonly outcome: RunOutcome, message: string, readonly interruption: RunInterruption | null = null) {
    super(message);
  }
}

const terminalStates = new Set(["succeeded", "failed", "canceled", "expired"]);

const manualRefusal = /manual troubleshooting|manual watering just ended|preempted_by_manual_hold/i;

const incompleteObservation = "The run stopped before this pulse's observation finished; the valve is measured again on resume.";

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
  activeStep: RunProgress["activeStep"] = null;
  pulsesRequested = 0;
  valveSecondsRequested = 0;
  result: CommissioningResult | null = null;
  readonly segment: number;

  private readonly ports: CommissioningPorts;
  private readonly onUpdate: () => void;
  private readonly controller = new AbortController();
  private abortReason: string | null = null;
  private interruption: RunInterruption | null = null;
  private readonly readings = new ReadingStore();
  private startedAtMs = 0;
  private lastPulseEndMs = 0;
  private commandInFlight = false;
  private readonly completed = new Set<string>();
  // Baselines use only readings after this time (later than the lookback when manual
  // watering ended recently, so its rise and settling never enter a baseline).
  private baselineFloorMs = 0
  private readonly priorEvidence: PulseEvidence[];
  private readonly priorLog: LogEntry[];
  private readonly priorPulses: number;
  private readonly priorValveSeconds: number;
  // Sensors that rose on the previous pulse are held to a stricter settle test.
  private recentResponders = new Set<string>();
  // The acknowledged pulse whose observation is still in progress, if any.
  private observing: PulseEvidence | null = null;

  constructor(input: {
    runId: string;
    mode: CommissioningMode;
    pots: readonly SelectedPot[];
    ports: CommissioningPorts;
    config?: Partial<CommissioningConfig>;
    onUpdate?: () => void;
    /** A previous segment of the same run, to continue after an interruption. */
    resumeFrom?: CommissioningResult | null;
  }) {
    this.runId = input.runId;
    this.mode = input.mode;
    this.pots = input.pots.map((pot) => ({ ...pot }));
    this.ports = input.ports;
    this.config = { ...configForSelection(this.pots.length), ...input.config };
    this.onUpdate = input.onUpdate ?? (() => undefined);
    const prior = input.resumeFrom ?? null;
    this.segment = prior ? prior.segments + 1 : 1;
    this.priorEvidence = prior ? prior.evidence.map((item) => ({ ...item })) : [];
    this.priorLog = prior ? prior.log.slice() : [];
    this.priorPulses = prior?.pulsesRequested ?? 0;
    this.priorValveSeconds = prior?.valveSecondsRequested ?? 0;
    this.pulsesRequested = this.priorPulses;
    this.valveSecondsRequested = this.priorValveSeconds;
    for (const valve of prior?.completedValves ?? []) {
      if (this.pots.some((pot) => pot.valveKey === valve)) this.completed.add(valve);
    }
    // The server's manual-water cooldown runs from the previous segment's last pulse.
    for (const item of this.priorEvidence) {
      const at = Date.parse(item.acknowledgement.at ?? item.requestedAt);
      if (Number.isFinite(at)) this.lastPulseEndMs = Math.max(this.lastPulseEndMs, at);
    }
    this.log.push(...this.priorLog);
  }

  get running() {
    return this.phase !== "idle" && this.phase !== "done";
  }

  progress(): RunProgress {
    const active = this.activeValveKey ? this.pots.find((pot) => pot.valveKey === this.activeValveKey) ?? null : null;
    return {
      phase: this.phase,
      activeValveKey: this.activeValveKey,
      activePairingName: active?.pairingName ?? null,
      activeStep: this.activeStep,
      total: this.pots.length,
      completed: this.completed.size,
      remaining: this.pots.length - this.completed.size,
      pulsesRequested: this.pulsesRequested,
      valveSecondsRequested: this.valveSecondsRequested,
      maxPulses: this.config.maxPulses,
      maxTotalValveSeconds: this.config.maxTotalValveSeconds,
      elapsedSeconds: this.startedAtMs ? Math.round((this.ports.now() - this.startedAtMs) / 1000) : 0,
      maxRunSeconds: this.config.maxRunSeconds,
      usableBaselines: this.baselines.filter((item) => item.valid).length,
      segment: this.segment,
    };
  }

  /** Valves whose evidence is complete and usable so far. */
  completedValves(): string[] {
    return Array.from(this.completed);
  }

  /** Every pulse's evidence so far, earlier segments included (read-only view). */
  evidenceSoFar(): readonly PulseEvidence[] {
    return this.allEvidence();
  }

  /**
   * A resumable record of the run so far, saved while it runs so the evidence survives
   * if this screen closes. It reads as an interrupted run: it proposes nothing, and a
   * pulse still being observed is marked incomplete so a resume measures it again.
   */
  checkpoint(): CommissioningResult {
    const at = new Date(this.ports.now()).toISOString();
    const evidence = this.allEvidence().map((item) => {
      const copy: PulseEvidence = JSON.parse(JSON.stringify(item));
      if (item === this.observing && !copy.invalidated) copy.invalidated = { reason: incompleteObservation, at };
      return copy;
    });
    const reason = `Saved while the run was in progress (${this.completed.size} of ${this.pots.length} valves complete). If this record is all that remains, the screen running it closed and no pulse was requested after ${at}.`;
    return {
      runId: this.runId,
      mode: this.mode,
      outcome: "interrupted",
      stopReason: reason,
      startedAt: new Date(this.startedAtMs || this.ports.now()).toISOString(),
      endedAt: at,
      pots: this.pots,
      baselines: this.baselines,
      evidence,
      proposals: [],
      unresolved: [],
      unclaimed: [],
      pulsesRequested: this.pulsesRequested,
      valveSecondsRequested: this.valveSecondsRequested,
      log: this.log.slice(),
      completedValves: Array.from(this.completed),
      segments: this.segment,
      interruption: { at, reason, source: "screen_closed" },
    };
  }

  // Stops the run. No further pulse is requested after this returns. A pulse the
  // controller has already accepted still ends on the controller's own deadline.
  abort(reason = "Stopped by the operator.", source: RunInterruption["source"] = "operator") {
    if (this.abortReason || this.phase === "done") return;
    this.abortReason = reason;
    this.interruption = { at: new Date(this.ports.now()).toISOString(), reason, source };
    this.write(source === "manual_watering" ? "interruption" : "abort", reason, { commandInFlight: this.commandInFlight, source });
    this.controller.abort();
    this.onUpdate();
  }

  /** Manual watering began on this controller (seen locally or in the hold records). */
  interruptForManualWatering(label: string) {
    this.abort(`Manual watering (${label}) interrupted autocalibration. Evidence gathered so far is kept; readings after this point are not used. Resume collects fresh baselines.`, "manual_watering");
  }

  async run(input: { confirmation?: string } = {}): Promise<CommissioningResult> {
    if (this.phase !== "idle") throw new Error("This commissioning run has already been started.");
    const selectionProblems = [...validateSelection(this.pots), ...validateConfig(this.config, this.pots.length)];
    if (selectionProblems.length) throw new Error(selectionProblems.join(" "));
    if (this.mode === "real" && input.confirmation !== requiredConfirmation(this.pots)) {
      throw new Error("The typed confirmation does not match. No valve was commanded.");
    }

    this.startedAtMs = this.ports.now();
    this.write("run", this.segment > 1
      ? `Resumed: segment ${this.segment}. ${this.completed.size} of ${this.pots.length} valves already have usable evidence.`
      : this.mode === "real"
        ? "REAL HARDWARE commissioning run started."
        : "Dry run started. No valve command will be sent.", {
      mode: this.mode,
      pots: this.pots,
      config: this.config,
      segment: this.segment,
    });
    if (this.mode === "real") this.write("operator", "Operator confirmed the hardware run.", { confirmation: input.confirmation });

    let outcome: RunOutcome = "failed";
    let stopReason: string | null = null;
    try {
      await this.establishBaselineFloor();
      await this.collectBaselines();
      await this.discover();
      outcome = this.mode === "dry_run" ? "dry_run_completed" : "completed";
    } catch (error) {
      if (error instanceof StopRun) {
        outcome = error.outcome;
        stopReason = error.message;
        if (error.interruption) this.interruption = error.interruption;
      } else {
        outcome = this.abortReason ? "aborted" : "failed";
        stopReason = this.abortReason ?? (error instanceof Error ? error.message : String(error));
        if (!this.abortReason) this.write("error", `Unexpected error: ${stopReason}`);
      }
      if (this.interruption?.source === "manual_watering") outcome = "interrupted";
      else if (outcome === "aborted" && this.interruption) outcome = this.interruption.source === "operator" ? "aborted" : "interrupted";
    }
    // A stop during an observation leaves that pulse half-measured. It is not evidence
    // of "no response": it is set aside and the valve is measured again on resume.
    if (this.observing && !this.observing.invalidated) {
      this.observing.invalidated = { reason: incompleteObservation, at: new Date(this.ports.now()).toISOString() };
      this.completed.delete(this.observing.valveKey);
    }
    this.observing = null;

    this.phase = "analysis";
    this.activeValveKey = null;
    this.activeStep = null;
    const usable = this.allEvidence().filter((item) => !item.invalidated);
    const { proposals, unresolved } = proposeTopology(this.pots, usable, this.config);
    const unclaimed = findUnclaimedSensors(this.pots, usable);
    // Only a run that pulsed every selected valve yields a mapping. A partial
    // matrix cannot rule out rival valves, so a dry run, an interrupted run, or a
    // run stopped by an interlock keeps its evidence but proposes nothing.
    const keepProposals = outcome === "completed" && this.completed.size === this.pots.length;
    if (outcome === "completed" && !keepProposals) outcome = "stopped_by_interlock";
    if (outcome === "completed" && (unresolved.length || unclaimed.length || proposals.some((item) => item.status === "needs_review"))) {
      outcome = "completed_with_findings";
    }
    this.write("decision", keepProposals
      ? `Proposed ${proposals.length} mapping(s); ${unresolved.length} valve(s) unresolved; ${unclaimed.length} sensor(s) unclaimed. Active pairings are unchanged.`
      : `No mapping is proposed: ${this.completed.size} of ${this.pots.length} valves have usable evidence. Active pairings are unchanged.`, {
      proposals: keepProposals ? proposals : [],
      unresolved,
      unclaimed,
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
      evidence: this.allEvidence(),
      proposals: keepProposals ? proposals : [],
      unresolved,
      unclaimed: keepProposals ? unclaimed : [],
      pulsesRequested: this.pulsesRequested,
      valveSecondsRequested: this.valveSecondsRequested,
      log: this.log,
      completedValves: Array.from(this.completed),
      segments: this.segment,
      interruption: this.interruption,
    };
    this.onUpdate();
    return this.result;
  }

  private allEvidence() {
    return [...this.priorEvidence, ...this.evidence];
  }

  private write(kind: LogKind, message: string, data?: Record<string, unknown>) {
    this.log.push({ seq: this.log.length + 1, at: new Date(this.ports.now()).toISOString(), kind, message, data });
  }

  private ensureNotAborted() {
    if (this.abortReason) throw new StopRun(this.interruption?.source === "manual_watering" ? "interrupted" : "aborted", this.abortReason, this.interruption);
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
    this.readings.add(incoming);
    // Keep only what a decision can still use: bounded memory at any run length.
    this.readings.prune(this.ports.now() - this.config.readingRetentionSeconds * 1000);
  }

  private async manualSessions(sinceMs: number): Promise<ManualIntervention[]> {
    if (!this.ports.readManualInterventions) return [];
    try {
      return await this.ports.readManualInterventions(sinceMs);
    } catch (error) {
      throw new StopRun("stopped_by_interlock", `Could not confirm that no manual watering is in progress (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  /**
   * Before baselines: refuse to start while manual watering is in progress, and when it
   * ended recently, take baselines only from readings after the pots have settled.
   */
  private async establishBaselineFloor() {
    const lookbackStart = this.startedAtMs - this.config.baselineLookbackSeconds * 1000;
    this.baselineFloorMs = lookbackStart;
    const sessions = await this.manualSessions(lookbackStart - this.config.manualSettleSeconds * 1000);
    const open = sessions.find((session) => session.endedAtMs == null);
    if (open) {
      const reason = `Manual watering (${open.label}) is in progress. Autocalibration starts after it ends and the pots settle.`;
      this.write("interruption", reason, { session: open });
      throw new StopRun("interrupted", reason, { at: new Date(this.ports.now()).toISOString(), reason, source: "manual_watering" });
    }
    for (const session of sessions) {
      const settled = (session.endedAtMs ?? session.startedAtMs) + this.config.manualSettleSeconds * 1000;
      if (settled > this.baselineFloorMs) this.baselineFloorMs = settled;
    }
    if (this.baselineFloorMs > lookbackStart) {
      this.invalidateAfter(Math.min(...sessions.map((session) => session.startedAtMs)), "Manual watering happened after this observation began.");
      this.write("decision", `Manual watering ended recently; baselines use readings from ${new Date(this.baselineFloorMs).toISOString()} on, after the pots settle.`);
    }
  }

  /** During the run: manual watering invalidates overlapping evidence and stops the run. */
  private async checkManualInterventions() {
    const sessions = await this.manualSessions(this.startedAtMs);
    const started = sessions.filter((session) => session.startedAtMs >= this.startedAtMs || session.endedAtMs == null);
    if (!started.length) return;
    const first = started.sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
    this.invalidateAfter(first.startedAtMs, `Manual watering (${first.label}) overlapped this observation.`);
    const reason = `Manual watering (${first.label}) started during the run. Evidence gathered before it is kept; resume after the pots settle.`;
    const interruption: RunInterruption = { at: new Date(this.ports.now()).toISOString(), reason, source: "manual_watering" };
    this.write("interruption", reason, { session: first });
    throw new StopRun("interrupted", reason, interruption);
  }

  /** Evidence whose observation could include manual watering is excluded and re-measured on resume. */
  private invalidateAfter(fromMs: number, reason: string) {
    const at = new Date(this.ports.now()).toISOString();
    const affected = (item: PulseEvidence) => Date.parse(item.requestedAt) + (item.observedSeconds + this.config.settleSkipSeconds) * 1000 >= fromMs;
    for (const item of [...this.priorEvidence, ...this.evidence]) {
      if (!item.invalidated && affected(item)) {
        item.invalidated = { reason, at };
        this.completed.delete(item.valveKey);
      }
    }
  }

  private async collectBaselines() {
    this.phase = "baseline";
    this.onUpdate();
    const since = this.startedAtMs - this.config.baselineLookbackSeconds * 1000;
    const deadline = Math.max(this.startedAtMs, this.baselineFloorMs) + this.config.baselineTimeoutSeconds * 1000;
    for (;;) {
      this.ensureNotAborted();
      await this.refreshReadings(since);
      this.baselines = this.pots.map((pot) => summarizeBaseline(
        pot.sensorKey,
        this.readings.forSensor(pot.sensorKey).filter((reading) => reading.atMs >= this.baselineFloorMs),
        this.config,
      ));
      this.onUpdate();
      const waiting = this.baselines.filter((item) => item.count < this.config.baselineReadings);
      if (waiting.length === 0 || this.ports.now() >= deadline || this.mode === "dry_run") break;
      await this.pause(this.config.pollSeconds);
      await this.checkManualInterventions();
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
    if (now - this.startedAtMs > this.config.maxRunSeconds * 1000) return `Run time limit of ${Math.round(this.config.maxRunSeconds / 3600)} h reached.`;
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
      .filter((item) => now - (this.readings.latestAt(item.sensorKey) ?? 0) > this.config.sensorSilenceSeconds * 1000);
    if (silent.length) return `Sensor(s) stopped reporting: ${silent.map((item) => item.sensorKey).join(", ")}.`;
    return null;
  }

  private async discover() {
    this.phase = "discovery";
    for (const pot of this.pots) {
      if (this.completed.has(pot.valveKey)) continue;
      // A resumed valve whose usable first pulse moved nothing goes straight to its one retry.
      const earlier = this.priorEvidence.filter((item) => item.valveKey === pot.valveKey && !item.invalidated && item.acknowledgement.status === "succeeded");
      const silentFirst = earlier.some((item) => !item.escalated && !item.responses.some((response) => response.detected));
      if (!silentFirst) {
        const first = await this.pulseAndObserve(pot, this.config.pulseSeconds, false);
        if (first.responses.some((response) => response.detected)) {
          this.completed.add(pot.valveKey);
          continue;
        }
      }
      // One bounded escalation, then flag and move on. Never an open-ended retry.
      this.write("decision", `Valve ${pot.valveKey}: no selected sensor rose after ${this.config.pulseSeconds}s. Escalating once to ${this.config.escalatedPulseSeconds}s.`);
      const second = await this.pulseAndObserve(pot, this.config.escalatedPulseSeconds, true);
      if (!second.responses.some((response) => response.detected)) {
        this.write("decision", `Valve ${pot.valveKey}: still no response after the escalated pulse. Flagged as unresolved; it will not be pulsed again.`);
      }
      this.completed.add(pot.valveKey);
    }
    this.activeValveKey = null;
    this.activeStep = null;
  }

  private async pulseAndObserve(pot: SelectedPot, seconds: number, escalated: boolean): Promise<PulseEvidence> {
    const step = `${pot.valveKey}${escalated ? ":escalated" : ""}${this.segment > 1 ? `:s${this.segment}` : ""}`;
    this.ensureNotAborted();
    this.activeValveKey = pot.valveKey;

    if (this.mode === "real") {
      // Respect the server's manual-water cooldown instead of tripping it.
      const wait = this.lastPulseEndMs + this.config.cooldownSeconds * 1000 - this.ports.now();
      if (wait > 0) {
        this.activeStep = "cooldown";
        this.onUpdate();
        await this.pause(wait / 1000);
      }
    }
    await this.refreshReadings(this.startedAtMs - this.config.baselineLookbackSeconds * 1000);
    if (this.mode === "real") {
      this.activeStep = "settling";
      await this.waitUntilQuiet(pot);
    }

    await this.checkManualInterventions();
    const blocked = await this.interlock(seconds);
    if (blocked) {
      this.write("interlock", `Interlock before valve ${pot.valveKey}: ${blocked}`, { step });
      throw new StopRun("stopped_by_interlock", blocked);
    }
    this.ensureNotAborted();
    if (this.commandInFlight) throw new StopRun("failed", "Internal guard: a valve command is already in flight.");

    this.activeStep = "pulsing";
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
      segment: this.segment,
      invalidated: null,
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
        if (manualRefusal.test(message)) this.raiseManualStop(evidence, message);
        throw new StopRun(this.abortReason ? "aborted" : "stopped_by_interlock", this.abortReason ?? `Command failure on valve ${pot.valveKey}: ${message}`, this.interruption);
      } finally {
        this.commandInFlight = false;
        this.lastPulseEndMs = this.ports.now();
      }

      if (evidence.acknowledgement.status !== "succeeded") {
        const detail = evidence.acknowledgement.error ?? evidence.acknowledgement.status;
        this.write("command_ack", `Valve ${pot.valveKey}: the controller reported ${evidence.acknowledgement.status}. ${detail}`, { step, commandId: evidence.commandId });
        if (manualRefusal.test(detail)) this.raiseManualStop(evidence, detail);
        throw new StopRun("stopped_by_interlock", `Command failure on valve ${pot.valveKey}: ${detail}`);
      }
      const interrupted = evidence.acknowledgement.controllerResult?.interrupted;
      if (typeof interrupted === "string" && interrupted) {
        // The controller cut this pulse short (an operator took manual control).
        this.raiseManualStop(evidence, `The controller ended this pulse early (${interrupted}).`);
      }
      this.write("command_ack", `Valve ${pot.valveKey}: the controller acknowledged the pulse. This confirms the command, not that water reached a pot.`, {
        step,
        commandId: evidence.commandId,
        controllerResult: evidence.acknowledgement.controllerResult,
      });
    }

    this.activeStep = "observing";
    this.observing = evidence;
    await this.observe(pot, evidence, requestedAtMs);
    this.observing = null;
    return evidence;
  }

  private raiseManualStop(evidence: PulseEvidence, detail: string): never {
    const reason = `Manual troubleshooting took control of the controller: ${detail} Evidence gathered so far is kept; resume after the pots settle.`;
    evidence.invalidated = { reason: "Manual watering overlapped this pulse.", at: new Date(this.ports.now()).toISOString() };
    this.interruption = { at: new Date(this.ports.now()).toISOString(), reason, source: "manual_watering" };
    this.write("interruption", reason, { step: evidence.step });
    throw new StopRun("interrupted", reason, this.interruption);
  }

  // A pot that is still rising from the previous pulse would be misread as a
  // response to this valve. Wait (bounded) until every sensor has levelled off.
  //
  // Pots that responded to the previous pulse are the ones most likely to still be
  // creeping up, so they must be flatter than the rest (range of the last three
  // readings). Every other pot blocks only on a sustained rise: three readings that
  // keep increasing by more than the quiet range. Testing every pot's noisy range
  // instead (the original rule) cannot pass at full scale: with 100 sensors, some
  // sensor's last three readings spread past four sigma by noise alone on almost
  // every poll, so a 100-pot run timed out without anything rising.
  private unsettledSensors() {
    return this.baselines.filter((item) => item.valid).filter((item) => {
      const recent = this.readings.forSensor(item.sensorKey).slice(-3).map((reading) => reading.vwc);
      if (recent.length < 3) return false;
      const sigma = item.noiseSigma ?? 0;
      if (this.recentResponders.has(item.sensorKey)) {
        const allowed = Math.max(0.6 * this.config.quietRangeVwc, 2.5 * sigma);
        return Math.max(...recent) - Math.min(...recent) > allowed;
      }
      const rising = recent[0] < recent[1] && recent[1] < recent[2];
      return rising && recent[2] - recent[0] > Math.max(this.config.quietRangeVwc, 4 * sigma);
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
    const validSensors = this.pots.filter((candidate) => this.baselines.find((item) => item.sensorKey === candidate.sensorKey)?.valid);
    const measure = () => validSensors
      .map((candidate) => measureResponse({
        sensorKey: candidate.sensorKey,
        readings: this.readings.forSensor(candidate.sensorKey),
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
      // Complete once every sensor has its settled readings and none is still mid-rise.
      // A strong rise whose last readings have not levelled off yet is not judged
      // from the rising part: observation continues (within the window) until it
      // plateaus, so a slower-wetting pot is not misread as "no response".
      const stillRising = evidence.responses.some((response) => !response.detected
        && response.postCount >= this.config.minPostReadings
        && response.deltaVwc >= this.config.minDeltaVwc
        && response.z >= this.config.minZ);
      const complete = evidence.responses.length === validSensors.length
        && evidence.responses.every((response) => response.postCount >= this.config.minPostReadings)
        && !stillRising;
      if (complete || this.ports.now() >= deadline) break;
      await this.pause(this.config.pollSeconds);
      await this.checkManualInterventions();
    }

    const responders = evidence.responses.filter((response) => response.detected);
    this.recentResponders = new Set(responders.map((response) => response.sensorKey));
    this.write("observation", responders.length
      ? `Valve ${pot.valveKey}: measured a rise on ${responders.map((response) => `${response.sensorKey} (+${response.deltaVwc.toFixed(1)}%)`).join(", ")} over ${evidence.observedSeconds}s.`
      : `Valve ${pot.valveKey}: no selected sensor rose within ${evidence.observedSeconds}s.`, {
      step: evidence.step,
      responses: evidence.responses.filter((response) => response.detected || response.deltaVwc >= this.config.minDeltaVwc * 0.5),
    });
  }
}
