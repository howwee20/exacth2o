import { algorithmVersion, configVersion, type AutocalConfig, type FaultCode, type RunResult } from "./engine";
import type { PresetId, SimWorld } from "./simulator";

// Proposal store. A saved run is a *proposed* topology kept for review. This
// module has no access to pairings, control commands, or the controller, so a
// saved proposal cannot become the active topology from here.

export const storeSchemaVersion = 1;
export const maxStoredRuns = 25;

export type StoredProposal = {
  valveId: string;
  sensorId: string;
  potLabel: string | null;
  confidence: number;
  status: "proposed" | "needs_review";
  faults: FaultCode[];
  evidence: {
    deltaVwc: number;
    pulseSeconds: number;
    lagSeconds: number | null;
    settleSeconds: number | null;
    conservativeGainPerSecond: number | null;
  };
  discoveredAt: string;
  lastVerifiedAt: string | null;
};

export type StoredRun = {
  schemaVersion: number;
  runId: string;
  projectId: string;
  experimentId: string;
  mode: "simulation";
  status: RunResult["status"];
  startedAt: string;
  endedAt: string;
  algorithmVersion: string;
  configVersion: string;
  simulator: { seed: number; presetId: PresetId; potCount: number; source: SimWorld["source"] };
  config: AutocalConfig;
  stepsExecuted: number;
  topologyVersion: string;
  // Always "proposed_not_applied" in this release: there is no apply path.
  proposalState: "proposed_not_applied";
  proposals: StoredProposal[];
  unresolvedValveIds: string[];
  excludedSensorIds: string[];
  faultCounts: Partial<Record<FaultCode, number>>;
};

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

function storageKey(projectId: string) {
  return `exacth2o.autocalibration.v${storeSchemaVersion}.${projectId || "default"}`;
}

export function loadRuns(storage: KeyValueStorage | null, projectId: string): StoredRun[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(projectId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredRun =>
      Boolean(item) && typeof item === "object"
      && (item as StoredRun).schemaVersion === storeSchemaVersion
      && (item as StoredRun).mode === "simulation"
      && typeof (item as StoredRun).runId === "string");
  } catch {
    return [];
  }
}

function writeRuns(storage: KeyValueStorage | null, projectId: string, runs: StoredRun[]) {
  if (!storage) return false;
  try {
    storage.setItem(storageKey(projectId), JSON.stringify(runs.slice(0, maxStoredRuns)));
    return true;
  } catch {
    return false;
  }
}

export function buildStoredRun(input: {
  runId: string;
  projectId: string;
  experimentId: string;
  world: SimWorld;
  config: AutocalConfig;
  result: RunResult;
  startedAt: Date;
  endedAt: Date;
  existingRuns: StoredRun[];
}): StoredRun {
  const { world, result, startedAt } = input;
  const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000).toISOString();
  const faultCounts: Partial<Record<FaultCode, number>> = {};
  result.faults.forEach((fault) => {
    faultCounts[fault.code] = (faultCounts[fault.code] ?? 0) + 1;
  });

  return {
    schemaVersion: storeSchemaVersion,
    runId: input.runId,
    projectId: input.projectId,
    experimentId: input.experimentId,
    mode: "simulation",
    status: result.status,
    startedAt: startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    algorithmVersion,
    configVersion,
    simulator: { seed: world.seed, presetId: world.presetId, potCount: world.pots.length, source: world.source },
    config: input.config,
    stepsExecuted: result.stepsExecuted,
    topologyVersion: `proposal-${input.existingRuns.length + 1}`,
    proposalState: "proposed_not_applied",
    proposals: result.proposals.map((pair) => ({
      valveId: world.valves[pair.valveIndex].id,
      sensorId: world.sensors[pair.sensorIndex].id,
      potLabel: world.pots[pair.sensorIndex].label,
      confidence: Math.round(pair.confidence * 1000) / 1000,
      status: pair.status,
      faults: pair.faults,
      evidence: {
        deltaVwc: Math.round(pair.evidence.deltaVwc * 100) / 100,
        pulseSeconds: pair.evidence.pulseSeconds,
        lagSeconds: pair.characterization?.lagSeconds ?? null,
        settleSeconds: pair.characterization?.settleSeconds ?? null,
        conservativeGainPerSecond: pair.characterization
          ? Math.round(pair.characterization.conservativeGainPerSecond * 1000) / 1000
          : null,
      },
      // Simulated clock mapped onto the wall-clock start of the run.
      discoveredAt: at(pair.discoveredAtSeconds),
      lastVerifiedAt: pair.lastVerifiedAtSeconds == null ? null : at(pair.lastVerifiedAtSeconds),
    })),
    unresolvedValveIds: result.unresolvedValves.map((item) => world.valves[item.valveIndex].id),
    excludedSensorIds: result.validations.filter((item) => !item.valid).map((item) => world.sensors[item.sensorIndex].id),
    faultCounts,
  };
}

export function saveRun(storage: KeyValueStorage | null, projectId: string, run: StoredRun) {
  const existing = loadRuns(storage, projectId).filter((item) => item.runId !== run.runId);
  return writeRuns(storage, projectId, [run, ...existing]);
}

export function deleteRun(storage: KeyValueStorage | null, projectId: string, runId: string) {
  return writeRuns(storage, projectId, loadRuns(storage, projectId).filter((item) => item.runId !== runId));
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
