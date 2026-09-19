import { assignOneToOne } from "./assignment";
import { SimulatedBench, type SimWorld } from "./simulator";

// SIMULATION ONLY. The engine's single source of readings and its single
// actuator is the in-memory SimulatedBench. It has no controller, database, or
// network access, and it produces a *proposed* topology, never an applied one.

export const algorithmVersion = "autocal-sim-1.0.0";
export const configVersion = "2026-09-defaults-1";

export type AutocalConfig = {
  sampleIntervalSeconds: number;
  baselineSamples: number;
  pulseSeconds: number;
  escalatedPulseSeconds: number;
  observeSeconds: number;
  preSamples: number;
  postSamples: number;
  minDeltaVwc: number;
  minZ: number;
  rivalZ: number;
  maxNoiseSigma: number;
  saturationVwc: number;
  overshootLimitVwc: number;
  ambiguousRatio: number;
  flowTolerance: number;
  convergenceTolerance: number;
  reviewConfidence: number;
  maxRunSeconds: number;
  verificationEvents: number;
  injectHoseSwap: boolean;
};

export const defaultConfig: AutocalConfig = {
  sampleIntervalSeconds: 10,
  baselineSamples: 36,
  pulseSeconds: 4,
  escalatedPulseSeconds: 8,
  observeSeconds: 420,
  preSamples: 6,
  postSamples: 8,
  minDeltaVwc: 0.4,
  minZ: 5,
  rivalZ: 3,
  maxNoiseSigma: 0.6,
  saturationVwc: 43.5,
  overshootLimitVwc: 6,
  ambiguousRatio: 0.7,
  flowTolerance: 0.4,
  convergenceTolerance: 0.5,
  reviewConfidence: 0.6,
  maxRunSeconds: 7 * 24 * 3600,
  verificationEvents: 12,
  injectHoseSwap: false,
};

export type Phase = "baseline" | "discovery" | "characterization" | "verification" | "done";
export type RunStatus = "running" | "completed" | "completed_with_faults" | "aborted" | "timeout";

export type FaultCode =
  | "sensor_invalid"
  | "excessive_noise"
  | "saturated"
  | "no_response"
  | "multiple_responses"
  | "duplicate_claim"
  | "cross_talk"
  | "overshoot"
  | "flow_anomaly"
  | "non_convergence"
  | "timeout"
  | "aborted"
  | "verification_mismatch";

export const faultLabels: Record<FaultCode, string> = {
  sensor_invalid: "Sensor invalid",
  excessive_noise: "Excessive noise",
  saturated: "Pot saturated",
  no_response: "No response",
  multiple_responses: "Multiple sensors responded",
  duplicate_claim: "Sensor claimed by more than one valve",
  cross_talk: "Cross-talk",
  overshoot: "Overshoot",
  flow_anomaly: "Flow anomaly",
  non_convergence: "Did not converge",
  timeout: "Timed out",
  aborted: "Run aborted",
  verification_mismatch: "Verification mismatch",
};

export type Fault = {
  code: FaultCode;
  valveIndex: number | null;
  sensorIndex: number | null;
  message: string;
  atSeconds: number;
};

export type SensorExclusion =
  | "unreachable"
  | "raw_counts"
  | "implausible"
  | "flatlined"
  | "excessive_noise"
  | "saturated";

export type SensorValidation = {
  sensorIndex: number;
  valid: boolean;
  exclusion: SensorExclusion | null;
  baselineVwc: number | null;
  noiseSigma: number | null;
  driftPerMinute: number | null;
  detail: string;
};

export type SensorResponse = {
  sensorIndex: number;
  deltaVwc: number;
  z: number;
  detected: boolean;
  settled: boolean;
  lagSeconds: number | null;
  settleSeconds: number | null;
  peakDeltaVwc: number;
};

export type Observation = {
  valveIndex: number;
  purpose: "discovery" | "escalation" | "characterization" | "verification";
  pulseSeconds: number;
  flowMl: number;
  expectedFlowMl: number;
  startedAtSeconds: number;
  responses: SensorResponse[];
  // Kept only for the most recent observation so the run view can draw traces.
  traces: Array<Array<number | null>>;
  preMeans: Array<number | null>;
};

export type Characterization = {
  pulseSeconds: number;
  deltaVwc: number;
  deltaRange: [number, number];
  lagSeconds: number | null;
  settleSeconds: number | null;
  conservativeGainPerSecond: number;
  pass: boolean;
  note: string;
};

export type ProposedPair = {
  valveIndex: number;
  sensorIndex: number;
  confidence: number;
  status: "proposed" | "needs_review";
  evidence: {
    deltaVwc: number;
    z: number;
    pulseSeconds: number;
    escalated: boolean;
    rowRivalDeltaVwc: number;
    columnRivalDeltaVwc: number;
    flowMl: number;
    expectedFlowMl: number;
  };
  faults: FaultCode[];
  characterization: Characterization | null;
  discoveredAtSeconds: number;
  lastVerifiedAtSeconds: number | null;
};

