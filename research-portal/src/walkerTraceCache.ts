import { loadWalkerExperiment } from "./walkerExperimentClient";
import { loadWalkerLiveSnapshot } from "./walkerObservationClient";
import type { WalkerPortalExperiment } from "./walkerExperiments";
import type { WalkerLiveSnapshot } from "./walkerObservation";

// Small, memory-only lookahead for the signed-in user. Polling still fetches fresh data;
// this only bridges the click from the home tile to the trace screen.
const maxAgeMs = 30_000;
let owner: string | null = null;
let generation = 0;
const records = new Map<string, { value: WalkerPortalExperiment; at: number }>();
const snapshots = new Map<boolean, { value?: WalkerLiveSnapshot; at: number; pending?: Promise<WalkerLiveSnapshot> }>();

export function clearWalkerTraceCache() {
  owner = null;
  generation++;
  records.clear();
  snapshots.clear();
}
function ensureOwner(userId: string) {
  if (owner !== userId) { clearWalkerTraceCache(); owner = userId; }
}
export function rememberWalkerExperiments(userId: string | undefined, experiments: WalkerPortalExperiment[]) {
  if (!userId) return;
  ensureOwner(userId);
  records.clear();
  for (const value of experiments.slice(-32)) records.set(value.id, { value, at: Date.now() });
}
export function cachedWalkerExperiment(userId: string | undefined, id: string) {
  if (!userId) return null;
  ensureOwner(userId);
  const record = records.get(id);
  return record && Date.now() - record.at < maxAgeMs ? record.value : null;
}
export async function loadWalkerTraceExperiment(userId: string | undefined, id: string) {
  const held = cachedWalkerExperiment(userId, id);
  if (held) return held;
  const requestGeneration = generation;
  const value = await loadWalkerExperiment(id);
  if (userId && owner === userId && generation === requestGeneration) {
    records.set(id, { value, at: Date.now() });
    if (records.size > 32) records.delete(records.keys().next().value!);
  }
  return value;
}
export function loadWalkerTraceSnapshot(userId: string | undefined, lastRecorded = false): Promise<WalkerLiveSnapshot> {
  if (!userId) return loadWalkerLiveSnapshot(lastRecorded);
  ensureOwner(userId);
  const held = snapshots.get(lastRecorded);
  if (held?.pending) return held.pending;
  if (held?.value && Date.now() - held.at < maxAgeMs) return Promise.resolve(held.value);
  const requestGeneration = generation;
  const pending = loadWalkerLiveSnapshot(lastRecorded).then(value => {
    if (generation === requestGeneration) snapshots.set(lastRecorded, { value, at: Date.now() });
    return value;
  }).catch(error => {
    if (generation === requestGeneration) snapshots.delete(lastRecorded);
    throw error;
  });
  snapshots.set(lastRecorded, { at: 0, pending });
  return pending;
}
