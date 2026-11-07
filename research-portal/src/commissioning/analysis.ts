import { pairConfidence } from "../topology/confidence";
import type {
  CommissioningConfig,
  ProposedMapping,
  PulseEvidence,
  Reading,
  SelectedPot,
  SensorBaseline,
  SensorResponse,
  UnclaimedSensor,
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
  readings: readonly Reading[],
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
    // The current reporting rate, from the latest gaps: preparation switches pots to a
    // faster interval, and the median of the whole look-back window (mostly the old,
    // slow readings) would keep calling them too slow for many minutes after it.
    cadenceSeconds: gaps.length ? median(gaps.slice(-4)) : null,
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
  readings: readonly Reading[];
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
  pots: readonly SelectedPot[],
  evidence: readonly PulseEvidence[],
  config: Pick<CommissioningConfig, "minZ" | "rivalZ" | "minDeltaVwc" | "ambiguousRatio" | "overshootLimitVwc" | "reviewConfidence">,
): { proposals: ProposedMapping[]; unresolved: UnresolvedValve[] } {
  // Resolve in pulse-completion order. A retry replaces its first attempt; a
  // matched sensor leaves the candidate set. Never fill the last slot by elimination.
  const finalEvidence = new Map<string, PulseEvidence>();
  for (const item of evidence) {
    finalEvidence.delete(item.valveKey);
    finalEvidence.set(item.valveKey, item);
  }
  const selected = new Set(pots.map(pot => pot.sensorKey));
  const byValve = new Map(pots.map(pot => [pot.valveKey, pot]));
  const reserved = new Map<string, string>();
  const proposals = new Map<string, ProposedMapping>();
  const unresolved = new Map<string, UnresolvedValve>();
  const reject = (pot: SelectedPot, reason: UnresolvedValve["reason"], detail: string) => {
    proposals.delete(pot.valveKey);
    unresolved.set(pot.valveKey, { valveKey: pot.valveKey, pairingName: pot.pairingName, reason, detail });
  };
  const isRival = (response: SensorResponse) => response.z >= config.rivalZ && response.deltaVwc >= 0.5 * config.minDeltaVwc;

  for (const [valveKey, item] of finalEvidence) {
    const pot = byValve.get(valveKey);
    if (!pot) continue;
    if (item.invalidated) {
      reject(pot, "invalidated", "This pulse observation was interrupted or invalidated. No match is made.");
      continue;
    }
    if (item.acknowledgement.status !== "succeeded") {
      reject(pot, "command_failed", "The controller did not confirm the pulse; no match is made.");
      continue;
    }
    const responders = item.responses.filter(response => selected.has(response.sensorKey) && response.detected)
      .sort((a, b) => b.deltaVwc - a.deltaVwc);
    if (!responders.length) {
      reject(pot, "no_response", "No selected sensor rose clearly. The hose may be outside the selected pots or disconnected. This valve remains unmatched.");
      continue;
    }
    // Keep watching matched sensors as a safety signal. A later valve raising
    // one contradicts the earlier match; never assign its weaker runner-up.
    const consumed = responders.filter(response => reserved.has(response.sensorKey));
    if (consumed.length) {
      for (const response of consumed) {
        const earlier = byValve.get(reserved.get(response.sensorKey)!);
        if (earlier) reject(earlier, "duplicate_claim", "Another valve also raised this sensor. Check both outlets before matching either.");
      }
      reject(pot, "duplicate_claim", "This pulse raised a sensor already matched to another valve. No remaining sensor is assigned by elimination.");
      continue;
    }
    const response = responders[0];
    const rowRivalDeltaVwc = Math.max(0, ...item.responses.filter(candidate => selected.has(candidate.sensorKey) && candidate.sensorKey !== response.sensorKey && isRival(candidate)).map(candidate => candidate.deltaVwc));
    if (responders.length > 1 || rowRivalDeltaVwc >= response.deltaVwc * config.ambiguousRatio) {
      reject(pot, "multiple_responses", "More than one sensor rose clearly. No match is made; all remain available for later pulses.");
      continue;
    }
    if (response.deltaVwc > config.overshootLimitVwc) {
      reject(pot, "overshoot", "The rise exceeds the diagnostic pulse limit. Check the outlet before matching it.");
      continue;
    }
    const referenceSensor = pots.find(candidate => candidate.sensorKey === response.sensorKey)?.reference === true;
    if ((pot.reference || referenceSensor) && response.sensorKey !== pot.sensorKey) {
      reject(pot, "reference_conflict", "The response contradicts a known-correct reference pot. No match is made.");
      continue;
    }
    const confidence = pairConfidence({ deltaVwc: response.deltaVwc, z: response.z, rowRivalDeltaVwc, columnRivalDeltaVwc: 0 }, config);
    if (confidence < config.reviewConfidence) {
      reject(pot, "low_confidence", "The response is too weak to match confidently. No sensor is removed from the remaining candidates.");
      continue;
    }
    reserved.set(response.sensorKey, valveKey);
    proposals.set(valveKey, {
      valveKey, pairingName: pot.pairingName, proposedSensorKey: response.sensorKey,
      recordedSensorKey: pot.sensorKey, matchesRecord: response.sensorKey === pot.sensorKey,
      confidence, status: "proposed", faults: [], deltaVwc: response.deltaVwc, z: response.z,
      pulseSeconds: item.requestedSeconds, rowRivalDeltaVwc, columnRivalDeltaVwc: 0, commandId: item.commandId,
    });
  }
  for (const pot of pots) if (!finalEvidence.has(pot.valveKey)) {
    reject(pot, "not_reached", "This valve has no complete pulse observation yet.");
  }
  return { proposals: [...proposals.values()], unresolved: [...unresolved.values()] };
}

/**
 * Selected sensors that no selected valve moved. Their water source is outside the
 * selection, disconnected, or too weak to measure; no pairing is proposed for them.
 */
export function findUnclaimedSensors(pots: readonly SelectedPot[], evidence: readonly PulseEvidence[], proposals?: readonly ProposedMapping[]): UnclaimedSensor[] {
  const finalEvidence = new Map<string, PulseEvidence>();
  evidence.forEach((item) => finalEvidence.set(item.valveKey, item));
  const claimed = new Set<string>(proposals?.map(proposal => proposal.proposedSensorKey));
  if (!proposals) finalEvidence.forEach((item) => item.responses.filter((response) => response.detected).forEach((response) => claimed.add(response.sensorKey)));
  const measured = new Set<string>();
  finalEvidence.forEach((item) => item.responses.forEach((response) => measured.add(response.sensorKey)));
  return pots
    .filter((pot) => measured.has(pot.sensorKey) && !claimed.has(pot.sensorKey))
    .map((pot) => ({
      sensorKey: pot.sensorKey,
      pairingName: pot.pairingName,
      detail: "No clear valve match was accepted for this sensor. Its source may be outside the selection or unresolved; it is not assigned by elimination.",
    }));
}