export type UnresolvedValve = {
  valveIndex: number;
  reason: FaultCode;
  detail: string;
};

export type VerificationResult = {
  valveIndex: number;
  expectedSensorIndex: number;
  expectedResponded: boolean;
  otherSensorIndexes: number[];
  outcome: "verified" | "mismatch";
  atSeconds: number;
};

export type RunResult = {
  status: Exclude<RunStatus, "running">;
  elapsedSeconds: number;
  stepsExecuted: number;
  validations: SensorValidation[];
  proposals: ProposedPair[];
  unresolvedValves: UnresolvedValve[];
  faults: Fault[];
  verification: VerificationResult[];
  hoseSwapInjected: [number, number] | null;
};

type Task =
  | { kind: "baseline"; samples: number; last: boolean }
  | { kind: "discover"; valveIndex: number; escalated: boolean }
  | { kind: "assign" }
  | { kind: "characterize"; valveIndex: number }
  | { kind: "verify"; valveIndex: number }
  | { kind: "finish" };

export type StepReport = {
  phase: Phase;
  message: string;
};

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

// Confidence answers "how sure are we this is the ONLY plausible pairing?", so it
// is driven by the margin over rival sensors (row) and rival valves (column), and
// only then scaled by how strong the response was.
export function pairConfidence(
  input: { deltaVwc: number; z: number; rowRivalDeltaVwc: number; columnRivalDeltaVwc: number },
  config: Pick<AutocalConfig, "minZ"> = defaultConfig,
) {
  if (!(input.deltaVwc > 0)) return 0;
  const strength = clamp01((input.z - config.minZ) / (3 * config.minZ));
  const rowMargin = clamp01(1 - input.rowRivalDeltaVwc / input.deltaVwc);
  const columnMargin = clamp01(1 - input.columnRivalDeltaVwc / input.deltaVwc);
  return clamp01((0.15 + 0.85 * strength) * Math.min(rowMargin, columnMargin));
}

export function confidenceLevel(confidence: number): "High" | "Medium" | "Low" {
  if (confidence >= 0.85) return "High";
  if (confidence >= 0.6) return "Medium";
  return "Low";
}

export class AutocalRun {
  readonly world: SimWorld;
  readonly config: AutocalConfig;
  readonly validations: SensorValidation[] = [];
  readonly faults: Fault[] = [];
  readonly proposals: ProposedPair[] = [];
  readonly unresolvedValves: UnresolvedValve[] = [];
  readonly verification: VerificationResult[] = [];
  // deltaMatrix[valve][sensor]; a row is null until that valve has been pulsed.
  readonly deltaMatrix: Array<Array<number | null> | null>;
  readonly detectedMatrix: Array<boolean[] | null>;
  readonly log: string[] = [];

  phase: Phase = "baseline";
  status: RunStatus = "running";
  activeValveIndex: number | null = null;
  lastObservation: Observation | null = null;
  stepsExecuted = 0;
  hoseSwapInjected: [number, number] | null = null;

  private readonly bench: SimulatedBench;
  private readonly queue: Task[] = [];
  private readonly baselineReadings: Array<Array<number | null>>;
  private readonly recent: Array<Array<number | null>>;
  private readonly zMatrix: Array<number[] | null>;
  private readonly discoveryObservation: Array<Observation | null>;
  private readonly pulseUsed: number[];
  private readonly sigma: number[];
  private readonly driftPerSecond: number[];
  private plannedSteps: number;

  constructor(world: SimWorld, config: Partial<AutocalConfig> = {}) {
    this.world = world;
    this.config = { ...defaultConfig, ...config };
    this.bench = new SimulatedBench(world);
    const sensorCount = world.sensors.length;
    const valveCount = world.valves.length;
    this.baselineReadings = Array.from({ length: sensorCount }, () => []);
    this.recent = Array.from({ length: sensorCount }, () => []);
    this.deltaMatrix = new Array(valveCount).fill(null);
    this.detectedMatrix = new Array(valveCount).fill(null);
    this.zMatrix = new Array(valveCount).fill(null);
    this.discoveryObservation = new Array(valveCount).fill(null);
    this.pulseUsed = new Array(valveCount).fill(this.config.pulseSeconds);
    this.sigma = new Array(sensorCount).fill(0.1);
    this.driftPerSecond = new Array(sensorCount).fill(0);

    const chunk = 6;
    for (let taken = 0; taken < this.config.baselineSamples; taken += chunk) {
      const samples = Math.min(chunk, this.config.baselineSamples - taken);
      this.queue.push({ kind: "baseline", samples, last: taken + samples >= this.config.baselineSamples });
    }
    for (let valveIndex = 0; valveIndex < valveCount; valveIndex += 1) {
      this.queue.push({ kind: "discover", valveIndex, escalated: false });
    }
    this.queue.push({ kind: "assign" });
    this.plannedSteps = this.queue.length + valveCount + Math.min(valveCount, this.config.verificationEvents) + 1;
  }

