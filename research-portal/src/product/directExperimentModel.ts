import { experimentDraftFromPortalExperiment, type ExperimentDraft } from '../experimentSpec';
import type { PortalExperiment } from '../experimentRegistry';
import type { PairingRow } from '../types';

export const TARGET_MIN = 0;
export const TARGET_MAX = 80;

export function targetDraft(experiment: PortalExperiment, pairings: PairingRow[], names: readonly string[], target: number): ExperimentDraft {
  if (!Number.isInteger(target) || target < TARGET_MIN || target > TARGET_MAX) throw new Error('Choose a whole-number target between 0% and 80%.');
  const selected = new Set(names);
  if (!selected.size || names.some(name => !experiment.pairingNames.includes(name))) throw new Error('Choose pots in this experiment.');
  const draft = experimentDraftFromPortalExperiment(experiment, pairings);
  // Baseline every control from the current inventory, so changing a subgroup cannot replay stale settings elsewhere.
  draft.assignments = draft.assignments.map(a => {
    const p = pairings.find(p => p.name === a.pairing_name);
    if (!p) throw new Error('Refresh the pot inventory before changing a target.');
    const enabled = p.wtc_percent_limit >= 0 && p.valve_open_time_ms > 0;
    if (selected.has(a.pairing_name) && !enabled) throw new Error('This pot has watering disabled. Enable watering in the experiment editor first.');
    return {...a, watering_enabled: enabled, target_vwc_percent: selected.has(a.pairing_name) ? target : enabled ? p.wtc_percent_limit : null,
      valve_open_seconds: enabled ? p.valve_open_time_ms / 1000 : null, measurement_interval_minutes: p.measurement_interval_ms / 60000};
  });
  return {...draft, controller_changes_requested: true};
}

export function commandOutcome(ids: string[], rows: {id: string; status: string}[]): 'pending' | 'applied' | 'failed' {
  const states = ids.map(id => rows.find(row => row.id === id)?.status);
  if (states.some(s => ['failed','canceled','expired','rejected'].includes(s ?? ''))) return 'failed';
  return ids.length > 0 && states.every(s => s === 'succeeded') ? 'applied' : 'pending';
}

/** Pots sharing one current target. Independent crop targets each get their own control. */
export type TargetGroup = { key: string; value: number; names: string[]; crops: string[]; treatments?: string[] };

export function targetGroups(experiment: PortalExperiment, pairings: readonly PairingRow[]): TargetGroup[] {
  const byValue = new Map<number, TargetGroup>();
  for (const name of experiment.pairingNames) {
    const pairing = pairings.find(p => p.name === name);
    if (!pairing || pairing.wtc_percent_limit < 0 || pairing.valve_open_time_ms <= 0) continue;
    const value = pairing.wtc_percent_limit;
    const group = byValue.get(value) ?? { key: `target-${value}`, value, names: [], crops: [], treatments: [] };
    group.names.push(name);
    const assignment = experiment.assignments?.find(a => a.pairing_name === name);
    const crop = assignment?.crop;
    const treatment = assignment?.treatment?.trim() ?? '';
    if (!group.treatments!.includes(treatment)) group.treatments!.push(treatment);
    if (crop && !group.crops.includes(crop)) group.crops.push(crop);
    byValue.set(value, group);
  }
  return [...byValue.values()].sort((a, b) => b.value - a.value);
}

/** Pill text: "25% target", with the crop only when several targets need telling apart. */
export function targetLabel(value: number, group: TargetGroup | null, distinguish: boolean) {
  if (!distinguish || !group) return `${value}% target`;
  const treatment = group.treatments?.length === 1 ? group.treatments[0] : '';
  const who = treatment ? capitalize(treatment) : group.crops.length ? group.crops.map(capitalize).join(' / ') : `${group.names.length} pots`;
  return `${who} ${value}%`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One whole-percent value from the gesture's start, never from the previous move. The value stays
 * within the visible axis, so the pill and its line never leave the pointer.
 */
export function dragTarget(startValue: number, startY: number, y: number, pixelsPerPercent: number, low = TARGET_MIN, high = TARGET_MAX) {
  if (!(pixelsPerPercent > 0)) return startValue;
  const raw = startValue + (startY - y) / pixelsPerPercent;
  return clampTarget(Math.max(Math.min(low, startValue), Math.min(Math.max(high, startValue), raw)));
}

export function clampTarget(value: number) {
  return Math.max(TARGET_MIN, Math.min(TARGET_MAX, Math.round(value)));
}

/** "Pots 101–108, 117" from pot numbers, for stating exactly what a change touches. */
export function potRanges(numbers: readonly number[]) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end > i ? `${sorted[i]}–${sorted[end]}` : `${sorted[i]}`);
    i = end;
  }
  return parts.length ? `${sorted.length === 1 ? 'Pot' : 'Pots'} ${parts.join(', ')}` : 'No pots';
}

/** Spread pills that would overlap: same height band → shift right. Returns x offsets by key. */
export function pillOffsets(items: readonly { key: string; y: number; width: number }[], minGap = 30) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const offsets = new Map<string, number>();
  const placed: { y: number; x: number; width: number }[] = [];
  for (const item of sorted) {
    let x = 0;
    for (const other of placed) {
      if (Math.abs(other.y - item.y) < minGap) x = Math.max(x, other.x + other.width + 10);
    }
    placed.push({ y: item.y, x, width: item.width });
    offsets.set(item.key, x);
  }
  return offsets;
}
