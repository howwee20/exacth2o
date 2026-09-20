import { assignOneToOne } from "../topology/assignment";
import { pairConfidence } from "../topology/confidence";
import type {
  CommissioningConfig,
  ProposalFault,
  ProposedMapping,
  PulseEvidence,
  Reading,
  SelectedPot,
  SensorBaseline,
  SensorResponse,
  UnresolvedValve,
} from "./types";

// Pure analysis of real, irregularly timed sensor readings. Robust statistics
// (median, MAD) are used because field readings arrive slowly and unevenly.

export function median(values: number[]) {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustSigma(values: number[], center: number) {
  const deviations = values.map((value) => Math.abs(value - center));
  return 1.4826 * median(deviations);
}

export const minimumNoiseSigma = 0.05;

export function summarizeBaseline(
  sensorKey: string,
  readings: Reading[],
  config: Pick<CommissioningConfig, "baselineReadings" | "saturationVwc">,
): SensorBaseline {
  const own = readings
    .filter((reading) => reading.sensorKey === sensorKey && Number.isFinite(reading.vwc))
    .sort((a, b) => a.atMs - b.atMs);
  const values = own.map((reading) => reading.vwc);
  const gaps = own.slice(1).map((reading, index) => (reading.atMs - own[index].atMs) / 1000).filter((gap) => gap > 0);
  const base: SensorBaseline = {
    sensorKey,
    valid: false,
    reason: null,
    warnings: [],
    count: own.length,
    medianVwc: values.length ? median(values) : null,
    noiseSigma: null,
    driftPerMinute: null,
    cadenceSeconds: gaps.length ? median(gaps) : null,
    lastAtMs: own.length ? own[own.length - 1].atMs : null,
  };

  if (own.length < config.baselineReadings) {
    return { ...base, reason: `Only ${own.length} of ${config.baselineReadings} baseline readings arrived.` };
  }
  const center = base.medianVwc as number;
  if (center > 100) return { ...base, reason: `Values near ${Math.round(center)} look like raw counts, not % VWC.` };
  if (center < 0 || center > 70) return { ...base, reason: `${center.toFixed(1)}% VWC is outside the plausible range.` };
  if (center >= config.saturationVwc) {
    return { ...base, reason: `${center.toFixed(1)}% VWC: the pot is near saturation, so a short pulse cannot produce a measurable rise.` };
  }

  const first = own[0].atMs;
  const minutes = own.map((reading) => (reading.atMs - first) / 60000);
  const timeMean = minutes.reduce((sum, value) => sum + value, 0) / minutes.length;
  const valueMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  minutes.forEach((minute, index) => {
    numerator += (minute - timeMean) * (values[index] - valueMean);
    denominator += (minute - timeMean) ** 2;
  });

  const warnings: string[] = [];
  if (new Set(values).size === 1) warnings.push("Every baseline reading was identical. Confirm the sensor is live.");
  return {
    ...base,
    valid: true,
    warnings,
    noiseSigma: Math.max(minimumNoiseSigma, robustSigma(values, center)),
    driftPerMinute: denominator > 0 ? numerator / denominator : 0,
  };
}

// Compares the level just before a pulse with the settled level after it.
export function measureResponse(input: {
  sensorKey: string;
  readings: Reading[];
  requestedAtMs: number;
  pulseEndMs: number;
  noiseSigma: number;
  config: Pick<CommissioningConfig, "preReadings" | "minPostReadings" | "settleSkipSeconds" | "minDeltaVwc" | "minZ">;
}): SensorResponse | null {
  const { sensorKey, requestedAtMs, pulseEndMs, config } = input;
  const own = input.readings.filter((reading) => reading.sensorKey === sensorKey).sort((a, b) => a.atMs - b.atMs);
  const before = own.filter((reading) => reading.atMs < requestedAtMs).slice(-config.preReadings);
  const after = own.filter((reading) => reading.atMs >= pulseEndMs + config.settleSkipSeconds * 1000);
  if (before.length === 0 || after.length === 0) return null;

  const settled = after.slice(-config.minPostReadings);
  const preVwc = median(before.map((reading) => reading.vwc));
  const postVwc = median(settled.map((reading) => reading.vwc));
  const deltaVwc = postVwc - preVwc;
  const standardError = Math.max(minimumNoiseSigma, input.noiseSigma) * Math.sqrt(1 / before.length + 1 / settled.length);
  const z = deltaVwc / standardError;
  const enough = settled.length >= config.minPostReadings;
  const sustained = deltaVwc > 0 && settled.every((reading) => reading.vwc >= preVwc + 0.5 * deltaVwc);
  return {
    sensorKey,
    preVwc,
    postVwc,
    deltaVwc,
    z,
    postCount: after.length,
    detected: enough && sustained && deltaVwc >= config.minDeltaVwc && z >= config.minZ,
  };
}

// Builds proposed mappings from the final evidence per valve. One-to-one across
// the whole matrix, so no sensor can be proposed for two valves.
export function proposeTopology(
  pots: SelectedPot[],
  evidence: PulseEvidence[],
  config: Pick<CommissioningConfig, "minZ" | "rivalZ" | "minDeltaVwc" | "ambiguousRatio" | "overshootLimitVwc" | "reviewConfidence">,
): { proposals: ProposedMapping[]; unresolved: UnresolvedValve[] } {
  const sensorKeys = pots.map((pot) => pot.sensorKey);
  const sensorIndex = new Map(sensorKeys.map((key, index) => [key, index]));
  // The last evidence recorded for a valve is the one that counts (an escalation supersedes the first pulse).
  const finalEvidence = new Map<string, PulseEvidence>();
  evidence.forEach((item) => finalEvidence.set(item.valveKey, item));

  const detectedFor = (valveKey: string) =>
    (finalEvidence.get(valveKey)?.responses ?? [])
      .filter((response) => response.detected && sensorIndex.has(response.sensorKey))
      .sort((a, b) => b.deltaVwc - a.deltaVwc);

  const rowMax = pots.map((pot) => detectedFor(pot.valveKey)[0]?.deltaVwc ?? 0);
  const columnMax = new Array<number>(sensorKeys.length).fill(0);
  pots.forEach((pot) => detectedFor(pot.valveKey).forEach((response) => {
    const column = sensorIndex.get(response.sensorKey) as number;
    columnMax[column] = Math.max(columnMax[column], response.deltaVwc);
  }));
  const weights = pots.map((pot, row) => {
    const line = new Array<number>(sensorKeys.length).fill(0);
    detectedFor(pot.valveKey).forEach((response) => {
      const column = sensorIndex.get(response.sensorKey) as number;
      line[column] = (response.deltaVwc / rowMax[row]) * (response.deltaVwc / columnMax[column]);
    });
    return line;
  });
  const assignment = assignOneToOne(weights);

  const claimants = new Map<string, string[]>();
  pots.forEach((pot) => {
    const strongest = detectedFor(pot.valveKey)[0];
    if (strongest) claimants.set(strongest.sensorKey, [...(claimants.get(strongest.sensorKey) ?? []), pot.valveKey]);
  });

  const isRival = (response: SensorResponse) => response.z >= config.rivalZ && response.deltaVwc >= 0.5 * config.minDeltaVwc;
  const proposals: ProposedMapping[] = [];
  const unresolved: UnresolvedValve[] = [];

  pots.forEach((pot, row) => {
    const item = finalEvidence.get(pot.valveKey);
    if (!item) {
      unresolved.push({ valveKey: pot.valveKey, pairingName: pot.pairingName, reason: "not_reached", detail: "The run ended before this valve was pulsed." });
      return;
    }
    if (item.acknowledgement.status !== "succeeded") {
      unresolved.push({
        valveKey: pot.valveKey,
        pairingName: pot.pairingName,
        reason: "command_failed",
        detail: item.acknowledgement.status === "not_sent"
          ? "Dry run: no valve command was sent, so there is nothing to measure."
          : `The controller did not confirm the pulse (${item.acknowledgement.status}).`,
      });
      return;
    }
    const responders = detectedFor(pot.valveKey);
    if (responders.length === 0) {
      unresolved.push({
        valveKey: pot.valveKey,
        pairingName: pot.pairingName,
        reason: "no_response",
        detail: "The controller acknowledged the pulse but no selected sensor rose. The hose may be disconnected, outside the selected pots, or the pulse was too short.",
      });
      return;
    }

    const faults: ProposalFault[] = [];
    if (responders.length > 1) {
      faults.push(responders[1].deltaVwc / responders[0].deltaVwc >= config.ambiguousRatio ? "multiple_responses" : "cross_talk");
    }
    if ((claimants.get(responders[0].sensorKey) ?? []).length > 1) faults.push("duplicate_claim");

    const column = assignment[row];
    if (column == null) {
      unresolved.push({
        valveKey: pot.valveKey,
        pairingName: pot.pairingName,
        reason: faults.includes("duplicate_claim") ? "duplicate_claim" : "multiple_responses",
        detail: "Every sensor this valve moved is better explained by another valve, so no one-to-one pairing is proposed.",
      });
      return;
    }

    const proposedSensorKey = sensorKeys[column];
    const response = responders.find((candidate) => candidate.sensorKey === proposedSensorKey) as SensorResponse;
    if (response.deltaVwc > config.overshootLimitVwc) faults.push("overshoot");
    const rowRivalDeltaVwc = Math.max(0, ...item.responses.filter((candidate) => candidate.sensorKey !== proposedSensorKey && isRival(candidate)).map((candidate) => candidate.deltaVwc));
    let columnRivalDeltaVwc = 0;
    finalEvidence.forEach((other, valveKey) => {
      if (valveKey === pot.valveKey) return;
      const rival = other.responses.find((candidate) => candidate.sensorKey === proposedSensorKey);
      if (rival && isRival(rival)) columnRivalDeltaVwc = Math.max(columnRivalDeltaVwc, rival.deltaVwc);
    });
    const confidence = pairConfidence({ deltaVwc: response.deltaVwc, z: response.z, rowRivalDeltaVwc, columnRivalDeltaVwc }, config);
    if (confidence < config.reviewConfidence) faults.push("low_confidence");

    proposals.push({
      valveKey: pot.valveKey,
      pairingName: pot.pairingName,
      proposedSensorKey,
      recordedSensorKey: pot.sensorKey,
      matchesRecord: proposedSensorKey === pot.sensorKey,
      confidence,
      status: faults.length ? "needs_review" : "proposed",
      faults,
      deltaVwc: response.deltaVwc,
      z: response.z,
      pulseSeconds: item.requestedSeconds,
      rowRivalDeltaVwc,
      columnRivalDeltaVwc,
      commandId: item.commandId,
    });
  });

  return { proposals, unresolved };
}