  get elapsedSeconds() {
    return this.bench.elapsedSeconds;
  }

  get done() {
    return this.status !== "running";
  }

  get progress() {
    if (this.done) return 1;
    return Math.min(0.99, this.stepsExecuted / Math.max(1, this.plannedSteps));
  }

  abort() {
    if (this.done) return;
    this.fault("aborted", null, null, "The run was stopped before it finished. Partial evidence is kept; no proposal is produced.");
    this.finish("aborted");
  }

  step(): StepReport | null {
    if (this.done) return null;
    const task = this.queue.shift();
    if (!task) {
      this.finish(this.faults.length ? "completed_with_faults" : "completed");
      return { phase: "done", message: "Run complete." };
    }

    const cost = this.taskSeconds(task);
    if (this.bench.elapsedSeconds + cost > this.config.maxRunSeconds) {
      this.fault("timeout", null, null, "The run exceeded its time budget and stopped safely. Valves that were not reached stay unresolved.");
      this.finish("timeout");
      return { phase: "done", message: "Run timed out." };
    }

    this.stepsExecuted += 1;
    let message: string;
    switch (task.kind) {
      case "baseline": message = this.runBaseline(task.samples, task.last); break;
      case "discover": message = this.runDiscovery(task.valveIndex, task.escalated); break;
      case "assign": message = this.runAssignment(); break;
      case "characterize": message = this.runCharacterization(task.valveIndex); break;
      case "verify": message = this.runVerification(task.valveIndex); break;
      case "finish":
        this.finish(this.faults.length ? "completed_with_faults" : "completed");
        message = "Run complete.";
        break;
    }
    this.log.push(message);
    return { phase: this.phase, message };
  }

  runToCompletion(maxSteps = 100_000) {
    let guard = 0;
    while (!this.done && guard < maxSteps) {
      this.step();
      guard += 1;
    }
    return this.result();
  }

  result(): RunResult {
    return {
      status: this.status === "running" ? "aborted" : this.status,
      elapsedSeconds: this.bench.elapsedSeconds,
      stepsExecuted: this.stepsExecuted,
      validations: this.validations,
      proposals: this.proposals,
      unresolvedValves: this.unresolvedValves,
      faults: this.faults,
      verification: this.verification,
      hoseSwapInjected: this.hoseSwapInjected,
    };
  }

  private taskSeconds(task: Task) {
    const { sampleIntervalSeconds, observeSeconds, pulseSeconds, escalatedPulseSeconds } = this.config;
    if (task.kind === "baseline") return task.samples * sampleIntervalSeconds;
    if (task.kind === "discover") return (task.escalated ? escalatedPulseSeconds : pulseSeconds) + observeSeconds;
    if (task.kind === "characterize" || task.kind === "verify") return this.pulseUsed[task.valveIndex] + observeSeconds;
    return 0;
  }

  private finish(status: Exclude<RunStatus, "running">) {
    this.status = status;
    this.phase = "done";
    this.activeValveIndex = null;
    this.queue.length = 0;
    if (status === "aborted" || status === "timeout") {
      // Anything not reached is reported, never guessed.
      const resolved = new Set([
        ...this.proposals.map((pair) => pair.valveIndex),
        ...this.unresolvedValves.map((item) => item.valveIndex),
      ]);
      this.world.valves.forEach((valve) => {
        if (resolved.has(valve.index)) return;
        this.unresolvedValves.push({
          valveIndex: valve.index,
          reason: status === "aborted" ? "aborted" : "timeout",
          detail: status === "aborted" ? "Not resolved before the run was stopped." : "Not resolved before the run timed out.",
        });
      });
      if (status === "aborted") this.proposals.length = 0;
    }
  }

  private fault(code: FaultCode, valveIndex: number | null, sensorIndex: number | null, message: string) {
    this.faults.push({ code, valveIndex, sensorIndex, message, atSeconds: this.bench.elapsedSeconds });
  }

  private pushRecent(readings: Array<number | null>) {
    readings.forEach((value, sensorIndex) => {
      const buffer = this.recent[sensorIndex];
      buffer.push(value);
      if (buffer.length > this.config.preSamples) buffer.shift();
    });
  }

