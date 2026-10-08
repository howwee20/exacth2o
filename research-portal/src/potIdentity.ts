import { experimentIsCompleted } from "./experimentMeasurement";
import type { PortalExperiment, PortalExperimentAssignment } from "./experimentRegistry";
import type { PairingRow } from "./types";

/**
 * Canonical pot identity inside one project: the controller pairing name ("Zone2-Pot17"), unique
 * per device. A research pot UUID (physical anchor) resolves to the pairing it is bound to.
 */

export type PotMatch = {
  pairing: PairingRow;
  experiments: PortalExperiment[];
  /** The experiment that currently uses the pot, if any (active before completed, newest first). */
  current: PortalExperiment | null;
  assignment: PortalExperimentAssignment | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResearchPotId(value: string) {
  return uuidPattern.test(value.trim());
}

export function experimentsForPot(name: string, experiments: readonly PortalExperiment[], nowMs = Date.now()) {
  const using = experiments.filter((experiment) => experiment.pairingNames.includes(name));
  return using.sort((a, b) => {
    const aDone = experimentIsCompleted(a, nowMs) ? 1 : 0;
    const bDone = experimentIsCompleted(b, nowMs) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "") || a.name.localeCompare(b.name);
  });
}

export function resolvePot(
  key: string,
  pairings: readonly PairingRow[],
  experiments: readonly PortalExperiment[],
  options: { boundPairingName?: string | null; preferExperimentId?: string | null; nowMs?: number } = {},
): PotMatch | null {
  const trimmed = key.trim();
  const name = isResearchPotId(trimmed) ? options.boundPairingName ?? null : trimmed;
  if (!name) return null;
  const pairing = pairings.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!pairing) return null;
  const using = experimentsForPot(pairing.name, experiments, options.nowMs);
  const current = (options.preferExperimentId ? using.find((experiment) => experiment.id === options.preferExperimentId) : null) ?? using[0] ?? null;
  const assignment = current?.assignments?.find((item) => item.pairing_name === pairing.name) ?? null;
  return { pairing, experiments: using, current, assignment };
}

export type PotSearchResult = { pairing: PairingRow; experiment: PortalExperiment | null; score: number };

/** Pot lookup by number ("17"), pairing name ("zone2-pot17") or experiment name. */
export function searchPots(query: string, pairings: readonly PairingRow[], experiments: readonly PortalExperiment[], nowMs = Date.now()): PotSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const number = /^\d+$/.test(q) ? Number(q) : null;
  const results: PotSearchResult[] = [];
  for (const pairing of pairings) {
    const experiment = experimentsForPot(pairing.name, experiments, nowMs)[0] ?? null;
    let score = 0;
    if (number != null && pairing.pot_number === number) score = 100;
    else if (pairing.name.toLowerCase() === q) score = 95;
    else if (number != null && String(pairing.pot_number).startsWith(q)) score = 50 - String(pairing.pot_number).length;
    else if (pairing.name.toLowerCase().includes(q)) score = 40;
    else if (experiment && experiment.name.toLowerCase().includes(q)) score = 20;
    if (score > 0) results.push({ pairing, experiment, score });
  }
  return results.sort((a, b) => b.score - a.score || a.pairing.zone - b.pairing.zone || a.pairing.pot_number - b.pairing.pot_number).slice(0, 30);
}