  private runBaseline(samples: number, last: boolean) {
    this.phase = "baseline";
    for (let count = 0; count < samples; count += 1) {
      const readings = this.bench.sample(this.config.sampleIntervalSeconds);
      readings.forEach((value, sensorIndex) => this.baselineReadings[sensorIndex].push(value));
      this.pushRecent(readings);
    }
    if (!last) return `Polling ${this.world.sensors.length} simulated sensors before any water is applied.`;

    this.world.sensors.forEach((sensor) => this.validations.push(this.validateSensor(sensor.index)));
    const excluded = this.validations.filter((item) => !item.valid);
    this.phase = "discovery";
    return excluded.length
      ? `Sensor self-test finished: ${excluded.length} of ${this.validations.length} sensors excluded.`
      : `Sensor self-test finished: all ${this.validations.length} sensors are usable.`;
  }

  private validateSensor(sensorIndex: number): SensorValidation {
    const sensorId = this.world.sensors[sensorIndex].id;
    const raw = this.baselineReadings[sensorIndex];
    const values = raw.filter((value): value is number => value != null && Number.isFinite(value));
    const exclude = (exclusion: SensorExclusion, code: FaultCode, detail: string, baseline: number | null = null): SensorValidation => {
      this.fault(code, null, sensorIndex, `Sensor ${sensorId}: ${detail}`);
      return { sensorIndex, valid: false, exclusion, baselineVwc: baseline, noiseSigma: null, driftPerMinute: null, detail };
    };

    if (values.length < raw.length * 0.5) {
      return exclude("unreachable", "sensor_invalid", "did not answer polls. Check its cable and address.");
    }
    const center = median(values);
    if (center > 100) {
      return exclude("raw_counts", "sensor_invalid", `reports values near ${Math.round(center)}, which look like raw counts rather than % VWC.`);
    }
    if (center < 0 || center > 70) {
      return exclude("implausible", "sensor_invalid", `reads ${center.toFixed(1)}% VWC, outside the plausible range.`, center);
    }

    // Least-squares drift, then noise around that line.
    const interval = this.config.sampleIntervalSeconds;
    const times = values.map((_, index) => index * interval);
    const timeMean = mean(times);
    const valueMean = mean(values);
    let numerator = 0;
    let denominator = 0;
    times.forEach((time, index) => {
      numerator += (time - timeMean) * (values[index] - valueMean);
      denominator += (time - timeMean) ** 2;
    });
    const slope = denominator > 0 ? numerator / denominator : 0;
    const residuals = values.map((value, index) => value - (valueMean + slope * (times[index] - timeMean)));
    const sigma = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length - 2));

    if (new Set(values).size === 1) {
      return exclude("flatlined", "sensor_invalid", `is stuck at exactly ${center.toFixed(2)}% VWC. A live sensor always shows some variation.`, center);
    }
    if (sigma > this.config.maxNoiseSigma) {
      return exclude("excessive_noise", "excessive_noise", `noise is ±${sigma.toFixed(2)}% VWC, too high to see a diagnostic pulse.`, center);
    }
    if (center >= this.config.saturationVwc) {
      return exclude("saturated", "saturated", `reads ${center.toFixed(1)}% VWC. The pot is saturated, so a diagnostic pulse cannot produce a measurable rise.`, center);
    }

    this.sigma[sensorIndex] = Math.max(0.03, sigma);
    const slopeError = sigma / Math.sqrt(Math.max(denominator, 1e-9));
    this.driftPerSecond[sensorIndex] = Math.abs(slope) > 3 * slopeError ? slope : 0;
    return {
      sensorIndex,
      valid: true,
      exclusion: null,
      baselineVwc: center,
      noiseSigma: sigma,
      driftPerMinute: slope * 60,
      detail: "Usable",
    };
  }

  private observe(valveIndex: number, pulseSeconds: number, purpose: Observation["purpose"]): Observation {
    const { sampleIntervalSeconds, observeSeconds, postSamples, minDeltaVwc, minZ } = this.config;
    const startedAtSeconds = this.bench.elapsedSeconds;
    const pre = this.recent.map((buffer) => buffer.filter((value): value is number => value != null));
    const preMeans = pre.map((values) => (values.length ? mean(values) : null));
    const { flowMl, expectedFlowMl } = this.bench.pulse(valveIndex, pulseSeconds);

    const sampleCount = Math.max(postSamples * 2, Math.round(observeSeconds / sampleIntervalSeconds));
    const traces: Array<Array<number | null>> = this.world.sensors.map(() => []);
    for (let count = 0; count < sampleCount; count += 1) {
      const readings = this.bench.sample(sampleIntervalSeconds);
      readings.forEach((value, sensorIndex) => traces[sensorIndex].push(value));
      this.pushRecent(readings);
    }

    const responses: SensorResponse[] = [];
    this.validations.forEach((validation) => {
      if (!validation.valid) return;
      const sensorIndex = validation.sensorIndex;
      const preMean = preMeans[sensorIndex];
      const series = traces[sensorIndex].filter((value): value is number => value != null);
      if (preMean == null || series.length < postSamples * 2) return;

      const tail = series.slice(-postSamples);
      const before = series.slice(-postSamples * 2, -postSamples);
      const elapsed = pulseSeconds + (sampleCount - postSamples / 2) * sampleIntervalSeconds
        + (pre[sensorIndex].length / 2) * sampleIntervalSeconds;
      const deltaVwc = mean(tail) - preMean - this.driftPerSecond[sensorIndex] * elapsed;
      const standardError = this.sigma[sensorIndex] * Math.sqrt(1 / pre[sensorIndex].length + 1 / tail.length);
      const z = deltaVwc / standardError;
      const sustained = deltaVwc > 0 && tail.every((value) => value >= preMean + 0.5 * deltaVwc);
      const detected = deltaVwc >= minDeltaVwc && z >= minZ && sustained;
      const settled = mean(tail) - mean(before) <= Math.max(0.12 * deltaVwc, 3 * standardError);

      let lagSeconds: number | null = null;
      let settleSeconds: number | null = null;
      let peak = 0;
      if (detected) {
        for (let index = 1; index < series.length - 1; index += 1) {
          const smooth = (series[index - 1] + series[index] + series[index + 1]) / 3 - preMean;
          peak = Math.max(peak, smooth);
          const at = pulseSeconds + (index + 1) * sampleIntervalSeconds;
          if (lagSeconds == null && smooth >= 0.1 * deltaVwc) lagSeconds = at;
          if (settleSeconds == null && smooth >= 0.9 * deltaVwc) settleSeconds = at;
        }
      }
      responses.push({
        sensorIndex,
        deltaVwc,
        z,
        detected,
        settled,
        lagSeconds,
        settleSeconds: settled ? settleSeconds : null,
        peakDeltaVwc: Math.max(peak, deltaVwc),
      });
    });

    // A response that is still rising would bleed into the next valve's window.
    // Wait one extra window (once, never indefinitely) before moving on.
    if (responses.some((response) => response.detected && !response.settled)) {
      for (let count = 0; count < sampleCount; count += 1) {
        this.pushRecent(this.bench.sample(sampleIntervalSeconds));
      }
    }

    const observation: Observation = { valveIndex, purpose, pulseSeconds, flowMl, expectedFlowMl, startedAtSeconds, responses, traces, preMeans };
    if (this.lastObservation) this.lastObservation.traces = [];
    this.lastObservation = observation;
    return observation;
  }

  private runDiscovery(valveIndex: number, escalated: boolean) {
    this.phase = "discovery";
    this.activeValveIndex = valveIndex;
    const valveId = this.world.valves[valveIndex].id;
    const pulseSeconds = escalated ? this.config.escalatedPulseSeconds : this.config.pulseSeconds;
    const observation = this.observe(valveIndex, pulseSeconds, escalated ? "escalation" : "discovery");

    const sensorCount = this.world.sensors.length;
    const deltas = new Array<number | null>(sensorCount).fill(null);
    const zs = new Array<number>(sensorCount).fill(0);
    const detected = new Array<boolean>(sensorCount).fill(false);
    observation.responses.forEach((response) => {
      deltas[response.sensorIndex] = Math.max(0, response.deltaVwc);
      zs[response.sensorIndex] = response.z;
      detected[response.sensorIndex] = response.detected;
    });
    this.deltaMatrix[valveIndex] = deltas;
    this.zMatrix[valveIndex] = zs;
    this.detectedMatrix[valveIndex] = detected;
    this.discoveryObservation[valveIndex] = { ...observation, traces: [] };
    this.pulseUsed[valveIndex] = pulseSeconds;

    const responders = observation.responses.filter((response) => response.detected);
    if (responders.length === 0 && !escalated) {
      // One bounded escalation, then a safe failure. Never an open-ended retry.
      this.queue.unshift({ kind: "discover", valveIndex, escalated: true });
      this.plannedSteps += 1;
      return `Valve ${valveId}: no sensor rose after a ${pulseSeconds}s pulse. Trying one longer pulse.`;
    }
    if (responders.length === 0) return `Valve ${valveId}: still no response after the longer pulse. Marked unresolved.`;
    const best = responders.reduce((a, b) => (b.deltaVwc > a.deltaVwc ? b : a));
    return `Valve ${valveId}: sensor ${this.world.sensors[best.sensorIndex].id} rose ${best.deltaVwc.toFixed(1)}% VWC${responders.length > 1 ? ` (${responders.length} sensors responded)` : ""}.`;
  }

  private detectedResponses(valveIndex: number) {
    const observation = this.discoveryObservation[valveIndex];
    return (observation?.responses ?? [])
      .filter((response) => response.detected)
      .sort((a, b) => b.deltaVwc - a.deltaVwc);
  }

  private runAssignment() {
    const { ambiguousRatio, rivalZ, minDeltaVwc, flowTolerance, overshootLimitVwc, reviewConfidence } = this.config;
    const valveCount = this.world.valves.length;
    const sensorCount = this.world.sensors.length;
    this.activeValveIndex = null;

    const rowMax = new Array<number>(valveCount).fill(0);
    const columnMax = new Array<number>(sensorCount).fill(0);
    for (let v = 0; v < valveCount; v += 1) {
      for (const response of this.detectedResponses(v)) {
        rowMax[v] = Math.max(rowMax[v], response.deltaVwc);
        columnMax[response.sensorIndex] = Math.max(columnMax[response.sensorIndex], response.deltaVwc);
      }
    }
    // Mutual-best weight: 1 when the cell is the strongest in both its row and column.
    const weights = Array.from({ length: valveCount }, () => new Array<number>(sensorCount).fill(0));
    for (let v = 0; v < valveCount; v += 1) {
      for (const response of this.detectedResponses(v)) {
        weights[v][response.sensorIndex] = (response.deltaVwc / rowMax[v]) * (response.deltaVwc / columnMax[response.sensorIndex]);
      }
    }
    const assignment = assignOneToOne(weights);

    // Which valves point at each sensor as their strongest response?
    const claimants = new Map<number, number[]>();
    for (let v = 0; v < valveCount; v += 1) {
      const strongest = this.detectedResponses(v)[0];
      if (!strongest) continue;
      claimants.set(strongest.sensorIndex, [...(claimants.get(strongest.sensorIndex) ?? []), v]);
    }

    const rival = (deltas: Array<number | null> | null, zs: number[] | null, skip: number) => {
      let best = 0;
      (deltas ?? []).forEach((delta, index) => {
        if (index === skip || delta == null || !zs) return;
        if (zs[index] >= rivalZ && delta >= 0.5 * minDeltaVwc) best = Math.max(best, delta);
      });
      return best;
    };

    for (let v = 0; v < valveCount; v += 1) {
      const valveId = this.world.valves[v].id;
      const observation = this.discoveryObservation[v];
      if (!observation) continue;
      const responders = this.detectedResponses(v);
      const pairFaults: FaultCode[] = [];
      const flowRatio = observation.expectedFlowMl > 0 ? observation.flowMl / observation.expectedFlowMl : 1;
      const flowBad = Math.abs(1 - flowRatio) > flowTolerance;

      if (flowBad) {
        pairFaults.push("flow_anomaly");
        this.fault("flow_anomaly", v, null, flowRatio < 0.05
          ? `Valve ${valveId}: the simulated flow reading stayed at zero. The valve may be stuck closed or unpowered.`
          : `Valve ${valveId}: simulated flow was ${Math.round(flowRatio * 100)}% of expected. Check for a kinked line or low pressure.`);
      }

      if (responders.length === 0) {
        this.fault("no_response", v, null, flowBad && flowRatio < 0.05
          ? `Valve ${valveId}: no sensor responded and no flow was measured.`
          : `Valve ${valveId}: water flowed but no usable sensor rose, even after one longer pulse. The hose may be disconnected or watering a pot whose sensor was excluded.`);
        this.unresolvedValves.push({
          valveIndex: v,
          reason: flowBad && flowRatio < 0.05 ? "flow_anomaly" : "no_response",
          detail: flowBad && flowRatio < 0.05 ? "No flow and no sensor response." : "Flow was normal but no usable sensor responded.",
        });
        continue;
      }

      if (responders.length > 1) {
        const ratio = responders[1].deltaVwc / responders[0].deltaVwc;
        const names = responders.slice(0, 3).map((item) => this.world.sensors[item.sensorIndex].id).join(", ");
        if (ratio >= ambiguousRatio) {
          pairFaults.push("multiple_responses");
          this.fault("multiple_responses", v, responders[1].sensorIndex, `Valve ${valveId}: sensors ${names} rose by similar amounts, so the hose target is ambiguous.`);
        } else {
          pairFaults.push("cross_talk");
          this.fault("cross_talk", v, responders[1].sensorIndex, `Valve ${valveId}: mainly waters ${this.world.sensors[responders[0].sensorIndex].id}, but ${this.world.sensors[responders[1].sensorIndex].id} also rose (${Math.round(ratio * 100)}% as much).`);
        }
      }

      const contested = claimants.get(responders[0].sensorIndex) ?? [];
      if (contested.length > 1) {
        pairFaults.push("duplicate_claim");
        this.fault("duplicate_claim", v, responders[0].sensorIndex, `Valve ${valveId}: sensor ${this.world.sensors[responders[0].sensorIndex].id} is also the strongest response for ${contested.filter((other) => other !== v).map((other) => this.world.valves[other].id).join(", ")}. Two valves may feed one pot.`);
      }

      const sensorIndex = assignment[v];
      if (sensorIndex == null) {
        this.unresolvedValves.push({
          valveIndex: v,
          reason: pairFaults.includes("duplicate_claim") ? "duplicate_claim" : "multiple_responses",
          detail: "Every sensor this valve moved is better explained by another valve, so no one-to-one pairing is proposed.",
        });
        continue;
      }

      const response = responders.find((item) => item.sensorIndex === sensorIndex)!;
      if (response.peakDeltaVwc > overshootLimitVwc) {
        pairFaults.push("overshoot");
        this.fault("overshoot", v, sensorIndex, `Valve ${valveId}: a ${observation.pulseSeconds}s pulse raised ${this.world.sensors[sensorIndex].id} by ${response.peakDeltaVwc.toFixed(1)}% VWC, above the ${overshootLimitVwc}% diagnostic limit. Use a shorter pulse for this pot.`);
      }
      if (!response.settled) {
        pairFaults.push("timeout");
        this.fault("timeout", v, sensorIndex, `Valve ${valveId}: ${this.world.sensors[sensorIndex].id} was still rising when the observation window closed, so its response could not be measured.`);
      }

      const rowRivalDeltaVwc = rival(this.deltaMatrix[v], this.zMatrix[v], sensorIndex);
      let columnRivalDeltaVwc = 0;
      for (let other = 0; other < valveCount; other += 1) {
        if (other === v) continue;
        const delta = this.deltaMatrix[other]?.[sensorIndex];
        const z = this.zMatrix[other]?.[sensorIndex] ?? 0;
        if (delta != null && z >= rivalZ && delta >= 0.5 * minDeltaVwc) columnRivalDeltaVwc = Math.max(columnRivalDeltaVwc, delta);
      }
      const confidence = pairConfidence({ deltaVwc: response.deltaVwc, z: response.z, rowRivalDeltaVwc, columnRivalDeltaVwc }, this.config);

      this.proposals.push({
        valveIndex: v,
        sensorIndex,
        confidence,
        status: pairFaults.length || confidence < reviewConfidence ? "needs_review" : "proposed",
        evidence: {
          deltaVwc: response.deltaVwc,
          z: response.z,
          pulseSeconds: observation.pulseSeconds,
          escalated: observation.purpose === "escalation",
          rowRivalDeltaVwc,
          columnRivalDeltaVwc,
          flowMl: observation.flowMl,
          expectedFlowMl: observation.expectedFlowMl,
        },
        faults: pairFaults,
        characterization: null,
        discoveredAtSeconds: observation.startedAtSeconds,
        lastVerifiedAtSeconds: null,
      });
    }

    this.proposals.forEach((pair) => this.queue.push({ kind: "characterize", valveIndex: pair.valveIndex }));
    const eligible = this.proposals.filter((pair) => pair.status === "proposed");
    const wanted = Math.min(this.config.verificationEvents, eligible.length);
    const chosen = Array.from({ length: wanted }, (_, index) => eligible[Math.floor((index * eligible.length) / wanted)]);
    chosen.forEach((pair) => this.queue.push({ kind: "verify", valveIndex: pair.valveIndex }));
    this.queue.push({ kind: "finish" });
    this.plannedSteps = this.stepsExecuted + this.queue.length;
    this.phase = "characterization";
    return `Matched ${this.proposals.length} of ${valveCount} valves one-to-one; ${this.unresolvedValves.length} unresolved.`;
  }

  private runCharacterization(valveIndex: number) {
    this.phase = "characterization";
    this.activeValveIndex = valveIndex;
    const pair = this.proposals.find((item) => item.valveIndex === valveIndex)!;
    const valveId = this.world.valves[valveIndex].id;
    const first = this.discoveryObservation[valveIndex]!.responses.find((item) => item.sensorIndex === pair.sensorIndex)!;
    const pulseSeconds = this.pulseUsed[valveIndex];

    if (pair.faults.includes("overshoot") || pair.faults.includes("timeout")) {
      pair.characterization = {
        pulseSeconds,
        deltaVwc: first.deltaVwc,
        deltaRange: [first.deltaVwc, first.deltaVwc],
        lagSeconds: first.lagSeconds,
        settleSeconds: first.settleSeconds,
        conservativeGainPerSecond: 0,
        pass: false,
        note: pair.faults.includes("overshoot")
          ? "Not pulsed again: the first pulse already exceeded the overshoot limit."
          : "Not pulsed again: the first response had not settled.",
      };
      return `Valve ${valveId}: skipped the second pulse for safety.`;
    }

    const second = this.observe(valveIndex, pulseSeconds, "characterization").responses
      .find((item) => item.sensorIndex === pair.sensorIndex);
    const secondDelta = Math.max(0, second?.deltaVwc ?? 0);
    const low = Math.min(first.deltaVwc, secondDelta);
    const high = Math.max(first.deltaVwc, secondDelta);
    const converged = high > 0 && (high - low) / high <= this.config.convergenceTolerance;
    if (!converged) {
      pair.faults.push("non_convergence");
      pair.status = "needs_review";
      this.fault("non_convergence", valveIndex, pair.sensorIndex, `Valve ${valveId}: two identical pulses raised ${this.world.sensors[pair.sensorIndex].id} by ${first.deltaVwc.toFixed(1)}% and ${secondDelta.toFixed(1)}% VWC. The response is not repeatable enough to estimate a gain.`);
    }
    const pass = converged && pair.status === "proposed";
    pair.characterization = {
      pulseSeconds,
      deltaVwc: (first.deltaVwc + secondDelta) / 2,
      deltaRange: [low, high],
      lagSeconds: second?.lagSeconds ?? first.lagSeconds,
      settleSeconds: second?.settleSeconds ?? first.settleSeconds,
      // Deliberately pessimistic: the smaller response, derated again.
      conservativeGainPerSecond: converged ? (0.8 * low) / pulseSeconds : 0,
      pass,
      note: converged
        ? "Bounded first estimate for observe-then-recalculate dosing. Soil response is not linear."
        : "Responses disagreed; no gain estimate is offered.",
    };
    return `Valve ${valveId}: second pulse ${converged ? "agreed" : "disagreed"} with the first (${low.toFixed(1)}–${high.toFixed(1)}% VWC).`;
  }

  private runVerification(valveIndex: number) {
    const first = this.phase !== "verification";
    this.phase = "verification";
    if (first && this.config.injectHoseSwap) {
      const targets = this.queue.filter((task): task is Extract<Task, { kind: "verify" }> => task.kind === "verify");
      const other = targets[0]?.valveIndex;
      if (other != null) {
        this.bench.swapHoses(valveIndex, other);
        this.hoseSwapInjected = [valveIndex, other];
        this.log.push(`Demonstration: the hoses on valves ${this.world.valves[valveIndex].id} and ${this.world.valves[other].id} were swapped in the simulator.`);
      }
    }

    this.activeValveIndex = valveIndex;
    const pair = this.proposals.find((item) => item.valveIndex === valveIndex)!;
    const valveId = this.world.valves[valveIndex].id;
    const observation = this.observe(valveIndex, this.pulseUsed[valveIndex], "verification");
    const responders = observation.responses.filter((item) => item.detected);
    const expectedResponded = responders.some((item) => item.sensorIndex === pair.sensorIndex);
    const otherSensorIndexes = responders.filter((item) => item.sensorIndex !== pair.sensorIndex).map((item) => item.sensorIndex);
    const outcome = expectedResponded && otherSensorIndexes.length === 0 ? "verified" : "mismatch";
    this.verification.push({
      valveIndex,
      expectedSensorIndex: pair.sensorIndex,
      expectedResponded,
      otherSensorIndexes,
      outcome,
      atSeconds: observation.startedAtSeconds,
    });

    if (outcome === "verified") {
      pair.lastVerifiedAtSeconds = observation.startedAtSeconds;
      return `Valve ${valveId}: watering event confirmed the expected sensor and no other sensor moved.`;
    }
    pair.status = "needs_review";
    pair.faults.push("verification_mismatch");
    const moved = otherSensorIndexes.map((index) => this.world.sensors[index].id).join(", ");
    this.fault("verification_mismatch", valveIndex, pair.sensorIndex, `Valve ${valveId}: expected ${this.world.sensors[pair.sensorIndex].id} to respond${expectedResponded ? "" : ", but it did not"}${moved ? `; ${moved} moved instead` : ""}. The pairing is flagged for review. Nothing was changed automatically.`);
    return `Valve ${valveId}: watering event did not match the expected sensor. Flagged for review.`;
  }
}

// Simulation-only answer key: how many proposed pairs match the hidden layout.
export function scoreAgainstTruth(world: SimWorld, result: Pick<RunResult, "proposals">) {
  let correct = 0;
  let wrong = 0;
  result.proposals.forEach((pair) => {
    if (world.truth[pair.valveIndex] === pair.sensorIndex) correct += 1;
    else wrong += 1;
  });
  const resolvable = world.truth.filter((sensorIndex) => sensorIndex != null).length;
  return { correct, wrong, resolvable };
}
